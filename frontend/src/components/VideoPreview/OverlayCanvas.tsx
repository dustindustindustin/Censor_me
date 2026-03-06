/**
 * OverlayCanvas — interactive canvas overlay on the video element.
 *
 * Responsibilities:
 * 1. Draw redaction region previews for all active events (colour-coded by status)
 * 2. Draw test-frame result boxes in cyan when a frame test is active
 * 3. Draw resize handles on the selected event; allow drag-to-resize
 * 4. Allow click-drag box drawing in draw mode; create a new manual RedactionEvent
 *
 * Coordinate spaces:
 * - RedactionEvent keyframe bboxes are stored in **source video** pixel space.
 * - The <video> element plays the proxy, so video.videoWidth is the proxy width.
 * - We correct for source→proxy scaling via sourceWidth/sourceHeight props.
 * - All screen rendering: multiply by scaleX/scaleY (proxy → screen).
 */

import { useEffect, useRef } from 'react'
import { addEventToProject, trackManualEvent, updateEventKeyframes } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import type { BoundingBox, Keyframe, RedactionEvent } from '../../types'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  containerRef: React.RefObject<HTMLDivElement>
  currentTimeMs: number
  showRedactions: boolean
  projectId: string
  sourceWidth: number   // native source video width (for coordinate correction)
  sourceHeight: number  // native source video height
}

// Handle size in screen pixels
const HANDLE_SIZE = 8
const HANDLE_HIT = 12  // generous hit target

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

function getHandlePoints(rx: number, ry: number, rw: number, rh: number): Record<HandleId, [number, number]> {
  return {
    nw: [rx,           ry],
    n:  [rx + rw / 2,  ry],
    ne: [rx + rw,      ry],
    e:  [rx + rw,      ry + rh / 2],
    se: [rx + rw,      ry + rh],
    s:  [rx + rw / 2,  ry + rh],
    sw: [rx,           ry + rh],
    w:  [rx,           ry + rh / 2],
  }
}

function hitHandle(mx: number, my: number, points: Record<HandleId, [number, number]>): HandleId | null {
  for (const [id, [hx, hy]] of Object.entries(points) as [HandleId, [number, number]][]) {
    if (Math.abs(mx - hx) <= HANDLE_HIT / 2 && Math.abs(my - hy) <= HANDLE_HIT / 2) return id
  }
  return null
}

function applyHandleDrag(
  orig: BoundingBox,
  handle: HandleId,
  dx: number, dy: number,
): BoundingBox {
  let { x, y, w, h } = orig
  if (handle.includes('w')) { x += dx; w -= dx }
  if (handle.includes('e')) { w += dx }
  if (handle.includes('n')) { y += dy; h -= dy }
  if (handle.includes('s')) { h += dy }
  // Prevent inversion
  if (w < 10) w = 10
  if (h < 10) h = 10
  return { x, y, w, h }
}

export function OverlayCanvas({
  videoRef,
  containerRef,
  currentTimeMs,
  showRedactions,
  projectId,
  sourceWidth,
  sourceHeight,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const {
    events,
    selectedEventId,
    selectEvent,
    addEvent,
    updateEvent,
    testFrameOverlay,
    drawingMode,
    setDrawingMode,
  } = useProjectStore((s) => ({
    events: s.events,
    selectedEventId: s.selectedEventId,
    selectEvent: s.selectEvent,
    addEvent: s.addEvent,
    updateEvent: s.updateEvent,
    testFrameOverlay: s.testFrameOverlay,
    drawingMode: s.drawingMode,
    setDrawingMode: s.setDrawingMode,
  }))

  // Mouse interaction state (refs to avoid triggering re-renders on every frame)
  const drawStart = useRef<{ nx: number; ny: number } | null>(null)
  const drawCurrent = useRef<{ nx: number; ny: number } | null>(null)
  const resizeState = useRef<{
    handle: HandleId
    event: RedactionEvent
    origBbox: BoundingBox
    startScreen: { x: number; y: number }
  } | null>(null)

  // ── Scale helpers ──────────────────────────────────────────────────────────

  function getScales() {
    const video = videoRef.current
    const container = containerRef.current
    if (!video || !container || video.videoWidth === 0) return null

    const videoRect = video.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()

    // proxy → screen
    const scaleX = videoRect.width / video.videoWidth
    const scaleY = videoRect.height / video.videoHeight

    // source → proxy (correct for source resolution stored in keyframes)
    const srcToProxyX = sourceWidth > 0 ? video.videoWidth / sourceWidth : 1
    const srcToProxyY = sourceHeight > 0 ? video.videoHeight / sourceHeight : 1

    const offsetX = videoRect.left - containerRect.left
    const offsetY = videoRect.top - containerRect.top

    return { scaleX, scaleY, srcToProxyX, srcToProxyY, offsetX, offsetY, videoRect }
  }

  /** Convert source-pixel bbox to screen rect */
  function srcBboxToScreen(bbox: BoundingBox, s: NonNullable<ReturnType<typeof getScales>>) {
    return {
      rx: s.offsetX + bbox.x * s.srcToProxyX * s.scaleX,
      ry: s.offsetY + bbox.y * s.srcToProxyY * s.scaleY,
      rw: bbox.w * s.srcToProxyX * s.scaleX,
      rh: bbox.h * s.srcToProxyY * s.scaleY,
    }
  }

  /** Convert screen coords to source pixel coords */
  function screenToSrc(sx: number, sy: number, s: NonNullable<ReturnType<typeof getScales>>) {
    return {
      nx: (sx - s.offsetX) / s.scaleX / s.srcToProxyX,
      ny: (sy - s.offsetY) / s.scaleY / s.srcToProxyY,
    }
  }

  // ── Draw loop ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    const container = containerRef.current
    if (!canvas || !video || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const s = getScales()
    const containerRect = container.getBoundingClientRect()
    canvas.width = containerRect.width
    canvas.height = containerRect.height
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (!s || video.videoWidth === 0) return

    // ── Redaction event boxes ──
    if (showRedactions) {
      const activeEvents = events.filter((event) => {
        if (event.status === 'rejected') return false
        return event.time_ranges.some(
          (r) => currentTimeMs >= r.start_ms && currentTimeMs <= r.end_ms
        )
      })

      for (const event of activeEvents) {
        const bbox = interpolateBbox(event, currentTimeMs)
        if (!bbox) continue

        const { rx, ry, rw, rh } = srcBboxToScreen(bbox, s)
        const isSelected = event.event_id === selectedEventId
        const isPending = event.status === 'pending'

        ctx.fillStyle = isSelected
          ? 'rgba(91, 124, 246, 0.25)'
          : isPending
          ? 'rgba(240, 160, 80, 0.2)'
          : 'rgba(61, 202, 126, 0.2)'
        ctx.fillRect(rx, ry, rw, rh)

        ctx.strokeStyle = isSelected ? '#5b7cf6' : isPending ? '#f0a050' : '#3dca7e'
        ctx.lineWidth = isSelected ? 2 : 1
        ctx.setLineDash(isPending ? [4, 2] : [])
        ctx.strokeRect(rx, ry, rw, rh)
        ctx.setLineDash([])

        ctx.font = '10px system-ui'
        ctx.fillStyle = ctx.strokeStyle
        ctx.fillText(event.pii_type.toUpperCase(), rx + 3, ry - 3)

        // Resize handles for the selected event
        if (isSelected) {
          const handles = getHandlePoints(rx, ry, rw, rh)
          ctx.fillStyle = '#5b7cf6'
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1
          for (const [hx, hy] of Object.values(handles)) {
            ctx.fillRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
            ctx.strokeRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
          }
        }
      }
    }

    // ── Test frame overlay (cyan) ──
    if (testFrameOverlay) {
      for (const box of testFrameOverlay) {
        const [bx, by, bw, bh] = box.bbox
        const { rx, ry, rw, rh } = srcBboxToScreen({ x: bx, y: by, w: bw, h: bh }, s)
        ctx.fillStyle = 'rgba(0, 220, 255, 0.18)'
        ctx.fillRect(rx, ry, rw, rh)
        ctx.strokeStyle = '#00dcff'
        ctx.lineWidth = 2
        ctx.setLineDash([])
        ctx.strokeRect(rx, ry, rw, rh)
        ctx.font = '10px system-ui'
        ctx.fillStyle = '#00dcff'
        ctx.fillText(box.pii_type.toUpperCase(), rx + 3, ry - 3)
      }
    }

    // ── Live draw rect ──
    if (drawingMode && drawStart.current && drawCurrent.current) {
      const x = Math.min(drawStart.current.nx, drawCurrent.current.nx)
      const y = Math.min(drawStart.current.ny, drawCurrent.current.ny)
      const w = Math.abs(drawCurrent.current.nx - drawStart.current.nx)
      const h = Math.abs(drawCurrent.current.ny - drawStart.current.ny)
      if (w > 4 && h > 4) {
        const { rx, ry, rw, rh } = srcBboxToScreen({ x, y, w, h }, s)
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.setLineDash([6, 3])
        ctx.strokeRect(rx, ry, rw, rh)
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(255,255,255,0.08)'
        ctx.fillRect(rx, ry, rw, rh)
      }
    }
  }, [currentTimeMs, events, selectedEventId, showRedactions, testFrameOverlay, drawingMode])

  // ── Mouse event handlers ───────────────────────────────────────────────────

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = getScales()
    if (!s) return
    const canvas = canvasRef.current!
    const canvasRect = canvas.getBoundingClientRect()
    const mx = e.clientX - canvasRect.left
    const my = e.clientY - canvasRect.top

    // Priority 1: check resize handles on selected event
    if (selectedEventId) {
      const selEvent = events.find((ev) => ev.event_id === selectedEventId)
      if (selEvent) {
        const bbox = interpolateBbox(selEvent, currentTimeMs)
        if (bbox) {
          const { rx, ry, rw, rh } = srcBboxToScreen(bbox, s)
          const handles = getHandlePoints(rx, ry, rw, rh)
          const hit = hitHandle(mx, my, handles)
          if (hit) {
            resizeState.current = {
              handle: hit,
              event: selEvent,
              origBbox: { ...bbox },
              startScreen: { x: mx, y: my },
            }
            return
          }
        }
      }
    }

    // Priority 2: click inside an active event box to select it
    for (const event of [...events].reverse()) {
      if (event.status === 'rejected') continue
      const active = event.time_ranges.some(r => currentTimeMs >= r.start_ms && currentTimeMs <= r.end_ms)
      if (!active) continue
      const bbox = interpolateBbox(event, currentTimeMs)
      if (!bbox) continue
      const { rx, ry, rw, rh } = srcBboxToScreen(bbox, s)
      if (mx >= rx && mx <= rx + rw && my >= ry && my <= ry + rh) {
        selectEvent(event.event_id)
        return
      }
    }

    // Priority 3: draw mode
    if (drawingMode) {
      const { nx, ny } = screenToSrc(mx, my, s)
      drawStart.current = { nx, ny }
      drawCurrent.current = { nx, ny }
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = getScales()
    if (!s) return
    const canvas = canvasRef.current!
    const canvasRect = canvas.getBoundingClientRect()
    const mx = e.clientX - canvasRect.left
    const my = e.clientY - canvasRect.top

    if (drawingMode && drawStart.current) {
      const { nx, ny } = screenToSrc(mx, my, s)
      drawCurrent.current = { nx, ny }
      // Draw the live drag rect directly on the canvas
      const ctx = canvas.getContext('2d')
      if (ctx) {
        const containerRect = containerRef.current!.getBoundingClientRect()
        ctx.clearRect(0, 0, containerRect.width, containerRect.height)
        const x = Math.min(drawStart.current.nx, nx)
        const y = Math.min(drawStart.current.ny, ny)
        const w = Math.abs(nx - drawStart.current.nx)
        const h = Math.abs(ny - drawStart.current.ny)
        if (w > 4 && h > 4) {
          const { rx, ry, rw, rh } = srcBboxToScreen({ x, y, w, h }, s)
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2
          ctx.setLineDash([6, 3])
          ctx.strokeRect(rx, ry, rw, rh)
          ctx.setLineDash([])
          ctx.fillStyle = 'rgba(255,255,255,0.08)'
          ctx.fillRect(rx, ry, rw, rh)
        }
      }
    }
  }

  const handleMouseUp = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = getScales()
    if (!s) return
    const canvas = canvasRef.current!
    const canvasRect = canvas.getBoundingClientRect()
    const mx = e.clientX - canvasRect.left
    const my = e.clientY - canvasRect.top

    // Finish resize
    if (resizeState.current) {
      const { handle, event, origBbox, startScreen } = resizeState.current
      resizeState.current = null

      const dxScreen = mx - startScreen.x
      const dyScreen = my - startScreen.y
      const dxSrc = dxScreen / s.scaleX / s.srcToProxyX
      const dySrc = dyScreen / s.scaleY / s.srcToProxyY

      const newBbox = applyHandleDrag(origBbox, handle, dxSrc, dySrc)

      // Find nearest keyframe and update it
      const kfs = event.keyframes
      let nearest = kfs[0]
      let minDiff = Infinity
      for (const kf of kfs) {
        const diff = Math.abs(kf.time_ms - currentTimeMs)
        if (diff < minDiff) { minDiff = diff; nearest = kf }
      }

      let updatedKfs: Keyframe[]
      if (nearest && nearest.time_ms === currentTimeMs) {
        updatedKfs = kfs.map((kf) =>
          kf.time_ms === currentTimeMs ? { ...kf, bbox: newBbox } : kf
        )
      } else {
        // Insert new keyframe at current time with resized bbox
        const newKf: Keyframe = { time_ms: currentTimeMs, bbox: newBbox }
        updatedKfs = [...kfs, newKf].sort((a, b) => a.time_ms - b.time_ms)
      }

      const updated = { ...event, keyframes: updatedKfs }
      updateEvent(updated)
      try {
        await updateEventKeyframes(projectId, event.event_id, updatedKfs)
      } catch (err) {
        console.error('Failed to save resized keyframe:', err)
      }
      return
    }

    // Finish draw
    if (drawingMode && drawStart.current && drawCurrent.current) {
      const x = Math.min(drawStart.current.nx, drawCurrent.current.nx)
      const y = Math.min(drawStart.current.ny, drawCurrent.current.ny)
      const w = Math.abs(drawCurrent.current.nx - drawStart.current.nx)
      const h = Math.abs(drawCurrent.current.ny - drawStart.current.ny)

      drawStart.current = null
      drawCurrent.current = null

      if (w >= 10 && h >= 10) {
        const newEvent: RedactionEvent = {
          event_id: crypto.randomUUID(),
          source: 'auto',
          pii_type: 'manual',
          confidence: 1.0,
          extracted_text: null,
          time_ranges: [{ start_ms: currentTimeMs, end_ms: currentTimeMs }],
          keyframes: [{ time_ms: currentTimeMs, bbox: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } }],
          tracking_method: 'none',
          redaction_style: { type: 'blur', strength: 15, color: '#000000' },
          status: 'accepted',
        }

        try {
          const saved = await addEventToProject(projectId, newEvent)
          addEvent(saved)
          setDrawingMode(false)

          // Run CSRT tracking forward from the drawn keyframe
          try {
            const tracked = await trackManualEvent(projectId, saved.event_id)
            updateEvent(tracked)
          } catch (err) {
            console.warn('Tracking failed for manual box (single-frame redaction kept):', err)
          }
        } catch (err) {
          console.error('Failed to save manual box:', err)
        }
      }
    }
  }

  const needsPointerEvents = drawingMode || selectedEventId !== null

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{
        position: 'absolute',
        pointerEvents: needsPointerEvents ? 'auto' : 'none',
        zIndex: 5,
        cursor: drawingMode ? 'crosshair' : resizeState.current ? 'nwse-resize' : 'default',
      }}
    />
  )
}

/**
 * Linearly interpolate a bounding box at a given time using keyframe data.
 */
function interpolateBbox(event: RedactionEvent, timeMs: number): BoundingBox | null {
  const kfs = event.keyframes
  if (!kfs || kfs.length === 0) return null
  if (kfs.length === 1) return kfs[0].bbox

  let before: Keyframe | null = null
  let after: Keyframe | null = null

  for (const kf of kfs) {
    if (kf.time_ms <= timeMs) {
      if (!before || kf.time_ms > before.time_ms) before = kf
    } else {
      if (!after || kf.time_ms < after.time_ms) after = kf
    }
  }

  if (before && !after) return before.bbox
  if (after && !before) return after.bbox
  if (!before || !after) return null

  const t = (timeMs - before.time_ms) / (after.time_ms - before.time_ms)
  return {
    x: Math.round(before.bbox.x + (after.bbox.x - before.bbox.x) * t),
    y: Math.round(before.bbox.y + (after.bbox.y - before.bbox.y) * t),
    w: Math.round(before.bbox.w + (after.bbox.w - before.bbox.w) * t),
    h: Math.round(before.bbox.h + (after.bbox.h - before.bbox.h) * t),
  }
}

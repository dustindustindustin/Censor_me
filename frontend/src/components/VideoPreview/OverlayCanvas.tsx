/**
 * OverlayCanvas — interactive canvas overlay on the video element.
 *
 * Responsibilities:
 * 1. Draw redaction region previews for all active events (colour-coded by status)
 * 2. Draw test-frame result boxes in cyan when a frame test is active
 * 3. Draw resize handles on the selected event; allow drag-to-resize
 * 4. Allow drag-to-move on any selected event box (not on a handle)
 * 5. Allow click-drag box drawing in draw mode; create a new manual RedactionEvent
 * 6. Render actual blur/pixelate/solid_box effects when the video is paused
 *    and livePreviewMode is enabled
 *
 * Coordinate spaces:
 * - RedactionEvent keyframe bboxes are stored in **source video** pixel space.
 * - The <video> element plays the proxy, so video.videoWidth is the proxy width.
 * - We correct for source→proxy scaling via sourceWidth/sourceHeight props.
 * - All screen rendering: multiply by scaleX/scaleY (proxy → screen).
 */

import { useEffect, useRef, useState } from 'react'
import { addEventToProject, trackManualEvent, updateEventKeyframes } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import { theme } from '../../styles/theme'
import type { BoundingBox, Keyframe, RedactionEvent } from '../../types'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  containerRef: React.RefObject<HTMLDivElement>
  currentTimeMs: number
  showRedactions: boolean
  projectId: string
  sourceWidth: number   // native source video width (for coordinate correction)
  sourceHeight: number  // native source video height
  isPaused: boolean     // true when the video is paused (enables live style preview)
}

// Handle size in screen pixels
const HANDLE_SIZE = 8
const HANDLE_HIT = 12  // generous hit target

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLE_CURSORS: Record<HandleId, string> = {
  nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize',
  e: 'e-resize', se: 'se-resize', s: 's-resize',
  sw: 'sw-resize', w: 'w-resize',
}

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

// Match backend _BBOX_PAD_PCT and _TEMPORAL_PAD_MS for WYSIWYG preview
const BBOX_PAD_PCT = 0.15
const TEMPORAL_PAD_MS = 750

function upsertKeyframe(keyframes: Keyframe[], timeMs: number, newBbox: BoundingBox): Keyframe[] {
  const existing = keyframes.find((kf) => kf.time_ms === timeMs)
  if (existing) {
    return keyframes.map((kf) => kf.time_ms === timeMs ? { ...kf, bbox: newBbox } : kf)
  }
  return [...keyframes, { time_ms: timeMs, bbox: newBbox }].sort((a, b) => a.time_ms - b.time_ms)
}

function padBbox(bbox: BoundingBox, srcW: number, srcH: number, padPct = BBOX_PAD_PCT): BoundingBox {
  const dx = Math.round(bbox.w * padPct)
  const dy = Math.round(bbox.h * padPct)
  const x = Math.max(0, bbox.x - dx)
  const y = Math.max(0, bbox.y - dy)
  const w = Math.min(srcW - x, bbox.w + 2 * dx)
  const h = Math.min(srcH - y, bbox.h + 2 * dy)
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
  isPaused,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const {
    project,
    events,
    selectedEventId,
    selectEvent,
    addEvent,
    updateEvent,
    testFrameOverlay,
    scanPreviewFrame,
    drawingMode,
    setDrawingMode,
    polygonDrawMode,
    setPolygonDrawMode,
    staticDrawMode,
    livePreviewMode,
    addNotification,
    pushUndo,
    zoomLevel,
  } = useProjectStore((s) => ({
    project: s.project,
    events: s.events,
    selectedEventId: s.selectedEventId,
    selectEvent: s.selectEvent,
    addEvent: s.addEvent,
    updateEvent: s.updateEvent,
    testFrameOverlay: s.testFrameOverlay,
    scanPreviewFrame: s.scanPreviewFrame,
    drawingMode: s.drawingMode,
    setDrawingMode: s.setDrawingMode,
    staticDrawMode: s.staticDrawMode,
    polygonDrawMode: s.polygonDrawMode,
    setPolygonDrawMode: s.setPolygonDrawMode,
    livePreviewMode: s.livePreviewMode,
    addNotification: s.addNotification,
    pushUndo: s.pushUndo,
    zoomLevel: s.zoomLevel,
  }))

  // Mouse interaction state (refs to avoid triggering re-renders on every frame)
  const drawStart = useRef<{ nx: number; ny: number } | null>(null)
  const drawCurrent = useRef<{ nx: number; ny: number } | null>(null)
  // Polygon drawing state: accumulated vertices in source-pixel coords
  const polygonPoints = useRef<{ nx: number; ny: number }[]>([])
  const polygonCurrent = useRef<{ nx: number; ny: number } | null>(null)
  const resizeState = useRef<{
    handle: HandleId
    event: RedactionEvent
    origBbox: BoundingBox
    startScreen: { x: number; y: number }
  } | null>(null)
  const moveState = useRef<{
    event: RedactionEvent
    startMouseSrc: { x: number; y: number }
    origBbox: BoundingBox
  } | null>(null)

  const [cursorStyle, setCursorStyle] = useState<string>('default')

  // Offscreen canvas for pixelate effect (reused across frames)
  const pixelateCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // Ref for rAF-based draw loop
  const rafIdRef = useRef<number>(0)

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

  // ── Draw loop (requestAnimationFrame-based) ─────────────────────────────────

  // Store latest props in refs so the rAF callback always sees current values
  const propsRef = useRef({ currentTimeMs, events, selectedEventId, showRedactions, testFrameOverlay, scanPreviewFrame, drawingMode, polygonDrawMode, isPaused, livePreviewMode })
  propsRef.current = { currentTimeMs, events, selectedEventId, showRedactions, testFrameOverlay, scanPreviewFrame, drawingMode, polygonDrawMode, isPaused, livePreviewMode }

  useEffect(() => {
    let cancelled = false

    function draw() {
      if (cancelled) return

      const canvas = canvasRef.current
      const video = videoRef.current
      const container = containerRef.current
      if (!canvas || !video || !container) {
        rafIdRef.current = requestAnimationFrame(draw)
        return
      }

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        rafIdRef.current = requestAnimationFrame(draw)
        return
      }

      const { events, selectedEventId, showRedactions, testFrameOverlay, scanPreviewFrame, drawingMode, polygonDrawMode, isPaused, livePreviewMode } = propsRef.current
      // Read currentTime directly from the video element each rAF frame for frame-accurate
      // overlay positioning. The timeupdate event only fires ~4-5x/sec, which causes box
      // positions to snap discretely. Falling back to propsRef when paused preserves correct
      // time for mouse interactions (resize, move, draw) that fire synchronously on events.
      const currentTimeMs = (video && !video.paused)
        ? Math.floor(video.currentTime * 1000)
        : propsRef.current.currentTimeMs

      const s = getScales()
      const containerRect = container.getBoundingClientRect()
      if (canvas.width !== Math.round(containerRect.width)) canvas.width = Math.round(containerRect.width)
      if (canvas.height !== Math.round(containerRect.height)) canvas.height = Math.round(containerRect.height)
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (s && video.videoWidth !== 0) {
        // ── Redaction event boxes ──
        if (showRedactions) {
          const activeEvents = events.filter((event) => {
            if (event.status === 'rejected') return false
            return event.time_ranges.some(
              (r) => currentTimeMs >= r.start_ms - TEMPORAL_PAD_MS && currentTimeMs <= r.end_ms + TEMPORAL_PAD_MS
            )
          })

          // Live style preview: render actual blur/pixelate/solid_box effects when paused
          if (isPaused && livePreviewMode && activeEvents.length > 0) {
            for (const event of activeEvents) {
              const rawBbox = interpolateBbox(event, currentTimeMs)
              if (!rawBbox) continue
              const bbox = padBbox(rawBbox, sourceWidth, sourceHeight)

              const { rx, ry, rw, rh } = srcBboxToScreen(bbox, s)
              // Skip boxes fully outside the visible canvas area (panned out of view)
              if (rx + rw < 0 || ry + rh < 0 || rx > canvas.width || ry > canvas.height) continue

              // Source rect in proxy pixel coords (for drawImage)
              const vx = bbox.x * s.srcToProxyX
              const vy = bbox.y * s.srcToProxyY
              const vw = bbox.w * s.srcToProxyX
              const vh = bbox.h * s.srcToProxyY

              const styleType = event.redaction_style.type
              const strength = event.redaction_style.strength

              if (styleType === 'blur') {
                ctx.save()
                ctx.filter = `blur(${Math.max(2, strength / 2)}px)`
                ctx.drawImage(video, vx, vy, vw, vh, rx, ry, rw, rh)
                ctx.restore()
              } else if (styleType === 'pixelate') {
                const blockSize = Math.max(1, strength)
                const blockW = Math.max(1, Math.round(vw / blockSize))
                const blockH = Math.max(1, Math.round(vh / blockSize))
                if (!pixelateCanvasRef.current) {
                  pixelateCanvasRef.current = document.createElement('canvas')
                }
                const off = pixelateCanvasRef.current
                off.width = blockW
                off.height = blockH
                const offCtx = off.getContext('2d')
                if (offCtx) {
                  offCtx.drawImage(video, vx, vy, vw, vh, 0, 0, blockW, blockH)
                  ctx.imageSmoothingEnabled = false
                  ctx.drawImage(off, 0, 0, blockW, blockH, rx, ry, rw, rh)
                  ctx.imageSmoothingEnabled = true
                }
              } else {
                // solid_box
                ctx.fillStyle = event.redaction_style.color || '#000000'
                ctx.fillRect(rx, ry, rw, rh)
              }

              // Draw resize handles on top so user can still interact
              if (event.event_id === selectedEventId) {
                const handles = getHandlePoints(rx, ry, rw, rh)
                ctx.fillStyle = theme.accent
                ctx.strokeStyle = theme.white
                ctx.lineWidth = 1
                for (const [hx, hy] of Object.values(handles)) {
                  ctx.fillRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
                  ctx.strokeRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
                }
              }
            }
          } else {
            // Placeholder colored boxes — color-coded by source and status:
            //   selected          → accent (pink) outline
            //   auto + pending    → amber outline  (dashed)
            //   auto + accepted   → green outline
            //   manual (any)      → orange outline
            for (const event of activeEvents) {
              const rawBbox = interpolateBbox(event, currentTimeMs)
              if (!rawBbox) continue
              const bbox = padBbox(rawBbox, sourceWidth, sourceHeight)

              const { rx, ry, rw, rh } = srcBboxToScreen(bbox, s)
              // Skip boxes fully outside the visible canvas area (panned out of view)
              if (rx + rw < 0 || ry + rh < 0 || rx > canvas.width || ry > canvas.height) continue
              const isSelected = event.event_id === selectedEventId
              const isManual = event.source === 'manual'
              const isPending = event.status === 'pending'

              let strokeColor: string
              let fillColor: string
              if (isSelected) {
                strokeColor = theme.accent
                fillColor = theme.accentFill
              } else if (isManual) {
                strokeColor = theme.manual
                fillColor = theme.manualFill
              } else if (isPending) {
                strokeColor = theme.pending
                fillColor = theme.pendingFill
              } else {
                strokeColor = theme.accept
                fillColor = theme.acceptFill
              }

              ctx.fillStyle = fillColor
              ctx.fillRect(rx, ry, rw, rh)

              ctx.strokeStyle = strokeColor
              ctx.lineWidth = isSelected ? 2 : 1
              ctx.setLineDash(isPending && !isSelected ? [4, 2] : [])
              ctx.strokeRect(rx, ry, rw, rh)
              ctx.setLineDash([])

              ctx.save()
              ctx.beginPath()
              ctx.rect(0, 0, canvas.width, canvas.height)
              ctx.clip()
              ctx.font = `10px ${theme.fontFamily}`
              ctx.fillStyle = strokeColor
              ctx.fillText(event.pii_type.toUpperCase(), rx + 3, ry - 3)
              ctx.restore()

              // Resize handles for the selected event
              if (isSelected) {
                const handles = getHandlePoints(rx, ry, rw, rh)
                ctx.fillStyle = theme.accent
                ctx.strokeStyle = theme.white
                ctx.lineWidth = 1
                for (const [hx, hy] of Object.values(handles)) {
                  ctx.fillRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
                  ctx.strokeRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
                }
              }
            }
          }
        }

        // ── Test frame overlay (cyan) ──
        if (testFrameOverlay) {
          for (const box of testFrameOverlay) {
            const [bx, by, bw, bh] = box.bbox
            const { rx, ry, rw, rh } = srcBboxToScreen({ x: bx, y: by, w: bw, h: bh }, s)
            if (rx + rw < 0 || ry + rh < 0 || rx > canvas.width || ry > canvas.height) continue
            ctx.fillStyle = theme.testFrameFill
            ctx.fillRect(rx, ry, rw, rh)
            ctx.strokeStyle = theme.testFrame
            ctx.lineWidth = 2
            ctx.setLineDash([])
            ctx.strokeRect(rx, ry, rw, rh)
            ctx.save()
            ctx.beginPath()
            ctx.rect(0, 0, canvas.width, canvas.height)
            ctx.clip()
            ctx.font = `10px ${theme.fontFamily}`
            ctx.fillStyle = theme.testFrame
            ctx.fillText(box.pii_type.toUpperCase(), rx + 3, ry - 3)
            ctx.restore()
          }
        }

        // ── Scan preview boxes (amber) ──
        if (scanPreviewFrame && scanPreviewFrame.boxes.length > 0) {
          for (const box of scanPreviewFrame.boxes) {
            const [bx, by, bw, bh] = box.bbox
            const { rx, ry, rw, rh } = srcBboxToScreen({ x: bx, y: by, w: bw, h: bh }, s)
            if (rx + rw < 0 || ry + rh < 0 || rx > canvas.width || ry > canvas.height) continue
            ctx.fillStyle = theme.scanPreviewFill
            ctx.fillRect(rx, ry, rw, rh)
            ctx.strokeStyle = theme.scanPreview
            ctx.lineWidth = 2
            ctx.setLineDash([])
            ctx.strokeRect(rx, ry, rw, rh)
            ctx.save()
            ctx.beginPath()
            ctx.rect(0, 0, canvas.width, canvas.height)
            ctx.clip()
            ctx.font = `10px ${theme.fontFamily}`
            ctx.fillStyle = theme.scanPreview
            ctx.fillText(box.pii_type.toUpperCase(), rx + 3, ry - 3)
            ctx.restore()
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
            ctx.strokeStyle = theme.white
            ctx.lineWidth = 2
            ctx.setLineDash([6, 3])
            ctx.strokeRect(rx, ry, rw, rh)
            ctx.setLineDash([])
            ctx.fillStyle = 'rgba(255,255,255,0.08)'
            ctx.fillRect(rx, ry, rw, rh)
          }
        }

        // ── Live polygon draw ──
        if (polygonDrawMode && polygonPoints.current.length > 0) {
          ctx.beginPath()
          const pts = polygonPoints.current
          const first = srcBboxToScreen({ x: pts[0].nx, y: pts[0].ny, w: 0, h: 0 }, s)
          ctx.moveTo(first.rx, first.ry)
          for (let pi = 1; pi < pts.length; pi++) {
            const pt = srcBboxToScreen({ x: pts[pi].nx, y: pts[pi].ny, w: 0, h: 0 }, s)
            ctx.lineTo(pt.rx, pt.ry)
          }
          // Draw line to current mouse position
          if (polygonCurrent.current) {
            const cur = srcBboxToScreen({ x: polygonCurrent.current.nx, y: polygonCurrent.current.ny, w: 0, h: 0 }, s)
            ctx.lineTo(cur.rx, cur.ry)
          }
          ctx.strokeStyle = '#ff9900'
          ctx.lineWidth = 2
          ctx.setLineDash([6, 3])
          ctx.stroke()
          ctx.setLineDash([])

          // Fill the polygon area with a semi-transparent overlay
          if (pts.length >= 3) {
            ctx.beginPath()
            ctx.moveTo(first.rx, first.ry)
            for (let pi = 1; pi < pts.length; pi++) {
              const pt = srcBboxToScreen({ x: pts[pi].nx, y: pts[pi].ny, w: 0, h: 0 }, s)
              ctx.lineTo(pt.rx, pt.ry)
            }
            ctx.closePath()
            ctx.fillStyle = 'rgba(255,153,0,0.1)'
            ctx.fill()
          }

          // Draw vertex dots
          for (const pt of pts) {
            const sp = srcBboxToScreen({ x: pt.nx, y: pt.ny, w: 0, h: 0 }, s)
            ctx.fillStyle = '#ff9900'
            ctx.beginPath()
            ctx.arc(sp.rx, sp.ry, 4, 0, Math.PI * 2)
            ctx.fill()
          }

          // Hint text
          ctx.font = `11px ${theme.fontFamily}`
          ctx.fillStyle = '#ff9900'
          ctx.fillText(
            pts.length < 3 ? 'Click to add points' : 'Click to add, double-click to finish',
            first.rx, first.ry - 8
          )
        }
      }

      rafIdRef.current = requestAnimationFrame(draw)
    }

    rafIdRef.current = requestAnimationFrame(draw)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafIdRef.current)
    }
  }, []) // rAF loop runs continuously; reads latest props from propsRef

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
            e.stopPropagation()
            return
          }
        }
      }
    }

    // Priority 2: click inside an active event box — select it AND start a move drag
    for (const event of [...events].reverse()) {
      if (event.status === 'rejected') continue
      const active = event.time_ranges.some(r => currentTimeMs >= r.start_ms && currentTimeMs <= r.end_ms)
      if (!active) continue
      const bbox = interpolateBbox(event, currentTimeMs)
      if (!bbox) continue
      const { rx, ry, rw, rh } = srcBboxToScreen(bbox, s)
      if (mx >= rx && mx <= rx + rw && my >= ry && my <= ry + rh) {
        selectEvent(event.event_id)
        const srcPos = screenToSrc(mx, my, s)
        moveState.current = {
          event,
          startMouseSrc: { x: srcPos.nx, y: srcPos.ny },
          origBbox: { ...bbox },
        }
        e.stopPropagation()
        return
      }
    }

    // Priority 3: polygon draw mode (click to add vertex)
    if (polygonDrawMode) {
      const { nx, ny } = screenToSrc(mx, my, s)
      polygonPoints.current = [...polygonPoints.current, { nx, ny }]
      e.stopPropagation()
      return
    }

    // Priority 4: draw mode (rectangle)
    if (drawingMode) {
      const { nx, ny } = screenToSrc(mx, my, s)
      drawStart.current = { nx, ny }
      drawCurrent.current = { nx, ny }
      e.stopPropagation()
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = getScales()
    if (!s) return
    const canvas = canvasRef.current!
    const canvasRect = canvas.getBoundingClientRect()
    const mx = e.clientX - canvasRect.left
    const my = e.clientY - canvasRect.top

    // Move drag in progress: update preview box directly on canvas
    if (moveState.current) {
      const srcPos = screenToSrc(mx, my, s)
      const dx = srcPos.nx - moveState.current.startMouseSrc.x
      const dy = srcPos.ny - moveState.current.startMouseSrc.y
      const orig = moveState.current.origBbox
      const previewBbox: BoundingBox = {
        x: Math.round(orig.x + dx),
        y: Math.round(orig.y + dy),
        w: orig.w,
        h: orig.h,
      }
      const { rx, ry, rw, rh } = srcBboxToScreen(previewBbox, s)
      const containerRect = containerRef.current!.getBoundingClientRect()
      const ctx = canvas.getContext('2d')
      if (ctx) {
        if (canvas.width !== Math.round(containerRect.width)) canvas.width = Math.round(containerRect.width)
        if (canvas.height !== Math.round(containerRect.height)) canvas.height = Math.round(containerRect.height)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = theme.accentFill
        ctx.fillRect(rx, ry, rw, rh)
        ctx.strokeStyle = theme.accent
        ctx.lineWidth = 2
        ctx.setLineDash([4, 2])
        ctx.strokeRect(rx, ry, rw, rh)
        ctx.setLineDash([])
      }
      return
    }

    if (drawingMode && drawStart.current) {
      const { nx, ny } = screenToSrc(mx, my, s)
      drawCurrent.current = { nx, ny }
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
          ctx.strokeStyle = theme.white
          ctx.lineWidth = 2
          ctx.setLineDash([6, 3])
          ctx.strokeRect(rx, ry, rw, rh)
          ctx.setLineDash([])
          ctx.fillStyle = 'rgba(255,255,255,0.08)'
          ctx.fillRect(rx, ry, rw, rh)
        }
      }
      return
    }

    // Polygon mode: track mouse for preview line to next vertex
    if (polygonDrawMode && polygonPoints.current.length > 0) {
      const { nx, ny } = screenToSrc(mx, my, s)
      polygonCurrent.current = { nx, ny }
      return
    }

    // Update cursor based on what is under the mouse (no drag in progress)
    if (drawingMode || polygonDrawMode) {
      setCursorStyle('crosshair')
      return
    }

    if (selectedEventId) {
      const selEvent = events.find((ev) => ev.event_id === selectedEventId)
      if (selEvent) {
        const bbox = interpolateBbox(selEvent, currentTimeMs)
        if (bbox) {
          const { rx, ry, rw, rh } = srcBboxToScreen(bbox, s)
          const handles = getHandlePoints(rx, ry, rw, rh)
          const hit = hitHandle(mx, my, handles)
          if (hit) {
            setCursorStyle(HANDLE_CURSORS[hit])
            return
          }
          // Inside the box body (not on a handle) → move cursor
          if (mx >= rx && mx <= rx + rw && my >= ry && my <= ry + rh) {
            setCursorStyle('move')
            return
          }
        }
      }
    }

    // Check any other active event for hover
    for (const event of [...events].reverse()) {
      if (event.status === 'rejected') continue
      const active = event.time_ranges.some(r => currentTimeMs >= r.start_ms && currentTimeMs <= r.end_ms)
      if (!active) continue
      const bbox = interpolateBbox(event, currentTimeMs)
      if (!bbox) continue
      const { rx, ry, rw, rh } = srcBboxToScreen(bbox, s)
      if (mx >= rx && mx <= rx + rw && my >= ry && my <= ry + rh) {
        setCursorStyle('move')
        return
      }
    }

    // When zoomed and not in draw mode, hint that drag-to-pan is available
    setCursorStyle(zoomLevel > 1 ? 'grab' : 'default')
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
      const updatedKfs = upsertKeyframe(event.keyframes, currentTimeMs, newBbox)
      pushUndo({ type: 'keyframes', eventId: event.event_id, before: { keyframes: [...event.keyframes] }, after: { keyframes: updatedKfs } })
      const updated = { ...event, keyframes: updatedKfs }
      updateEvent(updated)
      try {
        await updateEventKeyframes(projectId, event.event_id, updatedKfs)
      } catch (err) {
        console.error('Failed to save resized keyframe:', err)
        addNotification('Failed to save resized keyframe', 'error')
      }
      return
    }

    // Finish move
    if (moveState.current) {
      const { event, startMouseSrc, origBbox } = moveState.current
      moveState.current = null

      const srcPos = screenToSrc(mx, my, s)
      const dx = srcPos.nx - startMouseSrc.x
      const dy = srcPos.ny - startMouseSrc.y

      // Only commit if the box actually moved (not a mere click)
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return

      const newBbox: BoundingBox = {
        x: Math.round(origBbox.x + dx),
        y: Math.round(origBbox.y + dy),
        w: origBbox.w,
        h: origBbox.h,
      }
      const updatedKfs = upsertKeyframe(event.keyframes, currentTimeMs, newBbox)
      pushUndo({ type: 'keyframes', eventId: event.event_id, before: { keyframes: [...event.keyframes] }, after: { keyframes: updatedKfs } })
      const updated = { ...event, keyframes: updatedKfs }
      updateEvent(updated)
      try {
        await updateEventKeyframes(projectId, event.event_id, updatedKfs)
      } catch (err) {
        console.error('Failed to save moved keyframe:', err)
        addNotification('Failed to save moved keyframe', 'error')
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
          source: 'manual',
          pii_type: 'manual',
          confidence: 1.0,
          extracted_text: null,
          time_ranges: [{ start_ms: currentTimeMs, end_ms: currentTimeMs }],
          keyframes: [{ time_ms: currentTimeMs, bbox: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } }],
          tracking_method: 'none',
          redaction_style: project?.scan_settings?.default_redaction_style ?? { type: 'blur', strength: 15, color: '#000000' },
          status: 'accepted',
        }

        try {
          const saved = await addEventToProject(projectId, newEvent)
          pushUndo({ type: 'add_event', before: null, after: { event: saved } })
          addEvent(saved)
          setDrawingMode(false)

          try {
            const tracked = await trackManualEvent(projectId, saved.event_id, {
              static: staticDrawMode,
            })
            updateEvent(tracked)
          } catch (err) {
            console.warn('Tracking failed for manual box (single-frame redaction kept):', err)
          }
        } catch (err) {
          console.error('Failed to save manual box:', err)
          addNotification('Failed to save manual box', 'error')
        }
      }
    }
  }

  const handleDoubleClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!polygonDrawMode || polygonPoints.current.length < 3) return
    e.stopPropagation()
    const s = getScales()
    if (!s) return

    const pts = polygonPoints.current
    // Compute bounding box of the polygon
    const xs = pts.map(p => p.nx)
    const ys = pts.map(p => p.ny)
    const minX = Math.round(Math.min(...xs))
    const minY = Math.round(Math.min(...ys))
    const maxX = Math.round(Math.max(...xs))
    const maxY = Math.round(Math.max(...ys))
    const w = maxX - minX
    const h = maxY - minY

    if (w < 10 || h < 10) {
      polygonPoints.current = []
      polygonCurrent.current = null
      return
    }

    const polygon = pts.map(p => [Math.round(p.nx), Math.round(p.ny)])

    const newEvent: RedactionEvent = {
      event_id: crypto.randomUUID(),
      source: 'manual',
      pii_type: 'manual',
      confidence: 1.0,
      extracted_text: null,
      time_ranges: [{ start_ms: currentTimeMs, end_ms: currentTimeMs }],
      keyframes: [{
        time_ms: currentTimeMs,
        bbox: { x: minX, y: minY, w, h },
        polygon,
      }],
      tracking_method: 'none',
      redaction_style: project?.scan_settings?.default_redaction_style ?? { type: 'blur', strength: 15, color: '#000000' },
      status: 'accepted',
    }

    polygonPoints.current = []
    polygonCurrent.current = null

    try {
      const saved = await addEventToProject(projectId, newEvent)
      pushUndo({ type: 'add_event', before: null, after: { event: saved } })
      addEvent(saved)
      setPolygonDrawMode(false)

      try {
        const tracked = await trackManualEvent(projectId, saved.event_id, {
          static: staticDrawMode,
        })
        updateEvent(tracked)
      } catch (err) {
        console.warn('Tracking failed for polygon box (single-frame redaction kept):', err)
      }
    } catch (err) {
      console.error('Failed to save polygon region:', err)
      addNotification('Failed to save polygon region', 'error')
    }
  }

  const needsPointerEvents = drawingMode || polygonDrawMode || selectedEventId !== null || events.some((ev) => {
    if (ev.status === 'rejected') return false
    return ev.time_ranges.some(r => currentTimeMs >= r.start_ms && currentTimeMs <= r.end_ms)
  })

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      style={{
        position: 'absolute',
        pointerEvents: needsPointerEvents ? 'auto' : 'none',
        zIndex: 5,
        cursor: (drawingMode || polygonDrawMode) ? 'crosshair' : cursorStyle,
      }}
    />
  )
}

/**
 * Interpolate a bounding box at a given time using keyframe data.
 * Uses a fixed envelope size (max w/h across all keyframes) and interpolates
 * center position only — matching what the backend renderer produces.
 */
function interpolateBbox(event: RedactionEvent, timeMs: number): BoundingBox | null {
  const kfs = event.keyframes
  if (!kfs || kfs.length === 0) return null
  if (kfs.length === 1) return kfs[0].bbox

  // Fixed envelope: max dimensions across all keyframes (stable size, no morph)
  const envW = Math.max(...kfs.map((k) => k.bbox.w))
  const envH = Math.max(...kfs.map((k) => k.bbox.h))

  let before: Keyframe | null = null
  let after: Keyframe | null = null

  for (const kf of kfs) {
    if (kf.time_ms <= timeMs) {
      if (!before || kf.time_ms > before.time_ms) before = kf
    } else {
      if (!after || kf.time_ms < after.time_ms) after = kf
    }
  }

  let cx: number
  let cy: number
  if (before && !after) {
    cx = before.bbox.x + before.bbox.w / 2
    cy = before.bbox.y + before.bbox.h / 2
  } else if (after && !before) {
    cx = after.bbox.x + after.bbox.w / 2
    cy = after.bbox.y + after.bbox.h / 2
  } else if (before && after) {
    const t = (timeMs - before.time_ms) / (after.time_ms - before.time_ms)
    const bcx = before.bbox.x + before.bbox.w / 2
    const bcy = before.bbox.y + before.bbox.h / 2
    const acx = after.bbox.x + after.bbox.w / 2
    const acy = after.bbox.y + after.bbox.h / 2
    cx = bcx + (acx - bcx) * t
    cy = bcy + (acy - bcy) * t
  } else {
    return null
  }

  return {
    x: Math.round(cx - envW / 2),
    y: Math.round(cy - envH / 2),
    w: envW,
    h: envH,
  }
}

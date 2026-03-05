/**
 * OverlayCanvas — draws redaction region previews on top of the video element.
 *
 * Rendered as a transparent canvas absolutely positioned over the <video> tag.
 * Redraws every time the playhead position changes (via ``currentTimeMs`` prop).
 *
 * For each active RedactionEvent at the current time:
 * 1. Interpolates the bounding box between the nearest keyframes.
 * 2. Scales it from video native pixels to the rendered video element's size.
 * 3. Draws a semi-transparent fill + border color-coded by event status:
 *    - Selected: blue (#5b7cf6)
 *    - Pending:  orange (#f0a050) with a dashed border
 *    - Accepted: green (#3dca7e)
 *
 * This gives the user a real-time preview of where redactions will be applied
 * before they export the video.
 */

import { useEffect, useRef } from 'react'
import { useProjectStore } from '../../store/projectStore'
import type { BoundingBox, Keyframe, RedactionEvent } from '../../types'

/** Props for the OverlayCanvas component. */
interface Props {
  /** Ref to the <video> element; used to read its rendered dimensions and native video size. */
  videoRef: React.RefObject<HTMLVideoElement>
  /** Ref to the container div; used to compute the canvas position offset. */
  containerRef: React.RefObject<HTMLDivElement>
  /** Current playhead position in milliseconds (updated on video timeupdate events). */
  currentTimeMs: number
  /** Whether the redaction overlay is visible (controlled by the toolbar toggle). */
  showRedactions: boolean
}

/**
 * Transparent canvas overlay that previews redaction regions on the video.
 *
 * The canvas covers the entire container and is updated via a useEffect that
 * runs whenever the playhead time, events list, or visibility toggle changes.
 */
export function OverlayCanvas({ videoRef, containerRef, currentTimeMs, showRedactions }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { events, selectedEventId } = useProjectStore((s) => ({
    events: s.events,
    selectedEventId: s.selectedEventId,
  }))

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    const container = containerRef.current
    if (!canvas || !video || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Size the canvas to the full container (not just the video area)
    // so the absolute positioning origin is the container's top-left corner.
    const videoRect = video.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()

    // Offset of the video element's top-left corner within the container
    const offsetX = videoRect.left - containerRect.left
    const offsetY = videoRect.top - containerRect.top

    canvas.width = containerRect.width
    canvas.height = containerRect.height

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Nothing to draw if overlay is hidden or video has no intrinsic size yet
    if (!showRedactions || video.videoWidth === 0) return

    // Scale factors: convert native video pixel coordinates to rendered screen pixels.
    // The video may be letterboxed/pillarboxed, so we must use the rendered dimensions.
    const scaleX = videoRect.width / video.videoWidth
    const scaleY = videoRect.height / video.videoHeight

    // Only draw events that are active at the current playhead position
    const activeEvents = events.filter((event) => {
      if (event.status === 'rejected') return false  // Rejected events are not drawn
      return event.time_ranges.some(
        (r) => currentTimeMs >= r.start_ms && currentTimeMs <= r.end_ms
      )
    })

    for (const event of activeEvents) {
      // Interpolate the bbox between the two nearest keyframes
      const bbox = interpolateBbox(event, currentTimeMs)
      if (!bbox) continue

      // Transform from native video coordinates to screen coordinates
      const rx = offsetX + bbox.x * scaleX
      const ry = offsetY + bbox.y * scaleY
      const rw = bbox.w * scaleX
      const rh = bbox.h * scaleY

      const isSelected = event.event_id === selectedEventId
      const isPending = event.status === 'pending'

      // Fill color: blue for selected, orange for pending, green for accepted
      ctx.fillStyle = isSelected
        ? 'rgba(91, 124, 246, 0.25)'
        : isPending
        ? 'rgba(240, 160, 80, 0.2)'
        : 'rgba(61, 202, 126, 0.2)'
      ctx.fillRect(rx, ry, rw, rh)

      // Border: solid for selected/accepted, dashed for pending (not yet confirmed)
      ctx.strokeStyle = isSelected ? '#5b7cf6' : isPending ? '#f0a050' : '#3dca7e'
      ctx.lineWidth = isSelected ? 2 : 1
      ctx.setLineDash(isPending ? [4, 2] : [])
      ctx.strokeRect(rx, ry, rw, rh)
      ctx.setLineDash([])  // Reset dash pattern for next shape

      // Small label above the box showing the PII type
      const label = event.pii_type.toUpperCase()
      ctx.font = '10px system-ui'
      ctx.fillStyle = ctx.strokeStyle
      ctx.fillText(label, rx + 3, ry - 3)
    }
  }, [currentTimeMs, events, selectedEventId, showRedactions])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        pointerEvents: 'none',  // Let mouse events pass through to the video element
        zIndex: 5,
      }}
    />
  )
}

/**
 * Linearly interpolate a bounding box at a given time using keyframe data.
 *
 * Finds the keyframes immediately before and after ``timeMs``, then linearly
 * interpolates between their bounding boxes. Returns the nearest keyframe's
 * bbox when no bracketing pair is found (clamps to first/last keyframe).
 *
 * @param event   - The RedactionEvent whose keyframes to interpolate.
 * @param timeMs  - The playhead time in milliseconds.
 * @returns Interpolated ``BoundingBox`` or null if no keyframes exist.
 */
function interpolateBbox(event: RedactionEvent, timeMs: number): BoundingBox | null {
  const kfs = event.keyframes
  if (!kfs || kfs.length === 0) return null

  // Single keyframe — no interpolation possible, use it directly
  if (kfs.length === 1) return kfs[0].bbox

  // Find the keyframe immediately before and after the current time
  let before: Keyframe | null = null
  let after: Keyframe | null = null

  for (const kf of kfs) {
    if (kf.time_ms <= timeMs) {
      // Keep the latest keyframe at or before timeMs
      if (!before || kf.time_ms > before.time_ms) before = kf
    } else {
      // Keep the earliest keyframe after timeMs
      if (!after || kf.time_ms < after.time_ms) after = kf
    }
  }

  // Clamp to the start or end of the keyframe sequence
  if (before && !after) return before.bbox
  if (after && !before) return after.bbox
  if (!before || !after) return null

  // Linear interpolation: t=0 at `before`, t=1 at `after`
  const t = (timeMs - before.time_ms) / (after.time_ms - before.time_ms)
  return {
    x: Math.round(before.bbox.x + (after.bbox.x - before.bbox.x) * t),
    y: Math.round(before.bbox.y + (after.bbox.y - before.bbox.y) * t),
    w: Math.round(before.bbox.w + (after.bbox.w - before.bbox.w) * t),
    h: Math.round(before.bbox.h + (after.bbox.h - before.bbox.h) * t),
  }
}

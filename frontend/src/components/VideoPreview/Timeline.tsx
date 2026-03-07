/**
 * Timeline — video scrubber bar with color-coded PII event markers.
 *
 * Renders a horizontal bar that doubles as both a seek control and a visual
 * map of all detected PII events across the video's duration.
 *
 * Visual elements:
 * - Gray bar: the full timeline (click to seek)
 * - White vertical line: the current playhead position
 * - Colored horizontal segments: RedactionEvent time ranges, color-coded by status:
 *     - Orange (pending) — not yet reviewed
 *     - Green (accepted) — confirmed and will be exported
 *     - Red (rejected) — dismissed as a false positive
 *
 * Clicking a segment both seeks to that event's start time and selects it
 * in the Inspector panel.
 */

import { useRef } from 'react'
import { useProjectStore } from '../../store/projectStore'

/** Props for the Timeline component. */
interface Props {
  /** Total video duration in milliseconds (denominator for all percentage calculations). */
  durationMs: number
  /** Current playhead position in milliseconds (updated on video timeupdate events). */
  currentTimeMs: number
  /** Callback to seek the video to a given time when the user clicks the timeline. */
  onSeek: (ms: number) => void
  /** Range scan in-point in milliseconds, or null when not set. */
  inPoint?: number | null
  /** Range scan out-point in milliseconds, or null when not set. */
  outPoint?: number | null
}

/** Color map for event status — used for the timeline markers. */
const STATUS_COLORS = {
  pending:  'var(--pending)',
  accepted: 'var(--accept)',
  rejected: 'var(--reject)',
} as const

/**
 * Horizontal timeline scrubber with PII event markers.
 *
 * @param props - See ``Props``.
 */
export function Timeline({ durationMs, currentTimeMs, onSeek, inPoint, outPoint }: Props) {
  const { events, selectEvent } = useProjectStore((s) => ({
    events: s.events,
    selectEvent: s.selectEvent,
  }))

  // Ref to the clickable bar area so we can measure its width for coordinate math
  const barRef = useRef<HTMLDivElement>(null)

  /**
   * Handle a click on the timeline bar.
   * Converts the click's X position to a time value and calls ``onSeek``.
   */
  const handleClick = (e: React.MouseEvent) => {
    if (!barRef.current) return
    const rect = barRef.current.getBoundingClientRect()
    // Clamp to [0, 1] to handle clicks on the very edge of the bar
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(Math.floor(ratio * durationMs))
  }

  // Convert playhead time to a percentage for CSS left positioning
  const playheadPct = durationMs > 0 ? (currentTimeMs / durationMs) * 100 : 0

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3)', background: 'var(--surface)', borderTop: '1px solid var(--border-hairline)' }}>
      {/* ── Clickable scrubber bar ── */}
      <div
        ref={barRef}
        onClick={handleClick}
        style={{
          position: 'relative',
          height: 32,
          background: 'rgba(255, 255, 255, 0.08)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          overflow: 'hidden',
        }}
      >
        {/* ── Range scan shaded region (in → out) ── */}
        {inPoint != null && outPoint != null && (() => {
          const startPct = (Math.min(inPoint, outPoint) / durationMs) * 100
          const endPct = (Math.max(inPoint, outPoint) / durationMs) * 100
          return (
            <div
              style={{
                position: 'absolute',
                left: `${startPct}%`,
                width: `${endPct - startPct}%`,
                top: 0, bottom: 0,
                background: 'var(--accent-tint)',
                pointerEvents: 'none',
                zIndex: 2,
              }}
            />
          )
        })()}

        {/* ── In-point marker ── */}
        {inPoint != null && (
          <div
            title={`In: ${formatMs(inPoint)}`}
            style={{
              position: 'absolute',
              left: `${(inPoint / durationMs) * 100}%`,
              top: 0, bottom: 0,
              width: 2,
              background: 'var(--accent)',
              pointerEvents: 'none',
              zIndex: 8,
            }}
          >
            <div style={{ position: 'absolute', top: 2, left: 2, fontSize: 9, color: 'var(--accent)', whiteSpace: 'nowrap', userSelect: 'none' }}>I</div>
          </div>
        )}

        {/* ── Out-point marker ── */}
        {outPoint != null && (
          <div
            title={`Out: ${formatMs(outPoint)}`}
            style={{
              position: 'absolute',
              left: `${(outPoint / durationMs) * 100}%`,
              top: 0, bottom: 0,
              width: 2,
              background: 'var(--accent)',
              pointerEvents: 'none',
              zIndex: 8,
            }}
          >
            <div style={{ position: 'absolute', top: 2, left: 2, fontSize: 9, color: 'var(--accent)', whiteSpace: 'nowrap', userSelect: 'none' }}>O</div>
          </div>
        )}

        {/* ── Playhead: white vertical line at current time ── */}
        <div
          style={{
            position: 'absolute',
            left: `${playheadPct}%`,
            top: 0,
            bottom: 0,
            width: 2,
            background: 'var(--text)',
            pointerEvents: 'none',  // Don't intercept clicks on the bar
            zIndex: 10,
          }}
        />

        {/* ── PII event markers: horizontal colored segments ── */}
        {events.map((event) => {
          // Each event may span multiple time ranges; draw each separately
          return event.time_ranges.map((range, rangeIdx) => {
            const startPct = (range.start_ms / durationMs) * 100
            const endPct = (range.end_ms / durationMs) * 100
            // Ensure markers are at least 2px wide so short events are still visible
            const width = Math.max(0.3, endPct - startPct)
            const color = STATUS_COLORS[event.status as keyof typeof STATUS_COLORS] ?? STATUS_COLORS.pending

            return (
              <div
                key={`${event.event_id}-${rangeIdx}`}
                title={`${event.pii_type}: ${event.extracted_text ?? '(secure mode)'}`}
                onClick={(e) => {
                  e.stopPropagation()  // Don't also trigger the bar's seek handler
                  selectEvent(event.event_id)
                  onSeek(range.start_ms)
                }}
                style={{
                  position: 'absolute',
                  left: `${startPct}%`,
                  width: `${width}%`,
                  top: 4,
                  bottom: 4,
                  background: color,
                  borderRadius: 2,
                  opacity: 0.8,
                  cursor: 'pointer',
                  zIndex: 5,
                }}
              />
            )
          })
        })}
      </div>

      {/* ── Time display: current position and total duration ── */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: 'var(--space-1)',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--text-muted)',
        fontFamily: 'monospace',
      }}>
        <span>{formatMs(currentTimeMs)}</span>
        <span>{formatMs(durationMs)}</span>
      </div>
    </div>
  )
}

/**
 * Format a millisecond timestamp as a human-readable time string.
 *
 * @param ms - Time in milliseconds.
 * @returns Formatted string: "M:SS" for under an hour, "H:MM:SS" for longer.
 *
 * @example
 * formatMs(75000)  // "1:15"
 * formatMs(3665000) // "1:01:05"
 */
function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Inspector — right pane.
 * Shows details and controls for the currently selected RedactionEvent.
 * Handles export with real-time progress via WebSocket.
 */

import { useEffect, useRef } from 'react'
import { exportDownloadUrl, startExport, updateEventStatus, updateEventStyle } from '../../api/client'
import { useExportProgress } from '../../hooks/useExportProgress'
import { useProjectStore } from '../../store/projectStore'
import type { RedactionStyle, RedactionStyleType } from '../../types'

interface Props {
  style?: React.CSSProperties
}

const STYLE_LABELS: Record<RedactionStyleType, string> = {
  blur: 'Blur',
  pixelate: 'Pixelate',
  solid_box: 'Box',
}

const STRENGTH_LABELS: Record<RedactionStyleType, string> = {
  blur: 'Radius',
  pixelate: 'Block size',
  solid_box: 'N/A',
}

export function Inspector({ style }: Props) {
  const { project, events, selectedEventId, updateEventStatus: updateLocal, updateEvent } = useProjectStore((s) => ({
    project: s.project,
    events: s.events,
    selectedEventId: s.selectedEventId,
    updateEventStatus: s.updateEventStatus,
    updateEvent: s.updateEvent,
  }))

  const { progress: exportProg, track: trackExport, reset: resetExport } = useExportProgress()

  // Debounce timer for strength slider — avoids firing an API call on every pixel of drag
  const strengthTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const event = events.find((e) => e.event_id === selectedEventId)
  const acceptedCount = events.filter((e) => e.status === 'accepted').length

  // Clear debounce timer if event changes to avoid saving to the wrong event
  useEffect(() => {
    return () => {
      if (strengthTimer.current) clearTimeout(strengthTimer.current)
    }
  }, [selectedEventId])

  const handleExport = async () => {
    if (!project) return
    resetExport()
    try {
      const { export_id } = await startExport(project.project_id)
      trackExport(export_id)
    } catch (err: unknown) {
      console.error('Export failed to start:', err)
    }
  }

  const handleStatusChange = async (status: 'accepted' | 'rejected') => {
    if (!project || !event) return
    updateLocal(event.event_id, status)
    await updateEventStatus(project.project_id, event.event_id, status)
  }

  const applyStyle = async (newStyle: RedactionStyle) => {
    if (!project || !event) return
    // Optimistic update — the overlay and list reflect the new style immediately
    updateEvent({ ...event, redaction_style: newStyle })
    try {
      await updateEventStyle(project.project_id, event.event_id, newStyle)
    } catch (err) {
      console.error('Failed to save style:', err)
      // Revert on failure
      updateEvent(event)
    }
  }

  const handleStyleType = (type: RedactionStyleType) => {
    if (!event) return
    applyStyle({ ...event.redaction_style, type })
  }

  const handleStrength = (value: number) => {
    if (!project || !event) return
    const newStyle = { ...event.redaction_style, strength: value }
    // Update store immediately for responsive feel
    updateEvent({ ...event, redaction_style: newStyle })
    // Debounce the API call — only save 400ms after the user stops dragging
    if (strengthTimer.current) clearTimeout(strengthTimer.current)
    strengthTimer.current = setTimeout(() => {
      updateEventStyle(project.project_id, event.event_id, newStyle).catch(console.error)
    }, 400)
  }

  const handleColor = (color: string) => {
    if (!event) return
    applyStyle({ ...event.redaction_style, color })
  }

  return (
    <div style={{ background: 'var(--surface)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', ...style }}>
      {/* Export section */}
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Export</div>

        {exportProg.isRunning ? (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              Encoding… {exportProg.pct}%
              {exportProg.totalFrames > 0 && (
                <span> ({exportProg.currentFrame.toLocaleString()} / {exportProg.totalFrames.toLocaleString()} frames)</span>
              )}
            </div>
            <div style={{ height: 4, background: 'var(--border)', borderRadius: 2 }}>
              <div style={{ height: '100%', width: `${exportProg.pct}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width 0.3s' }} />
            </div>
          </div>
        ) : exportProg.outputPath ? (
          <div>
            <div style={{ fontSize: 12, color: 'var(--accept)', marginBottom: 8 }}>✓ Export complete</div>
            <a
              href={project ? exportDownloadUrl(project.project_id) : '#'}
              download
              style={{ display: 'block', padding: '6px 12px', background: 'var(--accept)', color: '#fff', borderRadius: 4, textAlign: 'center', fontSize: 13, textDecoration: 'none' }}
            >
              Download Video
            </a>
            <button onClick={resetExport} style={{ width: '100%', marginTop: 6 }}>Export again</button>
          </div>
        ) : exportProg.error ? (
          <div>
            <div style={{ fontSize: 12, color: 'var(--reject)', marginBottom: 8 }}>{exportProg.error}</div>
            <button onClick={handleExport} style={{ width: '100%' }}>Retry</button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              {acceptedCount} finding{acceptedCount !== 1 ? 's' : ''} accepted
            </div>
            <button
              className="primary"
              onClick={handleExport}
              disabled={acceptedCount === 0}
              style={{ width: '100%' }}
            >
              Export Redacted Video
            </button>
          </>
        )}
      </div>

      {/* Selected event detail */}
      {event ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Finding Detail</div>

          <Field label="Type">
            <span className={`tag ${event.pii_type}`}>{event.pii_type}</span>
          </Field>

          <Field label="Confidence">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3 }}>
                <div style={{ width: `${event.confidence * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
              </div>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 32 }}>
                {Math.round(event.confidence * 100)}%
              </span>
            </div>
          </Field>

          <Field label="Detected text">
            <code style={{ fontSize: 12, background: 'var(--bg)', padding: '4px 8px', borderRadius: 4, display: 'block', wordBreak: 'break-all' }}>
              {event.extracted_text ?? '[secure mode — not stored]'}
            </code>
          </Field>

          <Field label="Time ranges">
            {event.time_ranges.map((r, i) => (
              <div key={i} style={{ fontSize: 12, fontFamily: 'monospace', marginBottom: 2 }}>
                {formatMs(r.start_ms)} – {formatMs(r.end_ms)}
              </div>
            ))}
          </Field>

          <Field label="Source / Tracking">
            <span style={{ fontSize: 12 }}>{event.source} · {event.tracking_method}</span>
          </Field>

          <Field label="Redaction style">
            {/* Style type selector */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {(['blur', 'pixelate', 'solid_box'] as RedactionStyleType[]).map((t) => {
                const active = event.redaction_style.type === t
                return (
                  <button
                    key={t}
                    onClick={() => handleStyleType(t)}
                    style={{
                      flex: 1,
                      padding: '5px 4px',
                      fontSize: 11,
                      fontWeight: active ? 700 : 400,
                      background: active ? 'var(--accent)' : 'var(--bg)',
                      color: active ? '#fff' : 'var(--text)',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                    title={
                      t === 'blur' ? 'Gaussian blur — obscures text while looking natural'
                      : t === 'pixelate' ? 'Pixelate — mosaic effect'
                      : 'Solid box — opaque filled rectangle'
                    }
                  >
                    {STYLE_LABELS[t]}
                  </button>
                )
              })}
            </div>

            {/* Strength slider (hidden for solid_box) */}
            {event.redaction_style.type !== 'solid_box' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 64 }}>
                  {STRENGTH_LABELS[event.redaction_style.type]}
                </label>
                <input
                  type="range"
                  min={3}
                  max={51}
                  step={2}
                  value={event.redaction_style.strength}
                  onChange={(e) => handleStrength(parseInt(e.target.value, 10))}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 20, textAlign: 'right' }}>
                  {event.redaction_style.strength}
                </span>
              </div>
            )}

            {/* Color picker (solid_box only) */}
            {event.redaction_style.type === 'solid_box' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 64 }}>Color</label>
                <input
                  type="color"
                  value={event.redaction_style.color}
                  onChange={(e) => handleColor(e.target.value)}
                  style={{ width: 36, height: 28, padding: 2, border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', background: 'none' }}
                  title="Box fill color"
                />
                <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {event.redaction_style.color}
                </code>
              </div>
            )}

            {/* Style description */}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>
              {event.redaction_style.type === 'blur'
                ? 'Gaussian blur applied to the region. Higher radius = stronger obscuring.'
                : event.redaction_style.type === 'pixelate'
                ? 'Mosaic pixelation. Higher block size = larger, more visible pixels.'
                : 'Opaque filled rectangle. No underlying content visible.'}
            </div>
          </Field>

          <Field label="Status">
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="accept"
                style={{ flex: 1, opacity: event.status === 'accepted' ? 1 : 0.55 }}
                onClick={() => handleStatusChange('accepted')}
              >
                {event.status === 'accepted' ? '✓ Accepted' : 'A — Accept'}
              </button>
              <button
                className="reject"
                style={{ flex: 1, opacity: event.status === 'rejected' ? 1 : 0.55 }}
                onClick={() => handleStatusChange('rejected')}
              >
                {event.status === 'rejected' ? '✗ Rejected' : 'R — Reject'}
              </button>
            </div>
          </Field>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', padding: 24, textAlign: 'center', fontSize: 13 }}>
          Select a finding from the left panel to view details
        </div>
      )}

      {/* Keyboard shortcuts */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
        <div style={{ fontWeight: 600, marginBottom: 5 }}>Shortcuts</div>
        {[
          ['Space', 'Play / Pause'],
          ['J / L', 'Step ±5 s'],
          ['K', 'Pause'],
          ['A', 'Accept selected'],
          ['R', 'Reject selected'],
        ].map(([key, desc]) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <code style={{ background: 'var(--bg)', padding: '1px 5px', borderRadius: 3 }}>{key}</code>
            <span>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      {children}
    </div>
  )
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

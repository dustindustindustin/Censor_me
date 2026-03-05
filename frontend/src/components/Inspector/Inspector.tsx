/**
 * Inspector — right pane.
 * Shows details and controls for the currently selected RedactionEvent.
 * Handles export with real-time progress via WebSocket.
 */

import { exportDownloadUrl, startExport, updateEventStatus } from '../../api/client'
import { useExportProgress } from '../../hooks/useExportProgress'
import { useProjectStore } from '../../store/projectStore'
import type { RedactionStyleType } from '../../types'

interface Props {
  style?: React.CSSProperties
}

export function Inspector({ style }: Props) {
  const { project, events, selectedEventId, updateEventStatus: updateLocal } = useProjectStore((s) => ({
    project: s.project,
    events: s.events,
    selectedEventId: s.selectedEventId,
    updateEventStatus: s.updateEventStatus,
  }))

  const { progress: exportProg, track: trackExport, reset: resetExport } = useExportProgress()

  const event = events.find((e) => e.event_id === selectedEventId)
  const acceptedCount = events.filter((e) => e.status === 'accepted').length

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
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {(['blur', 'pixelate', 'solid_box'] as RedactionStyleType[]).map((t) => (
                <button
                  key={t}
                  style={{
                    flex: 1,
                    padding: '4px 6px',
                    fontSize: 11,
                    background: event.redaction_style.type === t ? 'var(--accent)' : 'var(--bg)',
                    color: event.redaction_style.type === t ? '#fff' : 'var(--text)',
                    cursor: 'pointer',
                  }}
                  title={t}
                >
                  {t === 'solid_box' ? 'box' : t}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 52 }}>Strength</label>
              <input
                type="range"
                min={3}
                max={51}
                value={event.redaction_style.strength}
                style={{ flex: 1 }}
                readOnly
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 20 }}>
                {event.redaction_style.strength}
              </span>
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

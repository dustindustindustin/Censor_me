/**
 * Inspector — right pane.
 * Shows details and controls for the currently selected RedactionEvent.
 * Handles export with real-time progress via WebSocket.
 */

import { useEffect, useRef, useState } from 'react'
import { bulkUpdateEventStatus, bulkUpdateEventStyle, exportDownloadUrl, openScanProgressSocket, startExport, startScan, updateEventStatus, updateEventStyle, updateProjectSettings } from '../../api/client'
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
  const { project, events, selectedEventId, updateEventStatus: updateLocal, updateEvent, bulkUpdateEventStatus: bulkUpdateLocal, bulkUpdateEventStyle: bulkUpdateStyleLocal, scanProgress, setScanId, updateProjectSettingsLocal } = useProjectStore((s) => ({
    project: s.project,
    events: s.events,
    selectedEventId: s.selectedEventId,
    updateEventStatus: s.updateEventStatus,
    updateEvent: s.updateEvent,
    bulkUpdateEventStatus: s.bulkUpdateEventStatus,
    bulkUpdateEventStyle: s.bulkUpdateEventStyle,
    scanProgress: s.scanProgress,
    setScanId: s.setScanId,
    updateProjectSettingsLocal: s.updateProjectSettings,
  }))

  const { progress: exportProg, track: trackExport, reset: resetExport } = useExportProgress()

  // Quick Export state
  const [quickExportStatus, setQuickExportStatus] = useState<'idle' | 'scanning' | 'accepting' | 'exporting' | 'done' | 'error'>('idle')
  const [quickExportError, setQuickExportError] = useState<string | null>(null)
  const quickExportAbort = useRef(false)

  // Debounce timers — avoid firing API calls on every pixel of drag/color change
  const strengthTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const globalStrengthTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const globalColorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Global style state — controls the "all bars" section.
  // Initialized from the first event when a project loads; then user-controlled.
  const [globalType, setGlobalType] = useState<RedactionStyleType>('blur')
  const [globalStrength, setGlobalStrength] = useState(15)
  const [globalColor, setGlobalColor] = useState('#000000')

  const event = events.find((e) => e.event_id === selectedEventId)
  const acceptedCount = events.filter((e) => e.status === 'accepted').length

  // Reset export state when a new scan starts so the export section returns to
  // idle rather than showing "Export again" from the previous export.
  useEffect(() => {
    if (scanProgress.isRunning) {
      resetExport()
    }
  }, [scanProgress.isRunning])

  // Sync global style controls from the project's default style when the project
  // changes. Falls back to the first event's style for backwards compatibility
  // with projects that predate the default_redaction_style setting.
  useEffect(() => {
    const defaultStyle = project?.scan_settings?.default_redaction_style
    if (defaultStyle) {
      setGlobalType(defaultStyle.type)
      setGlobalStrength(defaultStyle.strength)
      setGlobalColor(defaultStyle.color)
    } else if (events.length > 0) {
      const s = events[0].redaction_style
      setGlobalType(s.type)
      setGlobalStrength(s.strength)
      setGlobalColor(s.color)
    }
  }, [project?.project_id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear per-event debounce timers if event changes to avoid saving to the wrong event
  useEffect(() => {
    return () => {
      if (strengthTimer.current) clearTimeout(strengthTimer.current)
      if (colorTimer.current) clearTimeout(colorTimer.current)
    }
  }, [selectedEventId])

  // Clear global debounce timers on unmount
  useEffect(() => {
    return () => {
      if (globalStrengthTimer.current) clearTimeout(globalStrengthTimer.current)
      if (globalColorTimer.current) clearTimeout(globalColorTimer.current)
    }
  }, [])

  // ── Global style handlers (apply to all events + save as project default) ──

  /** Persist style as the project's default for future events. */
  const saveDefaultStyle = (style: RedactionStyle) => {
    if (!project) return
    const newScan = { ...project.scan_settings, default_redaction_style: style }
    updateProjectSettingsLocal(newScan, project.output_settings)
    updateProjectSettings(project.project_id, newScan, project.output_settings).catch(console.error)
  }

  const handleGlobalType = (type: RedactionStyleType) => {
    if (!project) return
    const newStyle: RedactionStyle = { type, strength: globalStrength, color: globalColor }
    setGlobalType(type)
    saveDefaultStyle(newStyle)
    if (events.length > 0) {
      bulkUpdateStyleLocal(newStyle)
      bulkUpdateEventStyle(project.project_id, newStyle).catch(console.error)
    }
  }

  const handleGlobalStrength = (value: number) => {
    if (!project) return
    const newStyle: RedactionStyle = { type: globalType, strength: value, color: globalColor }
    setGlobalStrength(value)
    if (events.length > 0) {
      bulkUpdateStyleLocal(newStyle)
    }
    if (globalStrengthTimer.current) clearTimeout(globalStrengthTimer.current)
    globalStrengthTimer.current = setTimeout(() => {
      saveDefaultStyle(newStyle)
      if (events.length > 0) {
        bulkUpdateEventStyle(project.project_id, newStyle).catch(console.error)
      }
    }, 400)
  }

  const handleGlobalColor = (color: string) => {
    if (!project) return
    const newStyle: RedactionStyle = { type: globalType, strength: globalStrength, color }
    setGlobalColor(color)
    if (events.length > 0) {
      bulkUpdateStyleLocal(newStyle)
    }
    if (globalColorTimer.current) clearTimeout(globalColorTimer.current)
    globalColorTimer.current = setTimeout(() => {
      saveDefaultStyle(newStyle)
      if (events.length > 0) {
        bulkUpdateEventStyle(project.project_id, newStyle).catch(console.error)
      }
    }, 400)
  }

  // ── Export handlers ─────────────────────────────────────────────────────────

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

  const handleQuickExport = async () => {
    if (!project) return
    quickExportAbort.current = false
    setQuickExportStatus('scanning')
    setQuickExportError(null)
    resetExport()

    try {
      // Step 1: Start scan
      const { scan_id } = await startScan(project.project_id)
      setScanId(scan_id)

      // Step 2: Wait for scan to finish via WebSocket
      await new Promise<void>((resolve, reject) => {
        const ws = openScanProgressSocket(scan_id)
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data)
          if (msg.stage === 'done') { ws.close(); resolve() }
          if (msg.stage === 'error') { ws.close(); reject(new Error(msg.message ?? 'Scan failed')) }
        }
        ws.onerror = () => reject(new Error('WebSocket error during scan'))
      })

      if (quickExportAbort.current) return

      // Step 3: Accept all events
      setQuickExportStatus('accepting')
      bulkUpdateLocal('accepted')
      await bulkUpdateEventStatus(project.project_id, 'accepted')

      // Step 4: Start export
      setQuickExportStatus('exporting')
      const { export_id } = await startExport(project.project_id)
      trackExport(export_id)

      setQuickExportStatus('done')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Quick Export failed'
      setQuickExportError(msg)
      setQuickExportStatus('error')
      console.error('Quick Export error:', err)
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
    if (!project || !event) return
    const newStyle = { ...event.redaction_style, color }
    // Optimistic store update for live preview of color in the box overlay label
    updateEvent({ ...event, redaction_style: newStyle })
    // Debounce the API call — color pickers fire onChange continuously while dragging
    if (colorTimer.current) clearTimeout(colorTimer.current)
    colorTimer.current = setTimeout(() => {
      updateEventStyle(project.project_id, event.event_id, newStyle).catch(console.error)
    }, 400)
  }

  return (
    <div className="glass" style={{ display: 'flex', flexDirection: 'column', borderRadius: 0, ...style }}>
      {/* Export section */}
      <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--border-hairline)' }}>
        <div style={{ fontWeight: 600, fontSize: 'var(--font-size-section)', marginBottom: 'var(--space-3)' }}>Export</div>

        {exportProg.isRunning ? (
          <div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
              Encoding… {exportProg.pct}%
              {exportProg.totalFrames > 0 && (
                <span> ({exportProg.currentFrame.toLocaleString()} / {exportProg.totalFrames.toLocaleString()} frames)</span>
              )}
            </div>
            <div style={{ height: 4, background: 'var(--border)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ height: '100%', width: `${exportProg.pct}%`, background: 'var(--accent)', borderRadius: 'var(--radius-sm)', transition: 'width 0.3s' }} />
            </div>
          </div>
        ) : exportProg.outputPath ? (
          <div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--accept)', marginBottom: 'var(--space-2)' }}><span className="checkmark-animate">✓</span> Export complete</div>
            <a
              href={project ? exportDownloadUrl(project.project_id) : '#'}
              download
              style={{ display: 'block', padding: 'var(--space-2) var(--space-3)', background: 'var(--accept)', color: '#fff', borderRadius: 'var(--radius-md)', textAlign: 'center', fontSize: 'var(--font-size-body)', textDecoration: 'none', transition: 'all var(--transition-fast)' }}
            >
              Download Video
            </a>
            <button className="secondary" onClick={resetExport} style={{ width: '100%', marginTop: 'var(--space-2)' }}>Export again</button>
          </div>
        ) : exportProg.error ? (
          <div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--reject)', marginBottom: 'var(--space-2)' }}>{exportProg.error}</div>
            <button className="secondary" onClick={handleExport} style={{ width: '100%' }}>Retry</button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
              {acceptedCount} finding{acceptedCount !== 1 ? 's' : ''} accepted
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <button
                className="primary"
                onClick={handleExport}
                disabled={acceptedCount === 0 || scanProgress.isRunning || quickExportStatus === 'scanning' || quickExportStatus === 'exporting'}
                style={{ flex: 1 }}
              >
                Export Redacted Video
              </button>
              <button
                className="secondary"
                onClick={handleQuickExport}
                disabled={!project?.video || scanProgress.isRunning || quickExportStatus === 'scanning' || quickExportStatus === 'exporting'}
                title="Scan video, accept all findings, and export in one step"
                style={{ flex: 1, fontSize: 'var(--font-size-small)' }}
              >
                {quickExportStatus === 'scanning' ? 'Scanning…'
                  : quickExportStatus === 'accepting' ? 'Accepting…'
                  : quickExportStatus === 'exporting' ? 'Exporting…'
                  : 'Quick Export'}
              </button>
            </div>
            {quickExportError && (
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--reject)', marginTop: 'var(--space-1)' }}>{quickExportError}</div>
            )}
            {quickExportStatus !== 'idle' && quickExportStatus !== 'error' && quickExportStatus !== 'done' && (
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}>
                {quickExportStatus === 'scanning' ? 'Step 1/3: Scanning for PII…'
                  : quickExportStatus === 'accepting' ? 'Step 2/3: Accepting all findings…'
                  : 'Step 3/3: Encoding video…'}
              </div>
            )}
          </>
        )}
      </div>

      {/* Global censor bar style — applies to all events */}
      {events.length > 0 && (
        <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--border-hairline)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
            <span style={{ fontWeight: 600, fontSize: 'var(--font-size-section)' }}>Censor Bar Style</span>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>— all {events.length} bar{events.length !== 1 ? 's' : ''}</span>
          </div>

          {/* Style type buttons */}
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
            {(['blur', 'pixelate', 'solid_box'] as RedactionStyleType[]).map((t) => {
              const active = globalType === t
              return (
                <button
                  key={t}
                  onClick={() => handleGlobalType(t)}
                  style={{
                    flex: 1,
                    padding: 'var(--space-2) var(--space-1)',
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: active ? 600 : 400,
                    background: active ? 'var(--accent)' : 'var(--glass-bg)',
                    color: active ? '#fff' : 'var(--text)',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)',
                    minHeight: 'auto',
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
          {globalType !== 'solid_box' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
              <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 64 }}>
                {STRENGTH_LABELS[globalType]}
              </label>
              <input
                type="range"
                min={3}
                max={51}
                step={2}
                value={globalStrength}
                onChange={(e) => handleGlobalStrength(parseInt(e.target.value, 10))}
                style={{ flex: 1, accentColor: 'var(--accent)' }}
              />
              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 20, textAlign: 'right' }}>
                {globalStrength}
              </span>
            </div>
          )}

          {/* Color picker (solid_box only) */}
          {globalType === 'solid_box' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
              <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 64 }}>Color</label>
              <input
                type="color"
                value={globalColor}
                onChange={(e) => handleGlobalColor(e.target.value)}
                style={{ width: 36, height: 28, padding: 2, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: 'none' }}
                title="Box fill color for all bars"
              />
              <code style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>{globalColor}</code>
            </div>
          )}

          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1)', fontStyle: 'italic' }}>
            Select a finding below to override its style individually
          </div>
        </div>
      )}

      {/* Selected event detail */}
      {event ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-section)', marginBottom: 'var(--space-4)' }}>Finding Detail</div>

          <Field label="Type">
            <span className={`tag ${event.pii_type}`}>{event.pii_type}</span>
          </Field>

          <Field label="Confidence">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ width: `${event.confidence * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 'var(--radius-sm)', transition: 'width var(--transition-fast)' }} />
              </div>
              <span style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', minWidth: 32 }}>
                {Math.round(event.confidence * 100)}%
              </span>
            </div>
          </Field>

          <Field label="Detected text">
            <code style={{ fontSize: 'var(--font-size-small)', background: 'var(--bg)', padding: 'var(--space-1) var(--space-2)', borderRadius: 'var(--radius-sm)', display: 'block', wordBreak: 'break-all' }}>
              {event.extracted_text ?? '[secure mode — not stored]'}
            </code>
          </Field>

          <Field label="Time ranges">
            {event.time_ranges.map((r, i) => (
              <div key={i} style={{ fontSize: 'var(--font-size-small)', fontFamily: 'monospace', marginBottom: 'var(--space-1)' }}>
                {formatMs(r.start_ms)} – {formatMs(r.end_ms)}
              </div>
            ))}
          </Field>

          <Field label="Source / Tracking">
            <span style={{ fontSize: 'var(--font-size-small)' }}>{event.source} · {event.tracking_method}</span>
          </Field>

          <Field label="Style (this finding)">
            {/* Style type selector */}
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
              {(['blur', 'pixelate', 'solid_box'] as RedactionStyleType[]).map((t) => {
                const active = event.redaction_style.type === t
                return (
                  <button
                    key={t}
                    onClick={() => handleStyleType(t)}
                    style={{
                      flex: 1,
                      padding: 'var(--space-2) var(--space-1)',
                      fontSize: 'var(--font-size-xs)',
                      fontWeight: active ? 600 : 400,
                      background: active ? 'var(--accent)' : 'var(--glass-bg)',
                      color: active ? '#fff' : 'var(--text)',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      transition: 'all var(--transition-fast)',
                      minHeight: 'auto',
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
                <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 64 }}>
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
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 20, textAlign: 'right' }}>
                  {event.redaction_style.strength}
                </span>
              </div>
            )}

            {/* Color picker (solid_box only) */}
            {event.redaction_style.type === 'solid_box' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 64 }}>Color</label>
                <input
                  type="color"
                  value={event.redaction_style.color}
                  onChange={(e) => handleColor(e.target.value)}
                  style={{ width: 36, height: 28, padding: 2, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: 'none' }}
                  title="Box fill color"
                />
                <code style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                  {event.redaction_style.color}
                </code>
              </div>
            )}

            {/* Style description */}
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-2)', fontStyle: 'italic' }}>
              {event.redaction_style.type === 'blur'
                ? 'Gaussian blur applied to the region. Higher radius = stronger obscuring.'
                : event.redaction_style.type === 'pixelate'
                ? 'Mosaic pixelation. Higher block size = larger, more visible pixels.'
                : 'Opaque filled rectangle. No underlying content visible.'}
            </div>
          </Field>

          <Field label="Status">
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', padding: 'var(--space-6)', textAlign: 'center', gap: 'var(--space-2)' }}>
          <div style={{ fontSize: 'var(--font-size-section)', opacity: 0.3 }}>◎</div>
          <div style={{ fontSize: 'var(--font-size-body)' }}>No finding selected</div>
          <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-disabled)' }}>Click a finding from the left panel to view details</div>
        </div>
      )}

      {/* Keyboard shortcuts */}
      <div style={{ padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--border-hairline)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
        <div style={{ fontWeight: 500, marginBottom: 'var(--space-1)' }}>Shortcuts</div>
        {[
          ['Space', 'Play / Pause'],
          ['J / L', 'Step ±5 s'],
          ['K', 'Pause'],
          ['A', 'Accept selected'],
          ['R', 'Reject selected'],
        ].map(([key, desc]) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-1)' }}>
            <code style={{ background: 'var(--surface-secondary)', padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-size-xs)' }}>{key}</code>
            <span>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-1)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 }}>
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

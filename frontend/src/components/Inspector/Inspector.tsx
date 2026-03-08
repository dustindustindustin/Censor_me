/**
 * Inspector — right pane.
 * Shows details and controls for the currently selected RedactionEvent.
 * Handles export with real-time progress via WebSocket.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, CircleDot, Redo2, Undo2, X } from 'lucide-react'
import { bulkUpdateEventStatus, bulkUpdateEventStyle, copyExportTo, exportDownloadUrl, openScanProgressSocket, reportDownloadUrl, startExport, startScan, updateEventKeyframes, updateEventStatus, updateEventStyle, updateProjectSettings } from '../../api/client'
import type { UndoAction } from '../../store/projectStore'
import { useExportProgress } from '../../hooks/useExportProgress'
import { useProjectStore } from '../../store/projectStore'
import type { RedactionStyle, RedactionStyleType } from '../../types'
import { formatMs, rangePct } from '../../utils/format'

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
  const { project, events, selectedEventId, updateEventStatus: updateLocal, updateEvent, bulkUpdateEventStatus: bulkUpdateLocal, bulkUpdateEventStyle: bulkUpdateStyleLocal, scanProgress, setScanId, updateProjectSettingsLocal, addNotification, pushUndo, canUndo, canRedo, undo, redo } = useProjectStore((s) => ({
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
    addNotification: s.addNotification,
    pushUndo: s.pushUndo,
    canUndo: s.canUndo,
    canRedo: s.canRedo,
    undo: s.undo,
    redo: s.redo,
  }))

  const { progress: exportProg, track: trackExport, reset: resetExport } = useExportProgress()

  // Quick Export state
  const [quickExportStatus, setQuickExportStatus] = useState<'idle' | 'scanning' | 'accepting' | 'exporting' | 'done' | 'error'>('idle')
  const [quickExportError, setQuickExportError] = useState<string | null>(null)
  const quickExportAbort = useRef(false)

  // Debounce timers
  const strengthTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const globalStrengthTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const globalColorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Global style state
  const [globalType, setGlobalType] = useState<RedactionStyleType>('blur')
  const [globalStrength, setGlobalStrength] = useState(15)
  const [globalColor, setGlobalColor] = useState('#000000')

  const event = events.find((e) => e.event_id === selectedEventId)
  const acceptedCount = events.filter((e) => e.status === 'accepted').length

  useEffect(() => {
    if (scanProgress.isRunning) {
      resetExport()
    }
  }, [scanProgress.isRunning])

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
  }, [project?.project_id, project?.scan_settings?.default_redaction_style])

  useEffect(() => {
    return () => {
      if (strengthTimer.current) clearTimeout(strengthTimer.current)
      if (colorTimer.current) clearTimeout(colorTimer.current)
    }
  }, [selectedEventId])

  useEffect(() => {
    return () => {
      if (globalStrengthTimer.current) clearTimeout(globalStrengthTimer.current)
      if (globalColorTimer.current) clearTimeout(globalColorTimer.current)
    }
  }, [])

  // ── Global style handlers ──

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

  // ── Export handlers ──

  const IS_TAURI = '__TAURI_INTERNALS__' in window

  const handleSaveAs = async () => {
    if (!project) return
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const dest = await save({
        defaultPath: 'redacted-video.mp4',
        filters: [{ name: 'Video', extensions: ['mp4'] }],
      })
      if (dest) {
        await copyExportTo(project.project_id, dest)
        addNotification('Video saved', 'success')
      }
    } catch {
      addNotification('Save failed', 'error')
    }
  }

  const handleExport = async () => {
    if (!project) return
    resetExport()
    try {
      const { export_id } = await startExport(project.project_id)
      trackExport(export_id)
    } catch (err: unknown) {
      console.error('Export failed to start:', err)
      addNotification('Export failed to start', 'error')
    }
  }

  const handleQuickExport = async () => {
    if (!project) return
    quickExportAbort.current = false
    setQuickExportStatus('scanning')
    setQuickExportError(null)
    resetExport()

    try {
      const { scan_id } = await startScan(project.project_id)
      setScanId(scan_id)

      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const ws = openScanProgressSocket(scan_id)
          ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data)
            if (msg.stage === 'done') { ws.close(); resolve() }
            if (msg.stage === 'error') { ws.close(); reject(new Error(msg.message ?? 'Scan failed')) }
          }
          ws.onerror = () => reject(new Error('WebSocket error during scan'))
          ws.onclose = (ev) => {
            if (!ev.wasClean) reject(new Error('WebSocket closed unexpectedly during scan'))
          }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Quick Export timed out after 10 minutes')), 10 * 60 * 1000)
        ),
      ])

      if (quickExportAbort.current) return

      setQuickExportStatus('accepting')
      bulkUpdateLocal('accepted')
      await bulkUpdateEventStatus(project.project_id, 'accepted')

      setQuickExportStatus('exporting')
      const { export_id } = await startExport(project.project_id)
      trackExport(export_id)

      setQuickExportStatus('done')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Quick Export failed'
      setQuickExportError(msg)
      setQuickExportStatus('error')
      console.error('Quick Export error:', err)
      addNotification(msg, 'error')
    }
  }

  const handleStatusChange = async (status: 'accepted' | 'rejected') => {
    if (!project || !event) return
    pushUndo({ type: 'status', eventId: event.event_id, before: { status: event.status }, after: { status } })
    updateLocal(event.event_id, status)
    await updateEventStatus(project.project_id, event.event_id, status)
  }

  const applyStyle = async (newStyle: RedactionStyle) => {
    if (!project || !event) return
    updateEvent({ ...event, redaction_style: newStyle })
    try {
      await updateEventStyle(project.project_id, event.event_id, newStyle)
    } catch (err) {
      console.error('Failed to save style:', err)
      addNotification('Failed to save style', 'error')
      updateEvent(event)
    }
  }

  const handleStyleType = (type: RedactionStyleType) => {
    if (!event) return
    pushUndo({ type: 'style', eventId: event.event_id, before: { style: { ...event.redaction_style } }, after: { style: { ...event.redaction_style, type } } })
    applyStyle({ ...event.redaction_style, type })
  }

  const handleStrength = (value: number) => {
    if (!project || !event) return
    // Record undo with the style as it was before any drag adjustments in this batch
    const currentEvents = useProjectStore.getState().events
    const currentEvent = currentEvents.find((e) => e.event_id === event.event_id)
    const oldStyle = currentEvent?.redaction_style ?? event.redaction_style
    const newStyle = { ...event.redaction_style, strength: value }
    updateEvent({ ...event, redaction_style: newStyle })
    if (strengthTimer.current) clearTimeout(strengthTimer.current)
    strengthTimer.current = setTimeout(() => {
      pushUndo({ type: 'style', eventId: event.event_id, before: { style: { ...oldStyle } }, after: { style: newStyle } })
      updateEventStyle(project.project_id, event.event_id, newStyle).catch(console.error)
    }, 400)
  }

  const handleColor = (color: string) => {
    if (!project || !event) return
    const newStyle = { ...event.redaction_style, color }
    updateEvent({ ...event, redaction_style: newStyle })
    if (colorTimer.current) clearTimeout(colorTimer.current)
    colorTimer.current = setTimeout(() => {
      pushUndo({ type: 'style', eventId: event.event_id, before: { style: { ...event.redaction_style } }, after: { style: newStyle } })
      updateEventStyle(project.project_id, event.event_id, newStyle).catch(console.error)
    }, 400)
  }

  const persistUndoRedo = async (pid: string, action: UndoAction, snapshot: 'before' | 'after') => {
    const data = snapshot === 'before' ? action.before : action.after
    switch (action.type) {
      case 'status':
        if (action.eventId) await updateEventStatus(pid, action.eventId, data.status)
        break
      case 'style':
        if (action.eventId) await updateEventStyle(pid, action.eventId, data.style)
        break
      case 'keyframes':
        if (action.eventId) await updateEventKeyframes(pid, action.eventId, data.keyframes)
        break
      case 'bulk_status':
        if (snapshot === 'before') {
          const statusGroups = new Map<string, string[]>()
          const beforeMap = data as Map<string, string>
          for (const [eid, status] of beforeMap) {
            const list = statusGroups.get(status) ?? []
            list.push(eid)
            statusGroups.set(status, list)
          }
          for (const [status, ids] of statusGroups) {
            await bulkUpdateEventStatus(pid, status as any, ids)
          }
        } else {
          await bulkUpdateEventStatus(pid, data.status, action.eventIds)
        }
        break
      case 'bulk_style':
        if (snapshot === 'before') {
          const beforeMap = data as Map<string, import('../../types').RedactionStyle>
          for (const [eid, style] of beforeMap) {
            await updateEventStyle(pid, eid, style)
          }
        } else {
          await bulkUpdateEventStyle(pid, data.style, action.eventIds)
        }
        break
    }
  }

  return (
    <div className="glass" style={{ display: 'flex', flexDirection: 'column', borderRadius: 0, ...style }}>
      {/* Export section */}
      <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--border-hairline)' }}>
        <div className="section-header">
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-section)' }}>Export</span>
        </div>

        {exportProg.isRunning ? (
          <div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
              Encoding\u2026 {exportProg.pct}%
              {exportProg.totalFrames > 0 && (
                <span> ({exportProg.currentFrame.toLocaleString()} / {exportProg.totalFrames.toLocaleString()} frames)</span>
              )}
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${exportProg.pct}%` }} />
            </div>
          </div>
        ) : exportProg.outputPath ? (
          <div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--accept)', marginBottom: 'var(--space-2)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
              <span className="checkmark-animate"><Check size={16} /></span> Export complete
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              {IS_TAURI ? (
                <button
                  onClick={handleSaveAs}
                  style={{ flex: 1, padding: 'var(--space-2) var(--space-3)', background: 'var(--accept)', color: '#fff', borderRadius: 'var(--radius-md)', textAlign: 'center', fontSize: 'var(--font-size-body)', border: 'none', cursor: 'pointer', transition: 'all var(--transition-fast)' }}
                >
                  Save Video As…
                </button>
              ) : (
                <a
                  href={project ? exportDownloadUrl(project.project_id) : '#'}
                  download
                  style={{ flex: 1, display: 'block', padding: 'var(--space-2) var(--space-3)', background: 'var(--accept)', color: '#fff', borderRadius: 'var(--radius-md)', textAlign: 'center', fontSize: 'var(--font-size-body)', textDecoration: 'none', transition: 'all var(--transition-fast)' }}
                >
                  Download Video
                </a>
              )}
              <a
                href={project ? reportDownloadUrl(project.project_id, 'html') : '#'}
                target="_blank"
                rel="noopener noreferrer"
                style={{ flex: 1, display: 'block', padding: 'var(--space-2) var(--space-3)', background: 'var(--glass-bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', textAlign: 'center', fontSize: 'var(--font-size-body)', textDecoration: 'none', transition: 'all var(--transition-fast)' }}
              >
                Download Report
              </a>
            </div>
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
                {quickExportStatus === 'scanning' ? 'Scanning\u2026'
                  : quickExportStatus === 'accepting' ? 'Accepting\u2026'
                  : quickExportStatus === 'exporting' ? 'Exporting\u2026'
                  : 'Quick Export'}
              </button>
            </div>
            {quickExportError && (
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--reject)', marginTop: 'var(--space-1)' }}>{quickExportError}</div>
            )}
            {quickExportStatus !== 'idle' && quickExportStatus !== 'error' && quickExportStatus !== 'done' && (
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}>
                {quickExportStatus === 'scanning' ? 'Step 1/3: Scanning for PII\u2026'
                  : quickExportStatus === 'accepting' ? 'Step 2/3: Accepting all findings\u2026'
                  : 'Step 3/3: Encoding video\u2026'}
              </div>
            )}
          </>
        )}
      </div>

      {/* Global censor bar style — applies to all events */}
      {events.length > 0 && (
        <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--border-hairline)' }}>
          <div className="section-header">
            <span style={{ fontWeight: 600, fontSize: 'var(--font-size-section)' }}>Censor Bar Style</span>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>\u2014 all {events.length} bar{events.length !== 1 ? 's' : ''}</span>
          </div>

          <StyleControls
            style={{ type: globalType, strength: globalStrength, color: globalColor }}
            onTypeChange={handleGlobalType}
            onStrengthChange={handleGlobalStrength}
            onColorChange={handleGlobalColor}
          />

          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1)', fontStyle: 'italic' }}>
            Select a finding below to override its style individually
          </div>
        </div>
      )}

      {/* Selected event detail */}
      {event ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>
          <div className="section-header">
            <span style={{ fontWeight: 600, fontSize: 'var(--font-size-section)' }}>Finding Detail</span>
          </div>

          <Field label="Type">
            <span className={`tag ${event.pii_type}`}>{event.pii_type}</span>
          </Field>

          <Field label="Confidence">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <div className="progress-track" style={{ flex: 1, height: 6 }}>
                <div className="progress-fill" style={{ width: `${event.confidence * 100}%` }} />
              </div>
              <span style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', minWidth: 32 }}>
                {Math.round(event.confidence * 100)}%
              </span>
            </div>
          </Field>

          <Field label="Detected text">
            <code style={{ fontSize: 'var(--font-size-small)', background: 'var(--bg)', padding: 'var(--space-1) var(--space-2)', borderRadius: 'var(--radius-sm)', display: 'block', wordBreak: 'break-all' }}>
              {event.extracted_text ?? '[secure mode \u2014 not stored]'}
            </code>
          </Field>

          <Field label="Time ranges">
            {event.time_ranges.map((r, i) => (
              <div key={i} style={{ fontSize: 'var(--font-size-small)', fontFamily: 'monospace', marginBottom: 'var(--space-1)' }}>
                {formatMs(r.start_ms)} \u2013 {formatMs(r.end_ms)}
              </div>
            ))}
          </Field>

          <Field label="Source / Tracking">
            <span style={{ fontSize: 'var(--font-size-small)' }}>{event.source} \u00b7 {event.tracking_method}</span>
          </Field>

          <Field label="Style (this finding)">
            <StyleControls
              style={event.redaction_style}
              onTypeChange={handleStyleType}
              onStrengthChange={handleStrength}
              onColorChange={handleColor}
            />
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
                style={{ flex: 1, opacity: event.status === 'accepted' ? 1 : 0.55, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-1)' }}
                onClick={() => handleStatusChange('accepted')}
              >
                {event.status === 'accepted' ? <><Check size={16} /> Accepted</> : 'A \u2014 Accept'}
              </button>
              <button
                className="reject"
                style={{ flex: 1, opacity: event.status === 'rejected' ? 1 : 0.55, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-1)' }}
                onClick={() => handleStatusChange('rejected')}
              >
                {event.status === 'rejected' ? <><X size={16} /> Rejected</> : 'R \u2014 Reject'}
              </button>
            </div>
          </Field>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', padding: 'var(--space-6)', textAlign: 'center', gap: 'var(--space-2)' }}>
          <CircleDot size={32} style={{ opacity: 0.3 }} />
          <div style={{ fontSize: 'var(--font-size-body)' }}>No finding selected</div>
          <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-disabled)' }}>Click a finding from the left panel to view details</div>
        </div>
      )}

      {/* Undo/Redo bar + Keyboard shortcuts */}
      <div style={{ padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--border-hairline)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <button
            className="ghost"
            disabled={!canUndo}
            onClick={() => {
              const action = undo()
              if (action && project) persistUndoRedo(project.project_id, action, 'before').catch(console.error)
            }}
            title="Undo (Ctrl+Z)"
            style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-1)', minHeight: 28, padding: 'var(--space-1)' }}
          >
            <Undo2 size={14} /> Undo
          </button>
          <button
            className="ghost"
            disabled={!canRedo}
            onClick={() => {
              const action = redo()
              if (action && project) persistUndoRedo(project.project_id, action, 'after').catch(console.error)
            }}
            title="Redo (Ctrl+Y)"
            style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-1)', minHeight: 28, padding: 'var(--space-1)' }}
          >
            <Redo2 size={14} /> Redo
          </button>
        </div>
        <div style={{ fontWeight: 500, marginBottom: 'var(--space-1)' }}>Shortcuts</div>
        {[
          ['Space', 'Play / Pause'],
          ['J / L', 'Step \u00b15 s'],
          ['K', 'Pause'],
          ['A', 'Accept selected'],
          ['R', 'Reject selected'],
          ['Ctrl+Z', 'Undo'],
          ['Ctrl+Y', 'Redo'],
        ].map(([key, desc]) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-1)' }}>
            <kbd>{key}</kbd>
            <span>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function StyleControls({ style: s, onTypeChange, onStrengthChange, onColorChange }: {
  style: RedactionStyle
  onTypeChange: (type: RedactionStyleType) => void
  onStrengthChange: (value: number) => void
  onColorChange: (color: string) => void
}) {
  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
        {(['blur', 'pixelate', 'solid_box'] as RedactionStyleType[]).map((t) => {
          const active = s.type === t
          return (
            <button
              key={t}
              onClick={() => onTypeChange(t)}
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
                t === 'blur' ? 'Gaussian blur \u2014 obscures text while looking natural'
                : t === 'pixelate' ? 'Pixelate \u2014 mosaic effect'
                : 'Solid box \u2014 opaque filled rectangle'
              }
            >
              {STYLE_LABELS[t]}
            </button>
          )
        })}
      </div>
      {s.type !== 'solid_box' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
          <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 64 }}>
            {STRENGTH_LABELS[s.type]}
          </label>
          <input
            type="range"
            min={3}
            max={51}
            step={2}
            value={s.strength}
            onChange={(e) => onStrengthChange(parseInt(e.target.value, 10))}
            style={{ flex: 1, '--value-pct': rangePct(s.strength, 3, 51) } as React.CSSProperties}
          />
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 20, textAlign: 'right' }}>
            {s.strength}
          </span>
        </div>
      )}
      {s.type === 'solid_box' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
          <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 64 }}>Color</label>
          <div className="color-swatch-wrapper">
            <div className="color-swatch" style={{ background: s.color }}>
              <input
                type="color"
                value={s.color}
                onChange={(e) => onColorChange(e.target.value)}
                title="Box fill color"
              />
            </div>
            <span className="color-hex">{s.color}</span>
          </div>
        </div>
      )}
    </>
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

/**
 * BatchPanel — submit multiple videos for batch processing.
 *
 * Accessed from the project selector screen. The user selects video files
 * (via file paths input or by pasting paths), configures shared scan/output
 * settings, and submits. A WebSocket connection streams per-video progress.
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle, FolderOpen, Loader, Play, Trash2, XCircle } from 'lucide-react'
import {
  cancelBatch,
  getBatchStatus,
  openBatchProgressSocket,
  submitBatch,
} from '../../api/client'
import type { BatchItem, BatchJob, OutputSettings, ScanSettings } from '../../types'

interface Props {
  defaultScanSettings: ScanSettings
  defaultOutputSettings: OutputSettings
  onClose: () => void
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  importing: 'Importing',
  scanning: 'Scanning',
  exporting: 'Exporting',
  done: 'Done',
  error: 'Error',
  skipped: 'Skipped',
}

const STATUS_COLORS: Record<string, string> = {
  queued: 'var(--text-muted)',
  importing: 'var(--accent)',
  scanning: 'var(--accent)',
  exporting: 'var(--accent)',
  done: 'var(--accept)',
  error: 'var(--reject)',
  skipped: 'var(--text-disabled)',
}

const IS_TAURI = '__TAURI_INTERNALS__' in window

export function BatchPanel({ defaultScanSettings, defaultOutputSettings, onClose }: Props) {
  const [videoPaths, setVideoPaths] = useState<string[]>([])
  const [pathInput, setPathInput] = useState('')
  const [autoAccept, setAutoAccept] = useState(true)
  const [autoExport, setAutoExport] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Active batch tracking
  const [batchId, setBatchId] = useState<string | null>(null)
  const [batchJob, setBatchJob] = useState<BatchJob | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const handleBrowse = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: true,
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm'] }],
    })
    if (selected) {
      const paths = (Array.isArray(selected) ? selected : [selected]) as string[]
      const newPaths = paths.filter((p) => !videoPaths.includes(p))
      if (newPaths.length > 0) setVideoPaths((prev) => [...prev, ...newPaths])
    }
  }

  // Add paths from the input textarea (one per line)
  const handleAddPaths = () => {
    const newPaths = pathInput
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !videoPaths.includes(p))
    if (newPaths.length > 0) {
      setVideoPaths((prev) => [...prev, ...newPaths])
      setPathInput('')
    }
  }

  const handleRemovePath = (idx: number) => {
    setVideoPaths((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleSubmit = async () => {
    if (videoPaths.length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitBatch({
        video_paths: videoPaths,
        scan_settings: defaultScanSettings,
        output_settings: defaultOutputSettings,
        auto_accept: autoAccept,
        auto_export: autoExport,
      })
      setBatchId(result.batch_id)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to submit batch')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = async () => {
    if (!batchId) return
    try {
      await cancelBatch(batchId)
    } catch {
      // ignore — the batch may already be done
    }
  }

  // Connect WebSocket when batchId is set
  useEffect(() => {
    if (!batchId) return

    // Initial status fetch
    getBatchStatus(batchId).then(setBatchJob).catch(() => {})

    const ws = openBatchProgressSocket(batchId)
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data)

        if (event.stage === 'batch_complete' && event.summary) {
          setBatchJob(event.summary)
          return
        }

        // Update individual item status from progress events
        setBatchJob((prev) => {
          if (!prev) return prev
          const items = [...prev.items]

          if (typeof event.index === 'number' && event.index < items.length) {
            const item = { ...items[event.index] }

            if (event.stage === 'video_start') item.status = 'importing'
            else if (event.stage === 'video_imported') {
              item.status = 'scanning'
              if (event.project_id) item.project_id = event.project_id
            }
            else if (event.batch_stage === 'scanning' && event.stage === 'ocr') {
              item.status = 'scanning'
              item.scan_pct = event.progress_pct ?? item.scan_pct
            }
            else if (event.stage === 'scan_done') {
              item.events_found = event.events_found ?? 0
              item.scan_pct = 100
            }
            else if (event.stage === 'export_progress') {
              item.status = 'exporting'
              item.export_pct = event.pct ?? item.export_pct
            }
            else if (event.stage === 'video_done') {
              item.status = 'done'
              item.export_pct = 100
            }
            else if (event.stage === 'video_error') {
              item.status = 'error'
              item.error = event.error
            }

            items[event.index] = item
          }

          return {
            ...prev,
            items,
            current_index: event.index ?? prev.current_index,
            status: event.stage === 'batch_done' ? 'done'
              : event.stage === 'batch_cancelled' ? 'cancelled'
              : prev.status,
          }
        })
      } catch {
        // ignore malformed messages
      }
    }

    ws.onclose = () => {
      // Final status refresh
      getBatchStatus(batchId).then(setBatchJob).catch(() => {})
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [batchId])

  const isDone = batchJob && ['done', 'error', 'cancelled'].includes(batchJob.status)
  const isRunning = batchJob && batchJob.status === 'running'

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'flex-start', height: '100%', padding: 'var(--space-6)',
      overflow: 'auto',
    }}>
      {/* Header */}
      <div style={{
        width: '100%', maxWidth: 700,
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        marginBottom: 'var(--space-5)',
      }}>
        <button className="ghost" onClick={onClose} style={{ padding: 'var(--space-1)', minHeight: 'auto' }}>
          <ArrowLeft size={18} />
        </button>
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)', fontWeight: 600 }}>
          Batch Processing
        </h2>
        {isRunning && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--accent)', marginLeft: 'auto' }}>
            Processing {(batchJob.current_index ?? 0) + 1} of {batchJob.total}
          </span>
        )}
        {isDone && (
          <span style={{
            fontSize: 'var(--font-size-xs)', marginLeft: 'auto',
            color: batchJob.status === 'done' ? 'var(--accept)' : 'var(--reject)',
          }}>
            {batchJob.status === 'done' ? 'Complete' : batchJob.status === 'cancelled' ? 'Cancelled' : 'Error'}
          </span>
        )}
      </div>

      <div style={{ width: '100%', maxWidth: 700, display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {/* Input area — only show before submission */}
        {!batchId && (
          <>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
                <label style={{ fontSize: 'var(--font-size-small)', fontWeight: 500, color: 'var(--text-muted)', flex: 1 }}>
                  Video file paths (one per line)
                </label>
                {IS_TAURI && (
                  <button
                    className="secondary"
                    onClick={handleBrowse}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}
                  >
                    <FolderOpen size={14} /> Browse…
                  </button>
                )}
              </div>
              <textarea
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleAddPaths() } }}
                placeholder={'C:\\Videos\\recording1.mp4\nC:\\Videos\\recording2.mp4\n\nPaste paths and click Add, or press Ctrl+Enter'}
                rows={5}
                style={{
                  width: '100%', resize: 'vertical',
                  padding: 'var(--space-2) var(--space-3)',
                  fontSize: 'var(--font-size-body)',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text)',
                  fontFamily: 'var(--font-mono, monospace)',
                }}
              />
              <button
                className="secondary"
                onClick={handleAddPaths}
                disabled={!pathInput.trim()}
                style={{ marginTop: 'var(--space-2)' }}
              >
                Add to Queue
              </button>
            </div>

            {/* Options */}
            <div style={{ display: 'flex', gap: 'var(--space-4)', fontSize: 'var(--font-size-body)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
                <input type="checkbox" checked={autoAccept} onChange={(e) => setAutoAccept(e.target.checked)} />
                Auto-accept all findings
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
                <input type="checkbox" checked={autoExport} onChange={(e) => setAutoExport(e.target.checked)} />
                Auto-export redacted video
              </label>
            </div>
          </>
        )}

        {/* Queue list */}
        {(videoPaths.length > 0 || batchJob) && (
          <div>
            <div style={{
              fontSize: 'var(--font-size-small)', fontWeight: 500, marginBottom: 'var(--space-2)',
              color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              Queue ({batchJob ? batchJob.items.length : videoPaths.length} videos)
            </div>

            <div style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
            }}>
              {batchJob ? (
                // Active/completed batch — show item status
                batchJob.items.map((item, idx) => (
                  <BatchItemRow key={idx} item={item} />
                ))
              ) : (
                // Pre-submission — editable queue
                videoPaths.map((path, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                      padding: 'var(--space-2) var(--space-3)',
                      borderBottom: idx < videoPaths.length - 1 ? '1px solid var(--border-hairline)' : 'none',
                      fontSize: 'var(--font-size-small)',
                    }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono, monospace)' }}>
                      {path}
                    </span>
                    <button
                      className="ghost"
                      onClick={() => handleRemovePath(idx)}
                      style={{ padding: 2, minHeight: 'auto', color: 'var(--text-muted)' }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {error && (
          <div style={{ color: 'var(--reject)', fontSize: 'var(--font-size-body)' }}>{error}</div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
          {!batchId && (
            <button
              className="primary"
              onClick={handleSubmit}
              disabled={submitting || videoPaths.length === 0}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}
            >
              <Play size={14} />
              {submitting ? 'Submitting...' : `Process ${videoPaths.length} Video${videoPaths.length !== 1 ? 's' : ''}`}
            </button>
          )}
          {isRunning && (
            <button className="secondary" onClick={handleCancel}>
              Cancel Batch
            </button>
          )}
          {isDone && (
            <button className="secondary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Batch Item Row ───────────────────────────────────────────────────────────

function BatchItemRow({ item }: { item: BatchItem }) {
  const statusColor = STATUS_COLORS[item.status] ?? 'var(--text-muted)'
  const statusLabel = STATUS_LABELS[item.status] ?? item.status

  // Calculate overall progress for this item
  let overallPct = 0
  if (item.status === 'importing') overallPct = 5
  else if (item.status === 'scanning') overallPct = 10 + (item.scan_pct * 0.5)
  else if (item.status === 'exporting') overallPct = 60 + (item.export_pct * 0.4)
  else if (item.status === 'done') overallPct = 100

  const isActive = ['importing', 'scanning', 'exporting'].includes(item.status)

  return (
    <div style={{
      padding: 'var(--space-2) var(--space-3)',
      borderBottom: '1px solid var(--border-hairline)',
      background: isActive ? 'var(--surface-raised)' : 'transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
        {/* Status icon */}
        {item.status === 'done' && <CheckCircle size={14} style={{ color: 'var(--accept)', flexShrink: 0 }} />}
        {item.status === 'error' && <XCircle size={14} style={{ color: 'var(--reject)', flexShrink: 0 }} />}
        {isActive && <Loader size={14} style={{ color: 'var(--accent)', flexShrink: 0, animation: 'spin 1s linear infinite' }} />}

        <span style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontSize: 'var(--font-size-small)', fontWeight: 500,
        }}>
          {item.filename}
        </span>

        <span style={{ fontSize: 'var(--font-size-xs)', color: statusColor, fontWeight: 600, flexShrink: 0 }}>
          {statusLabel}
        </span>

        {item.events_found > 0 && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>
            {item.events_found} findings
          </span>
        )}
      </div>

      {/* Progress bar */}
      {(isActive || item.status === 'done') && (
        <div style={{
          height: 3, borderRadius: 2,
          background: 'var(--border)',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(overallPct, 100)}%`,
            background: item.status === 'done' ? 'var(--accept)' : 'var(--accent)',
            transition: 'width 0.3s ease',
            borderRadius: 2,
          }} />
        </div>
      )}

      {item.error && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--reject)', marginTop: 'var(--space-1)' }}>
          {item.error}
        </div>
      )}
    </div>
  )
}

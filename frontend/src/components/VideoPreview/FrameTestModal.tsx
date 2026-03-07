/**
 * FrameTestModal — single-frame OCR + PII detection diagnostic.
 *
 * Opens pre-loaded at the current video playback position. Runs the full
 * OCR → Presidio pipeline on that frame via GET /scan/test-frame and shows
 * every raw result with no confidence filtering, so you can see exactly
 * what the scanner sees and why findings may or may not appear.
 */

import { useRef, useState } from 'react'
import { addEventToProject, testFrame } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import { PII_LABEL_COLORS } from '../../styles/theme'
import type { FrameTestCandidate, FrameTestRawResult, FrameTestResult, RedactionEvent, TestFrameOverlayBox } from '../../types'

interface Props {
  projectId: string
  initialFrameIndex: number
  totalFrames: number
  fps: number
  onClose: () => void
}

function msToTimecode(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  return `${h > 0 ? `${h}:` : ''}${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function FrameTestModal({ projectId, initialFrameIndex, totalFrames, fps, onClose }: Props) {
  const [frameIndex, setFrameIndex] = useState(initialFrameIndex)
  const [inputValue, setInputValue] = useState(String(initialFrameIndex))
  const [result, setResult] = useState<FrameTestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Indices of PII candidates the user has unchecked (excluded, since they start checked)
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  // Indices of OCR boxes the user has checked (opt-in, since they start unchecked)
  const [selectedOcr, setSelectedOcr] = useState<Set<number>>(new Set())
  // Whether the user has committed the selection ("Add to Censor List" was clicked)
  const [committed, setCommitted] = useState(false)
  const [committing, setCommitting] = useState(false)
  const { project, addEvent, setTestFrameOverlay } = useProjectStore((s) => ({
    project: s.project,
    addEvent: s.addEvent,
    setTestFrameOverlay: s.setTestFrameOverlay,
  }))
  const defaultStyle = project?.scan_settings?.default_redaction_style ?? { type: 'blur' as const, strength: 15, color: '#000000' }
  const inputRef = useRef<HTMLInputElement>(null)

  const runTest = async (idx: number) => {
    setLoading(true)
    setError(null)
    setResult(null)
    setExcluded(new Set())
    setSelectedOcr(new Set())
    setCommitted(false)
    setTestFrameOverlay(null)  // clear stale overlay while loading
    try {
      const data = await testFrame(projectId, idx)
      setResult(data)
      // Push kept candidates to the live video overlay
      if (data.presidio.candidates.length > 0) {
        const boxes: TestFrameOverlayBox[] = data.presidio.candidates.map((c) => ({
          bbox: c.bbox,
          pii_type: c.pii_type,
          text: c.text,
        }))
        setTestFrameOverlay(boxes)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Request failed'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  // Toggle a PII candidate in/out (they start checked; this excludes/re-includes)
  const handleTogglePii = (idx: number) => {
    if (committed || committing) return
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  // Toggle an OCR box in/out (they start unchecked; this selects/deselects)
  const handleToggleOcr = (idx: number) => {
    if (committed || committing) return
    setSelectedOcr((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const handleAddSelected = async (res: FrameTestResult) => {
    if (committed || committing) return

    const piiToAdd = res.presidio.candidates.filter((_, i) => !excluded.has(i))
    const ocrToAdd = res.ocr.boxes.filter((_, i) => selectedOcr.has(i))
    if (piiToAdd.length === 0 && ocrToAdd.length === 0) return

    setCommitting(true)
    try {
      // Add PII candidates (auto-classified)
      for (const c of piiToAdd) {
        const [x, y, w, h] = c.bbox
        const event: RedactionEvent = {
          event_id: crypto.randomUUID(),
          source: 'auto',
          pii_type: c.pii_type,
          confidence: c.confidence,
          extracted_text: c.text,
          time_ranges: [{ start_ms: res.time_ms, end_ms: res.time_ms }],
          keyframes: [{ time_ms: res.time_ms, bbox: { x, y, w, h } }],
          tracking_method: 'none',
          redaction_style: defaultStyle,
          status: 'accepted',
        }
        const saved = await addEventToProject(projectId, event)
        addEvent(saved)
      }
      // Add manually selected OCR boxes (no PII classification — type is 'manual')
      for (const box of ocrToAdd) {
        const [x, y, w, h] = box.bbox
        const event: RedactionEvent = {
          event_id: crypto.randomUUID(),
          source: 'auto',
          pii_type: 'manual',
          confidence: box.confidence,
          extracted_text: box.text,
          time_ranges: [{ start_ms: res.time_ms, end_ms: res.time_ms }],
          keyframes: [{ time_ms: res.time_ms, bbox: { x, y, w, h } }],
          tracking_method: 'none',
          redaction_style: defaultStyle,
          status: 'accepted',
        }
        const saved = await addEventToProject(projectId, event)
        addEvent(saved)
      }
      setCommitted(true)
    } catch (e) {
      console.error('Failed to add events:', e)
    } finally {
      setCommitting(false)
    }
  }

  // No auto-run on open — the button starts as "Run Test" so the user
  // can confirm the frame before waiting for OCR to complete.

  const handleFrameChange = (raw: string) => {
    setInputValue(raw)
    const n = parseInt(raw, 10)
    if (!isNaN(n) && n >= 0 && n < totalFrames) {
      setFrameIndex(n)
    }
  }

  const handleStep = (delta: number) => {
    const next = Math.max(0, Math.min(totalFrames - 1, frameIndex + delta))
    setFrameIndex(next)
    setInputValue(String(next))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }

  const timeMs = Math.round((frameIndex / fps) * 1000)

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="modal-content" style={{
        width: 640,
        maxHeight: '88vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: 'var(--space-4) var(--space-5)',
          borderBottom: '1px solid var(--border-hairline)',
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-section)', flex: 1 }}>Frame Detection Test</div>
          <button className="ghost" onClick={onClose} style={{ fontSize: 18, lineHeight: 1, padding: 'var(--space-1)', minHeight: 'auto' }}>×</button>
        </div>

        {/* Frame picker */}
        <div style={{
          padding: 'var(--space-3) var(--space-5)',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
        }}>
          <button onClick={() => handleStep(-30)} title="Back 1 second" style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-2)' }}>«</button>
          <button onClick={() => handleStep(-1)} title="Previous frame" style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-2)' }}>‹</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)' }}>Frame</span>
            <input
              ref={inputRef}
              type="number"
              min={0}
              max={totalFrames - 1}
              value={inputValue}
              onChange={(e) => handleFrameChange(e.target.value)}
              style={{
                width: 80, padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--font-size-body)',
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text)',
              }}
            />
            <span style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)' }}>/ {totalFrames - 1}</span>
          </div>
          <button onClick={() => handleStep(1)} title="Next frame" style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-2)' }}>›</button>
          <button onClick={() => handleStep(30)} title="Forward 1 second" style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-2)' }}>»</button>

          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginLeft: 'var(--space-1)' }}>
            {msToTimecode(timeMs)}
          </span>

          <button
            className="primary"
            onClick={() => runTest(frameIndex)}
            disabled={loading}
            style={{ marginLeft: 'auto', fontSize: 'var(--font-size-body)', padding: 'var(--space-2) var(--space-4)' }}
          >
            {loading ? 'Testing…' : 'Run Test'}
          </button>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4) var(--space-5)' }}>
          {loading && (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-body)', textAlign: 'center', padding: 'var(--space-8) 0' }}>
              Running OCR + Presidio on frame {frameIndex}…
              <div style={{ fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-2)' }}>First run loads models — may take 10–30 seconds</div>
            </div>
          )}

          {error && (
            <div style={{
              background: 'var(--reject-tint)', border: '1px solid var(--reject)',
              borderRadius: 'var(--radius-sm)', padding: 'var(--space-3) var(--space-4)', fontSize: 'var(--font-size-body)', color: 'var(--reject)',
            }}>
              <strong>Request failed:</strong> {error}
            </div>
          )}

          {result && !loading && (
            <>
              {result.error && (
                <div style={{
                  background: 'var(--reject-tint)', border: '1px solid var(--reject)',
                  borderRadius: 'var(--radius-sm)', padding: 'var(--space-3) var(--space-4)', fontSize: 'var(--font-size-body)', color: 'var(--reject)', marginBottom: 'var(--space-4)',
                }}>
                  <strong>Error:</strong> {result.error}
                </div>
              )}

              {/* OCR section */}
              <Section
                label="OCR"
                badge={result.ocr.box_count}
                badgeColor={result.ocr.box_count > 0 ? 'var(--accent)' : 'var(--text-muted)'}
              >
                {result.ocr.box_count === 0 ? (
                  <EmptyNote>
                    No text detected. Try a different frame or check the backend logs for EasyOCR errors.
                  </EmptyNote>
                ) : (
                  <>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
                      Check any text the auto-scan might miss to manually add it to the censor list.
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                      {result.ocr.boxes.map((box, i) => {
                        const isChecked = selectedOcr.has(i)
                        const isLocked = committed || committing
                        return (
                          <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                            padding: 'var(--space-2) var(--space-3)', background: 'var(--surface-secondary)',
                            borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-size-body)',
                            borderLeft: `3px solid ${isChecked ? 'var(--accent)' : 'var(--border)'}`,
                            opacity: isChecked ? 1 : 0.7,
                            transition: 'opacity 0.15s',
                          }}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={isLocked}
                              onChange={() => handleToggleOcr(i)}
                              title={isChecked ? 'Uncheck to exclude' : 'Check to add to censor list'}
                              style={{ cursor: isLocked ? 'default' : 'pointer', accentColor: 'var(--accent)', flexShrink: 0 }}
                            />
                            <span style={{ flex: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}>{box.text}</span>
                            <ConfBadge value={box.confidence} />
                            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                              {box.bbox[2]}×{box.bbox[3]}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </Section>

              {/* Presidio section */}
              <Section
                label="PII Detection"
                badge={result.presidio.kept_count}
                badgeColor={result.presidio.kept_count > 0 ? 'var(--accept)' : 'var(--text-muted)'}
                style={{ marginTop: 'var(--space-4)' }}
              >
                {result.presidio.error ? (
                  <div style={{
                    background: 'var(--reject-tint)', border: '1px solid var(--reject)',
                    borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)', fontSize: 'var(--font-size-body)', color: 'var(--reject)',
                  }}>
                    <strong>Presidio error:</strong> {result.presidio.error}
                    <div style={{ marginTop: 'var(--space-2)', color: 'var(--text-muted)' }}>
                      Run: <code>python -m spacy download en_core_web_lg</code>
                    </div>
                  </div>
                ) : result.presidio.kept_count === 0 && result.presidio.raw_count === 0 ? (
                  <EmptyNote>
                    Presidio found no PII in the OCR text.{' '}
                    {result.ocr.box_count === 0
                      ? 'OCR also found no text — fix OCR first.'
                      : 'Try lowering the confidence threshold in scan settings (currently ' +
                        result.presidio.active_threshold.toFixed(2) + ').'}
                  </EmptyNote>
                ) : (
                  <>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
                      Threshold: <strong>{result.presidio.active_threshold.toFixed(2)}</strong>
                      {' · '}Presidio found <strong>{result.presidio.raw_count}</strong> total
                      {' · '}<strong style={{ color: 'var(--accept)' }}>{result.presidio.kept_count}</strong> kept
                      {result.presidio.filtered_count > 0 && (
                        <>{' · '}<strong style={{ color: 'var(--text-muted)' }}>{result.presidio.filtered_count}</strong> filtered</>
                      )}
                    </div>

                    {/* Kept candidates */}
                    {result.presidio.kept_count === 0 ? (
                      <EmptyNote>
                        All {result.presidio.raw_count} Presidio results were filtered out. See "Filtered" below.
                      </EmptyNote>
                    ) : (
                      <>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
                          All findings are selected by default. Uncheck any false positives before adding.
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                          {result.presidio.candidates.map((c, i) => {
                            const isChecked = !excluded.has(i)
                            const isLocked = committed || committing
                            return (
                              <div key={i} style={{
                                display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                                padding: 'var(--space-2) var(--space-3)', background: 'var(--surface-secondary)',
                                borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-size-body)',
                                borderLeft: `3px solid ${isChecked ? 'var(--accent)' : 'var(--border)'}`,
                                opacity: isChecked ? 1 : 0.45,
                                transition: 'opacity 0.15s',
                              }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  disabled={isLocked}
                                  onChange={() => handleTogglePii(i)}
                                  title={isChecked ? 'Uncheck to exclude from censor list' : 'Check to include'}
                                  style={{ cursor: isLocked ? 'default' : 'pointer', accentColor: 'var(--accent)', flexShrink: 0 }}
                                />
                                <span style={{
                                  fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
                                  color: PII_LABEL_COLORS[c.pii_type] ?? 'var(--text-muted)',
                                  textTransform: 'uppercase', whiteSpace: 'nowrap',
                                }}>
                                  {c.pii_type}
                                </span>
                                <span style={{ flex: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}>{c.text}</span>
                                <ConfBadge value={c.confidence} />
                              </div>
                            )
                          })}
                        </div>
                      </>
                    )}

                    {/* Filtered results (collapsible) */}
                    {result.presidio.filtered_count > 0 && (
                      <FilteredSection raw={result.presidio.raw} />
                    )}
                  </>
                )}
              </Section>

              {/* Unified "Add to Censor List" button — covers both PII candidates and OCR boxes */}
              {(() => {
                const piiCount = result.presidio.candidates.length - excluded.size
                const ocrCount = selectedOcr.size
                const total = piiCount + ocrCount
                return (
                  <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border)' }}>
                    {committed ? (
                      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--accept)', fontWeight: 600, textAlign: 'center' }}>
                        ✓ Added to censor list
                      </div>
                    ) : (
                      <button
                        className="primary"
                        onClick={() => handleAddSelected(result)}
                        disabled={committing || total === 0}
                        style={{ width: '100%', fontSize: 'var(--font-size-body)' }}
                      >
                        {committing
                          ? 'Adding…'
                          : total === 0
                          ? 'No items selected'
                          : `Add ${total} item${total !== 1 ? 's' : ''} to Censor List`
                            + (piiCount > 0 && ocrCount > 0
                              ? ` (${piiCount} PII + ${ocrCount} OCR)`
                              : '')}
                      </button>
                    )}
                  </div>
                )
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Section({
  label, badge, badgeColor, children, style,
}: {
  label: string
  badge: number
  badgeColor: string
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
        <span style={{ fontSize: 'var(--font-size-small)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          {label}
        </span>
        <span style={{
          fontSize: 'var(--font-size-xs)', fontWeight: 700,
          background: badgeColor, color: '#000',
          borderRadius: 'var(--radius-md)', padding: '1px 7px',
          opacity: 0.9,
        }}>
          {badge}
        </span>
      </div>
      {children}
    </div>
  )
}

function ConfBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const color = pct >= 70 ? 'var(--accept)' : pct >= 40 ? 'var(--pending)' : 'var(--reject)'
  return (
    <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color, whiteSpace: 'nowrap' }}>
      {pct}%
    </span>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: 'var(--space-3)', fontSize: 'var(--font-size-small)',
      color: 'var(--text-muted)', fontStyle: 'italic',
      background: 'var(--surface-secondary)', borderRadius: 'var(--radius-sm)',
    }}>
      {children}
    </div>
  )
}

function FilteredSection({ raw }: { raw: FrameTestRawResult[] }) {
  const [open, setOpen] = useState(false)
  const filtered = raw.filter((r) => !r.would_appear_in_scan)
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', background: 'none',
          border: 'none', cursor: 'pointer', padding: 'var(--space-1) 0', display: 'flex', alignItems: 'center', gap: 'var(--space-1)',
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>{filtered.length} filtered out (click to inspect)</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginTop: 'var(--space-1)' }}>
          {filtered.map((r, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
              padding: 'var(--space-2) var(--space-3)', background: 'var(--surface-secondary)',
              borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-size-small)', opacity: 0.6,
              borderLeft: '3px solid var(--border)',
            }}>
              <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                {r.entity_type}
              </span>
              <span style={{ flex: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}>{r.text}</span>
              <ConfBadge value={r.confidence} />
              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap', fontStyle: 'italic' }}>
                {r.skip_reason}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

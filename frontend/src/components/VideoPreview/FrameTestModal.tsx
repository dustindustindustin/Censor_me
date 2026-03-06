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
import type { FrameTestCandidate, FrameTestRawResult, FrameTestResult, RedactionEvent, TestFrameOverlayBox } from '../../types'

interface Props {
  projectId: string
  initialFrameIndex: number
  totalFrames: number
  fps: number
  onClose: () => void
}

const PII_COLORS: Record<string, string> = {
  phone: '#4fc3f7',
  email: '#81c784',
  person: '#ffb74d',
  address: '#ce93d8',
  credit_card: '#ef9a9a',
  ssn: '#ef9a9a',
  account_id: '#80cbc4',
  employee_id: '#a5d6a7',
  postal_code: '#80cbc4',
  username: '#fff176',
  custom: '#b0bec5',
  unknown: '#546e7a',
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
  // Tracks which candidate indices have been added to the project (by "frameIdx:candidateIdx")
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set())
  const [addingKey, setAddingKey] = useState<string | null>(null)
  const { addEvent, setTestFrameOverlay } = useProjectStore((s) => ({
    addEvent: s.addEvent,
    setTestFrameOverlay: s.setTestFrameOverlay,
  }))
  const inputRef = useRef<HTMLInputElement>(null)

  const runTest = async (idx: number) => {
    setLoading(true)
    setError(null)
    setResult(null)
    setAddedKeys(new Set())
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

  const handleAdd = async (candidate: FrameTestCandidate, candidateIdx: number, timeMs: number) => {
    const key = `${frameIndex}:${candidateIdx}`
    if (addedKeys.has(key) || addingKey === key) return
    setAddingKey(key)
    try {
      const [x, y, w, h] = candidate.bbox
      const event: RedactionEvent = {
        event_id: crypto.randomUUID(),
        source: 'auto',
        pii_type: candidate.pii_type,
        confidence: candidate.confidence,
        extracted_text: candidate.text,
        time_ranges: [{ start_ms: timeMs, end_ms: timeMs }],
        keyframes: [{ time_ms: timeMs, bbox: { x, y, w, h } }],
        tracking_method: 'none',
        redaction_style: { type: 'blur', strength: 15, color: '#000000' },
        status: 'accepted',
      }
      const saved = await addEventToProject(projectId, event)
      addEvent(saved)
      setAddedKeys((prev) => new Set(prev).add(key))
    } catch (e) {
      console.error('Failed to add event:', e)
    } finally {
      setAddingKey(null)
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
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        width: 640,
        maxHeight: '88vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>Frame Detection Test</div>
          <button onClick={onClose} style={{ fontSize: 18, lineHeight: 1, padding: '2px 8px' }}>×</button>
        </div>

        {/* Frame picker */}
        <div style={{
          padding: '12px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <button onClick={() => handleStep(-30)} title="Back 1 second" style={{ fontSize: 12, padding: '4px 8px' }}>«</button>
          <button onClick={() => handleStep(-1)} title="Previous frame" style={{ fontSize: 12, padding: '4px 8px' }}>‹</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Frame</span>
            <input
              ref={inputRef}
              type="number"
              min={0}
              max={totalFrames - 1}
              value={inputValue}
              onChange={(e) => handleFrameChange(e.target.value)}
              style={{
                width: 80, padding: '4px 8px', fontSize: 13,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 4, color: 'var(--text)',
              }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>/ {totalFrames - 1}</span>
          </div>
          <button onClick={() => handleStep(1)} title="Next frame" style={{ fontSize: 12, padding: '4px 8px' }}>›</button>
          <button onClick={() => handleStep(30)} title="Forward 1 second" style={{ fontSize: 12, padding: '4px 8px' }}>»</button>

          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
            {msToTimecode(timeMs)}
          </span>

          <button
            className="primary"
            onClick={() => runTest(frameIndex)}
            disabled={loading}
            style={{ marginLeft: 'auto', fontSize: 13, padding: '5px 14px' }}
          >
            {loading ? 'Testing…' : 'Run Test'}
          </button>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
          {loading && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>
              Running OCR + Presidio on frame {frameIndex}…
              <div style={{ fontSize: 11, marginTop: 6 }}>First run loads models — may take 10–30 seconds</div>
            </div>
          )}

          {error && (
            <div style={{
              background: 'rgba(244,67,54,0.1)', border: '1px solid var(--reject)',
              borderRadius: 6, padding: '12px 14px', fontSize: 13, color: 'var(--reject)',
            }}>
              <strong>Request failed:</strong> {error}
            </div>
          )}

          {result && !loading && (
            <>
              {result.error && (
                <div style={{
                  background: 'rgba(244,67,54,0.1)', border: '1px solid var(--reject)',
                  borderRadius: 6, padding: '12px 14px', fontSize: 13, color: 'var(--reject)', marginBottom: 14,
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {result.ocr.boxes.map((box, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '6px 10px', background: 'var(--surface)',
                        borderRadius: 4, fontSize: 13,
                      }}>
                        <span style={{ flex: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}>{box.text}</span>
                        <ConfBadge value={box.confidence} />
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                          {box.bbox[0]},{box.bbox[1]} {box.bbox[2]}×{box.bbox[3]}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* Presidio section */}
              <Section
                label="PII Detection"
                badge={result.presidio.kept_count}
                badgeColor={result.presidio.kept_count > 0 ? 'var(--accept)' : 'var(--text-muted)'}
                style={{ marginTop: 14 }}
              >
                {result.presidio.error ? (
                  <div style={{
                    background: 'rgba(244,67,54,0.1)', border: '1px solid var(--reject)',
                    borderRadius: 6, padding: '10px 12px', fontSize: 13, color: 'var(--reject)',
                  }}>
                    <strong>Presidio error:</strong> {result.presidio.error}
                    <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
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
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
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
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                          Check a finding to add it to the censor list.
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                          {result.presidio.candidates.map((c, i) => {
                            const key = `${frameIndex}:${i}`
                            const isAdded = addedKeys.has(key)
                            const isAdding = addingKey === key
                            return (
                              <div key={i} style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '6px 10px', background: 'var(--surface)',
                                borderRadius: 4, fontSize: 13,
                                borderLeft: `3px solid ${isAdded ? 'var(--accept)' : 'var(--accent)'}`,
                                opacity: isAdding ? 0.6 : 1,
                                transition: 'opacity 0.15s',
                              }}>
                                <input
                                  type="checkbox"
                                  checked={isAdded}
                                  disabled={isAdded || addingKey !== null}
                                  onChange={() => handleAdd(c, i, result.time_ms)}
                                  title={isAdded ? 'Added to censor list' : 'Add to censor list'}
                                  style={{ cursor: isAdded || addingKey !== null ? 'default' : 'pointer', accentColor: 'var(--accent)', flexShrink: 0 }}
                                />
                                <span style={{
                                  fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
                                  color: PII_COLORS[c.pii_type] ?? 'var(--text-muted)',
                                  textTransform: 'uppercase', whiteSpace: 'nowrap',
                                }}>
                                  {c.pii_type}
                                </span>
                                <span style={{ flex: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}>{c.text}</span>
                                <ConfBadge value={c.confidence} />
                                {isAdded && (
                                  <span style={{ fontSize: 11, color: 'var(--accept)', whiteSpace: 'nowrap' }}>✓ added</span>
                                )}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          {label}
        </span>
        <span style={{
          fontSize: 11, fontWeight: 700,
          background: badgeColor, color: '#000',
          borderRadius: 10, padding: '1px 7px',
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
  const color = pct >= 70 ? 'var(--accept)' : pct >= 40 ? '#ffb74d' : 'var(--reject)'
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color, whiteSpace: 'nowrap' }}>
      {pct}%
    </span>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '10px 12px', fontSize: 12,
      color: 'var(--text-muted)', fontStyle: 'italic',
      background: 'var(--surface)', borderRadius: 4,
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
          fontSize: 11, color: 'var(--text-muted)', background: 'none',
          border: 'none', cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>{filtered.length} filtered out (click to inspect)</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
          {filtered.map((r, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '5px 10px', background: 'var(--surface)',
              borderRadius: 4, fontSize: 12, opacity: 0.6,
              borderLeft: '3px solid var(--border)',
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                {r.entity_type}
              </span>
              <span style={{ flex: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}>{r.text}</span>
              <ConfBadge value={r.confidence} />
              <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', fontStyle: 'italic' }}>
                {r.skip_reason}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

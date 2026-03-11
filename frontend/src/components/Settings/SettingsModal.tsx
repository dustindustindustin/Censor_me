/**
 * SettingsModal — project settings for Scan, Export, and custom PII Rules.
 *
 * Three tabs:
 *   Scan   — confidence threshold, OCR interval, resolution scale, secure mode
 *   Export — codec, resolution, quality mode, NVENC, watermark
 *   Rules  — view built-in rules; create, toggle, delete custom rules
 */

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  addCustomRule,
  deleteCustomRule,
  getPresets,
  getRules,
  getSystemDiagnostics,
  testRule,
  updateCustomRule,
  updateProjectSettings,
} from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import { PII_LABEL_COLORS, theme } from '../../styles/theme'
import type { OutputSettings, PiiType, Rule, ScanSettings } from '../../types'
import { rangePct } from '../../utils/format'

interface Props {
  projectId: string
  initialScanSettings: ScanSettings
  initialOutputSettings: OutputSettings
  gpuAvailable: boolean
  onClose: () => void
}

type Tab = 'scan' | 'export' | 'rules' | 'gpu'

const PII_LABEL_OPTIONS: PiiType[] = [
  'phone', 'email', 'person', 'address', 'credit_card', 'ssn',
  'account_id', 'employee_id', 'postal_code', 'username', 'face', 'custom',
]

/** PII types that have per-type confidence override sliders. */
const OVERRIDE_TYPES: { key: string; label: string }[] = [
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'person', label: 'Person' },
  { key: 'ssn', label: 'SSN' },
  { key: 'credit_card', label: 'Credit Card' },
  { key: 'account_id', label: 'Account ID' },
  { key: 'face', label: 'Face' },
]

function LabelBadge({ label }: { label: string | null }) {
  if (!label) return null
  return (
    <span style={{
      fontSize: 'var(--font-size-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
      padding: '1px 5px', borderRadius: 'var(--radius-sm)',
      background: `${PII_LABEL_COLORS[label] ?? theme.textDisabled}22`,
      color: PII_LABEL_COLORS[label] ?? 'var(--text-disabled)',
      border: `1px solid ${PII_LABEL_COLORS[label] ?? theme.textDisabled}55`,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

export function SettingsModal({
  projectId,
  initialScanSettings,
  initialOutputSettings,
  gpuAvailable,
  onClose,
}: Props) {
  const updateProjectSettingsStore = useProjectStore((s) => s.updateProjectSettings)

  const [activeTab, setActiveTab] = useState<Tab>('scan')
  const [scan, setScan] = useState<ScanSettings>(initialScanSettings)
  const [output, setOutput] = useState<OutputSettings>(initialOutputSettings)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Rules state
  const [rules, setRules] = useState<{ default: Rule[]; custom: Rule[] } | null>(null)
  const [rulesLoading, setRulesLoading] = useState(false)
  const [rulesError, setRulesError] = useState<string | null>(null)
  const rulesLoadedRef = useRef(false)

  // GPU diagnostics state
  const [gpuDiag, setGpuDiag] = useState<any>(null)
  const [gpuLoading, setGpuLoading] = useState(false)
  const gpuLoadedRef = useRef(false)

  // Add-rule form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPattern, setNewPattern] = useState('')
  const [newLabel, setNewLabel] = useState<PiiType>('custom')
  const [newConfidence, setNewConfidence] = useState(0.9)
  const [newDescription, setNewDescription] = useState('')
  const [testSample, setTestSample] = useState('')
  const [testResult, setTestResult] = useState<{ matches: string[]; count: number } | null>(null)
  const [testLoading, setTestLoading] = useState(false)
  const [addingRule, setAddingRule] = useState(false)
  const [addRuleError, setAddRuleError] = useState<string | null>(null)

  // Lazy-load rules on first Rules tab visit
  useEffect(() => {
    if (activeTab !== 'rules' || rulesLoadedRef.current) return
    rulesLoadedRef.current = true
    setRulesLoading(true)
    getRules()
      .then(setRules)
      .catch(() => setRulesError('Failed to load rules.'))
      .finally(() => setRulesLoading(false))
  }, [activeTab])

  // Lazy-load GPU diagnostics on first GPU tab visit
  useEffect(() => {
    if (activeTab !== 'gpu' || gpuLoadedRef.current) return
    gpuLoadedRef.current = true
    setGpuLoading(true)
    getSystemDiagnostics()
      .then(setGpuDiag)
      .catch(() => {})
      .finally(() => setGpuLoading(false))
  }, [activeTab])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await updateProjectSettings(projectId, scan, output)
      updateProjectSettingsStore(scan, output)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleRule = async (ruleId: string, enabled: boolean) => {
    setRules((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        custom: prev.custom.map((r) => r.rule_id === ruleId ? { ...r, enabled } : r),
      }
    })
    try {
      await updateCustomRule(ruleId, { enabled })
    } catch {
      getRules().then(setRules).catch(() => {})
      setRulesError('Failed to update rule.')
    }
  }

  const handleDeleteRule = async (ruleId: string) => {
    if (!window.confirm('Delete this rule?')) return
    setRules((prev) => {
      if (!prev) return prev
      return { ...prev, custom: prev.custom.filter((r) => r.rule_id !== ruleId) }
    })
    try {
      await deleteCustomRule(ruleId)
    } catch {
      getRules().then(setRules).catch(() => {})
      setRulesError('Failed to delete rule.')
    }
  }

  const handleTestRule = async () => {
    if (!newPattern || !testSample) return
    setTestLoading(true)
    setTestResult(null)
    try {
      const result = await testRule(newPattern, testSample)
      setTestResult(result)
    } catch (e: unknown) {
      setAddRuleError(e instanceof Error ? e.message : 'Test failed.')
    } finally {
      setTestLoading(false)
    }
  }

  const handleAddRule = async () => {
    if (!newName.trim() || !newPattern.trim()) return
    setAddingRule(true)
    setAddRuleError(null)
    const rule: Rule = {
      rule_id: crypto.randomUUID(),
      name: newName.trim(),
      type: 'regex',
      enabled: true,
      pattern: newPattern.trim(),
      label: newLabel,
      priority: 50,
      confidence: newConfidence,
      context_pixels: null,
      description: newDescription.trim(),
    }
    try {
      await addCustomRule(rule)
      setRules((prev) => {
        if (!prev) return { default: [], custom: [rule] }
        return { ...prev, custom: [...prev.custom, rule] }
      })
      setNewName('')
      setNewPattern('')
      setNewLabel('custom')
      setNewConfidence(0.9)
      setNewDescription('')
      setTestSample('')
      setTestResult(null)
      setShowAddForm(false)
    } catch (e: unknown) {
      setAddRuleError(e instanceof Error ? e.message : 'Failed to add rule.')
    } finally {
      setAddingRule(false)
    }
  }

  const saveBtnLabel = saving ? 'Saving\u2026' : saved ? '\u2713 Saved' : 'Save Changes'

  return (
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-section)' }}>Settings</span>
          <button className="modal-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="tab-bar">
          {(['scan', 'export', 'rules', 'gpu'] as Tab[]).map((tab) => (
            <button
              key={tab}
              className="tab-button"
              data-active={activeTab === tab}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'gpu' ? 'GPU / Performance' : tab}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-5) var(--space-6)' }}>
          {activeTab === 'scan' && (
            <ScanTab scan={scan} onChange={setScan} />
          )}
          {activeTab === 'export' && (
            <ExportTab output={output} onChange={setOutput} gpuAvailable={gpuAvailable} />
          )}
          {activeTab === 'gpu' && (
            <GpuTab data={gpuDiag} loading={gpuLoading} />
          )}
          {activeTab === 'rules' && (
            <RulesTab
              rules={rules}
              loading={rulesLoading}
              error={rulesError}
              showAddForm={showAddForm}
              setShowAddForm={setShowAddForm}
              newName={newName} setNewName={setNewName}
              newPattern={newPattern} setNewPattern={setNewPattern}
              newLabel={newLabel} setNewLabel={setNewLabel}
              newConfidence={newConfidence} setNewConfidence={setNewConfidence}
              newDescription={newDescription} setNewDescription={setNewDescription}
              testSample={testSample} setTestSample={setTestSample}
              testResult={testResult}
              testLoading={testLoading}
              addingRule={addingRule}
              addRuleError={addRuleError}
              onToggleRule={handleToggleRule}
              onDeleteRule={handleDeleteRule}
              onTestRule={handleTestRule}
              onAddRule={handleAddRule}
            />
          )}
        </div>

        {/* Footer (Scan + Export only) */}
        {activeTab !== 'rules' && activeTab !== 'gpu' && (
          <div style={{
            padding: 'var(--space-3) var(--space-6)',
            borderTop: '1px solid var(--border-hairline)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 'var(--space-3)',
            flexShrink: 0,
          }}>
            {saveError && (
              <span style={{ color: 'var(--reject)', fontSize: 'var(--font-size-small)', marginRight: 'auto' }}>
                {saveError}
              </span>
            )}
            <button className="secondary" onClick={onClose}>Cancel</button>
            <button
              className="primary"
              onClick={handleSave}
              disabled={saving}
              style={{ minWidth: 110 }}
            >
              {saveBtnLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Scan Tab ──────────────────────────────────────────────────────────────────

function ScanTab({ scan, onChange }: { scan: ScanSettings; onChange: (s: ScanSettings) => void }) {
  const [presets, setPresets] = useState<any[]>([])
  const presetsLoadedRef = useRef(false)

  useEffect(() => {
    if (presetsLoadedRef.current) return
    presetsLoadedRef.current = true
    getPresets().then(setPresets).catch(() => {})
  }, [])

  const handlePresetChange = (presetId: string) => {
    if (!presetId) return
    const preset = presets.find((p: any) => p.preset_id === presetId)
    if (!preset?.scan_settings) return
    const s = preset.scan_settings
    onChange({
      ...scan,
      preset: presetId,
      ...(s.ocr_sample_interval != null && { ocr_sample_interval: s.ocr_sample_interval }),
      ...(s.ocr_resolution_scale != null && { ocr_resolution_scale: s.ocr_resolution_scale }),
      ...(s.confidence_threshold != null && { confidence_threshold: s.confidence_threshold }),
      ...(s.detect_faces != null && { detect_faces: s.detect_faces }),
      ...(s.secure_mode != null && { secure_mode: s.secure_mode }),
      ...(s.entity_confidence_overrides != null && { entity_confidence_overrides: s.entity_confidence_overrides }),
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <Field label="Preset" hint="Load a preset to quickly configure scan settings for common scenarios.">
        <select
          value={scan.preset || ''}
          onChange={(e) => handlePresetChange(e.target.value)}
        >
          <option value="">Custom</option>
          {presets.map((p: any) => (
            <option key={p.preset_id} value={p.preset_id}>
              {p.name}{p.is_custom ? ' (custom)' : ''}
            </option>
          ))}
        </select>
        {scan.preset && presets.find((p: any) => p.preset_id === scan.preset)?.description && (
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}>
            {presets.find((p: any) => p.preset_id === scan.preset)?.description}
          </div>
        )}
      </Field>

      <Field label="Confidence threshold" hint="Minimum Presidio score to include a detection. Lower = more findings, higher = fewer false positives.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <input
            type="range" min={0} max={1} step={0.01}
            value={scan.confidence_threshold}
            onChange={(e) => onChange({ ...scan, confidence_threshold: parseFloat(e.target.value) })}
            style={{ flex: 1, '--value-pct': rangePct(scan.confidence_threshold, 0, 1) } as React.CSSProperties}
          />
          <span style={{ minWidth: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--font-size-body)' }}>
            {scan.confidence_threshold.toFixed(2)}
          </span>
        </div>
      </Field>

      <Field label="OCR sample interval" hint="Analyze 1 frame every N frames. Lower = more thorough, slower scan.">
        <input
          type="number" min={1} max={30} step={1}
          value={scan.ocr_sample_interval}
          onChange={(e) => onChange({ ...scan, ocr_sample_interval: Math.max(1, Math.min(30, parseInt(e.target.value) || 1)) })}
          style={{ width: 80 }}
        />
      </Field>

      <Field label="OCR resolution scale" hint="Scale frames before OCR. Higher helps small text; increases scan time.">
        <select
          value={scan.ocr_resolution_scale}
          onChange={(e) => onChange({ ...scan, ocr_resolution_scale: parseFloat(e.target.value) })}
        >
          <option value={0.5}>0.5&times;</option>
          <option value={1.0}>1&times; (default)</option>
          <option value={1.5}>1.5&times;</option>
          <option value={2.0}>2&times;</option>
        </select>
      </Field>

      <Field label="Per-type confidence overrides" hint="Override the global threshold for specific PII types. Types not listed here use the global threshold.">
        <PerTypeOverrides
          overrides={scan.entity_confidence_overrides ?? {}}
          globalThreshold={scan.confidence_threshold}
          onChange={(overrides) => onChange({ ...scan, entity_confidence_overrides: overrides })}
        />
      </Field>

      <Field label="Face detection" hint="Detect faces (webcam overlays, profile pictures) in addition to OCR text.">
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={scan.detect_faces ?? true}
            onChange={(e) => onChange({ ...scan, detect_faces: e.target.checked })}
          />
          <span style={{ fontSize: 'var(--font-size-body)' }}>Detect faces in video frames</span>
        </label>
      </Field>

      <Field label="Secure mode" hint="When enabled, detected text is never stored in the project file \u2014 only bounding boxes and timestamps are saved.">
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={scan.secure_mode}
            onChange={(e) => onChange({ ...scan, secure_mode: e.target.checked })}
          />
          <span style={{ fontSize: 'var(--font-size-body)' }}>Don't store detected text in project file</span>
        </label>
      </Field>

      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }}>
        Scan settings take effect on the next scan.
      </div>
    </div>
  )
}

// ── Export Tab ────────────────────────────────────────────────────────────────

function ExportTab({
  output,
  onChange,
  gpuAvailable,
}: {
  output: OutputSettings
  onChange: (o: OutputSettings) => void
  gpuAvailable: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <Field label="Codec">
        <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
          {(['h264', 'h265'] as const).map((c) => (
            <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>
              <input
                type="radio"
                name="codec"
                value={c}
                checked={output.codec === c}
                onChange={() => onChange({ ...output, codec: c })}
              />
              {c === 'h264' ? 'H.264' : 'H.265'}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Format">
        <select
          value={output.container_format ?? 'mp4'}
          onChange={(e) => onChange({ ...output, container_format: e.target.value })}
        >
          <option value="mp4">MP4 (.mp4)</option>
          <option value="mov">MOV (.mov)</option>
          <option value="mkv">MKV (.mkv)</option>
        </select>
      </Field>

      <Field label="Resolution">
        <select
          value={output.resolution}
          onChange={(e) => onChange({ ...output, resolution: e.target.value })}
        >
          <option value="match_input">Match source</option>
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="4K">4K</option>
          <option value="custom">Custom</option>
        </select>
        {output.resolution === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
            <input
              type="number" placeholder="Width" min={1}
              value={output.custom_width ?? ''}
              onChange={(e) => onChange({ ...output, custom_width: parseInt(e.target.value) || null })}
              style={{ width: 90 }}
            />
            <span style={{ color: 'var(--text-muted)' }}>&times;</span>
            <input
              type="number" placeholder="Height" min={1}
              value={output.custom_height ?? ''}
              onChange={(e) => onChange({ ...output, custom_height: parseInt(e.target.value) || null })}
              style={{ width: 90 }}
            />
          </div>
        )}
      </Field>

      <Field label="Quality mode">
        <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
          {(['crf', 'bitrate'] as const).map((m) => (
            <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>
              <input
                type="radio"
                name="quality_mode"
                value={m}
                checked={output.quality_mode === m}
                onChange={() => onChange({ ...output, quality_mode: m })}
              />
              {m === 'crf' ? 'CRF' : 'Bitrate'}
            </label>
          ))}
        </div>
        {output.quality_mode === 'crf' && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <input
                type="range" min={0} max={51} step={1}
                value={output.crf}
                onChange={(e) => onChange({ ...output, crf: parseInt(e.target.value) })}
                style={{ flex: 1, '--value-pct': rangePct(output.crf, 0, 51) } as React.CSSProperties}
              />
              <span style={{ minWidth: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--font-size-body)' }}>
                {output.crf}
              </span>
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}>Lower = better quality, larger file</div>
          </div>
        )}
        {output.quality_mode === 'bitrate' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            <input
              type="number" placeholder="Bitrate" min={100}
              value={output.bitrate_kbps ?? ''}
              onChange={(e) => onChange({ ...output, bitrate_kbps: parseInt(e.target.value) || null })}
              style={{ width: 110 }}
            />
            <span style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)' }}>kbps</span>
          </div>
        )}
      </Field>

      {gpuAvailable && (
        <Field label="Hardware encoding">
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={output.use_hw_encoder}
              onChange={(e) => onChange({ ...output, use_hw_encoder: e.target.checked })}
            />
            <span style={{ fontSize: 'var(--font-size-body)' }}>Use GPU hardware encoder when available</span>
          </label>
        </Field>
      )}

      <Field label="Watermark">
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={output.watermark}
            onChange={(e) => onChange({ ...output, watermark: e.target.checked })}
          />
          <span style={{ fontSize: 'var(--font-size-body)' }}>Overlay "Redacted" watermark on exported video</span>
        </label>
      </Field>
    </div>
  )
}

// ── Rules Tab ─────────────────────────────────────────────────────────────────

interface RulesTabProps {
  rules: { default: Rule[]; custom: Rule[] } | null
  loading: boolean
  error: string | null
  showAddForm: boolean
  setShowAddForm: (v: boolean) => void
  newName: string
  setNewName: (v: string) => void
  newPattern: string
  setNewPattern: (v: string) => void
  newLabel: PiiType
  setNewLabel: (v: PiiType) => void
  newConfidence: number
  setNewConfidence: (v: number) => void
  newDescription: string
  setNewDescription: (v: string) => void
  testSample: string
  setTestSample: (v: string) => void
  testResult: { matches: string[]; count: number } | null
  testLoading: boolean
  addingRule: boolean
  addRuleError: string | null
  onToggleRule: (id: string, enabled: boolean) => void
  onDeleteRule: (id: string) => void
  onTestRule: () => void
  onAddRule: () => void
}

function RulesTab(p: RulesTabProps) {
  const patternLen = p.newPattern.length

  if (p.loading) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-body)' }}>Loading rules\u2026</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {p.error && (
        <div style={{ color: 'var(--reject)', fontSize: 'var(--font-size-small)' }}>{p.error}</div>
      )}

      {/* Built-in rules */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)' }}>Built-in rules</span>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>Read only</span>
        </div>
        {(p.rules?.default ?? []).map((rule) => (
          <RuleRow key={rule.rule_id} rule={rule} readOnly />
        ))}
        {p.rules && p.rules.default.length === 0 && (
          <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)' }}>No built-in rules.</div>
        )}
      </section>

      {/* Custom rules */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)' }}>Custom rules</span>
          <button
            onClick={() => p.setShowAddForm(!p.showAddForm)}
            style={{ marginLeft: 'auto', padding: 'var(--space-1) var(--space-3)', fontSize: 'var(--font-size-small)' }}
          >
            {p.showAddForm ? 'Cancel' : '+ Add Rule'}
          </button>
        </div>

        {(p.rules?.custom ?? []).map((rule) => (
          <RuleRow
            key={rule.rule_id}
            rule={rule}
            onToggle={(enabled) => p.onToggleRule(rule.rule_id, enabled)}
            onDelete={() => p.onDeleteRule(rule.rule_id)}
          />
        ))}
        {p.rules && p.rules.custom.length === 0 && !p.showAddForm && (
          <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)' }}>No custom rules yet.</div>
        )}
      </section>

      {/* Add rule form */}
      {p.showAddForm && (
        <section style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: 'var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)' }}>New custom rule</div>

          <Field label="Name" compact>
            <input
              type="text"
              value={p.newName}
              onChange={(e) => p.setNewName(e.target.value)}
              placeholder="e.g. 10-Digit Account Number"
              style={{ width: '100%' }}
            />
          </Field>

          <Field label="Regex pattern" compact>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                value={p.newPattern}
                onChange={(e) => p.setNewPattern(e.target.value)}
                placeholder={String.raw`e.g. \b\d{10}\b`}
                maxLength={500}
                style={{ width: '100%', fontFamily: 'monospace', paddingRight: 48 }}
              />
              <span style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                fontSize: 'var(--font-size-xs)',
                color: patternLen > 450 ? 'var(--reject)' : 'var(--text-muted)',
              }}>
                {patternLen}/500
              </span>
            </div>
          </Field>

          <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
            <Field label="PII label" compact style={{ flex: 1 }}>
              <select
                value={p.newLabel}
                onChange={(e) => p.setNewLabel(e.target.value as PiiType)}
                style={{ width: '100%' }}
              >
                {PII_LABEL_OPTIONS.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </Field>
            <Field label={`Confidence: ${p.newConfidence.toFixed(2)}`} compact style={{ flex: 1 }}>
              <input
                type="range" min={0.1} max={1.0} step={0.05}
                value={p.newConfidence}
                onChange={(e) => p.setNewConfidence(parseFloat(e.target.value))}
                style={{ width: '100%', '--value-pct': rangePct(p.newConfidence, 0.1, 1.0) } as React.CSSProperties}
              />
            </Field>
          </div>

          <Field label="Description (optional)" compact>
            <textarea
              value={p.newDescription}
              onChange={(e) => p.setNewDescription(e.target.value)}
              rows={2}
              placeholder="What does this rule detect?"
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 'var(--font-size-body)' }}
            />
          </Field>

          {/* Test section */}
          <div style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: 'var(--space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}>
            <div style={{ fontSize: 'var(--font-size-small)', fontWeight: 600, color: 'var(--text-muted)' }}>Test pattern</div>
            <textarea
              value={p.testSample}
              onChange={(e) => p.setTestSample(e.target.value)}
              rows={3}
              placeholder="Paste sample text here to test the pattern\u2026"
              style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 'var(--font-size-small)' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <button
                onClick={p.onTestRule}
                disabled={!p.newPattern || !p.testSample || p.testLoading}
                style={{ padding: 'var(--space-1) var(--space-3)', fontSize: 'var(--font-size-small)' }}
              >
                {p.testLoading ? 'Testing\u2026' : 'Test Pattern'}
              </button>
              {p.testResult !== null && (
                <span style={{ fontSize: 'var(--font-size-small)', color: p.testResult.count > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {p.testResult.count > 0
                    ? `${p.testResult.count} match${p.testResult.count !== 1 ? 'es' : ''}: ${p.testResult.matches.slice(0, 5).join(', ')}${p.testResult.matches.length > 5 ? '\u2026' : ''}`
                    : 'No matches found'}
                </span>
              )}
            </div>
          </div>

          {p.addRuleError && (
            <div style={{ color: 'var(--reject)', fontSize: 'var(--font-size-small)' }}>{p.addRuleError}</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
            <button onClick={() => p.setShowAddForm(false)}>Cancel</button>
            <button
              className="primary"
              onClick={p.onAddRule}
              disabled={!p.newName.trim() || !p.newPattern.trim() || p.addingRule}
              style={{ padding: 'var(--space-2) var(--space-4)' }}
            >
              {p.addingRule ? 'Saving\u2026' : 'Save Rule'}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

// ── Rule row ──────────────────────────────────────────────────────────────────

function RuleRow({
  rule,
  readOnly = false,
  onToggle,
  onDelete,
}: {
  rule: Rule
  readOnly?: boolean
  onToggle?: (enabled: boolean) => void
  onDelete?: () => void
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-3)',
      padding: 'var(--space-2) 0',
      borderBottom: '1px solid var(--border)',
      opacity: rule.enabled ? 1 : 0.45,
    }}>
      {!readOnly && (
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onToggle?.(e.target.checked)}
          title={rule.enabled ? 'Disable rule' : 'Enable rule'}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)' }}>{rule.name}</div>
        {rule.pattern && (
          <code style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
            {rule.pattern}
          </code>
        )}
      </div>
      <LabelBadge label={rule.label} />
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {Math.round(rule.confidence * 100)}%
      </span>
      {!readOnly && (
        <button
          className="modal-close"
          onClick={onDelete}
          title="Delete rule"
          style={{ width: 24, height: 24 }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

// ── Per-type confidence overrides ──────────────────────────────────────────

function PerTypeOverrides({
  overrides,
  globalThreshold,
  onChange,
}: {
  overrides: Record<string, number>
  globalThreshold: number
  onChange: (overrides: Record<string, number>) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const getVal = (key: string) => overrides[key] ?? globalThreshold

  const setVal = (key: string, val: number) => {
    onChange({ ...overrides, [key]: val })
  }

  const resetVal = (key: string) => {
    const next = { ...overrides }
    delete next[key]
    onChange(next)
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none', border: 'none', color: 'var(--accent)',
          cursor: 'pointer', padding: 0, fontSize: 'var(--font-size-small)',
          textDecoration: 'underline',
        }}
      >
        {expanded ? 'Hide per-type overrides' : 'Show per-type overrides'}
      </button>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
          {OVERRIDE_TYPES.map(({ key, label }) => {
            const val = getVal(key)
            const isOverridden = key in overrides
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <span style={{
                  width: 90, fontSize: 'var(--font-size-small)',
                  color: isOverridden ? 'var(--text)' : 'var(--text-muted)',
                  fontWeight: isOverridden ? 600 : 400,
                }}>
                  {label}
                </span>
                <input
                  type="range" min={0} max={1} step={0.01}
                  value={val}
                  onChange={(e) => setVal(key, parseFloat(e.target.value))}
                  style={{ flex: 1, '--value-pct': rangePct(val, 0, 1) } as React.CSSProperties}
                />
                <span style={{ minWidth: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--font-size-small)' }}>
                  {val.toFixed(2)}
                </span>
                {isOverridden && (
                  <button
                    onClick={() => resetVal(key)}
                    title="Reset to global threshold"
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0 2px', fontSize: 'var(--font-size-xs)' }}
                  >
                    reset
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── GPU Tab ───────────────────────────────────────────────────────────────────

function GpuTab({ data, loading }: { data: any; loading: boolean }) {
  if (loading) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-body)' }}>Loading diagnostics&hellip;</div>
  }
  if (!data) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-body)' }}>Failed to load diagnostics.</div>
  }

  const gpu = data.gpu
  const vram = data.vram
  const pytorch = data.pytorch
  const ffmpeg = data.ffmpeg
  const system = data.system

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      {/* GPU */}
      <section>
        <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', marginBottom: 'var(--space-2)' }}>GPU</div>
        <InfoRow label="Device" value={gpu?.display_name ?? 'None detected'} />
        <InfoRow label="Vendor" value={gpu?.vendor ?? 'none'} />
        <StatusRow label="CUDA" available={gpu?.cuda_available} version={gpu?.cuda_version} />
        <StatusRow label="MPS (Metal)" available={gpu?.mps_available} />
        <StatusRow label="ROCm" available={gpu?.rocm_available} />
        <StatusRow label="DirectML" available={gpu?.directml_available} />
        <InfoRow label="HW Encoder" value={gpu?.hw_encoder ?? 'None (CPU encoding)'} />
      </section>

      {/* VRAM */}
      {vram && (
        <section>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', marginBottom: 'var(--space-2)' }}>VRAM</div>
          <InfoRow label="Total" value={`${vram.total_mb} MB`} />
          <InfoRow label="Allocated" value={`${vram.allocated_mb} MB`} />
          <InfoRow label="Free" value={`${vram.free_mb} MB`} />
          <div style={{ marginTop: 'var(--space-2)' }}>
            <div className="progress-track" style={{ height: 8 }}>
              <div className="progress-fill" style={{ width: `${vram.total_mb > 0 ? Math.round((vram.allocated_mb / vram.total_mb) * 100) : 0}%` }} />
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}>
              {vram.total_mb > 0 ? Math.round((vram.allocated_mb / vram.total_mb) * 100) : 0}% used
            </div>
          </div>
        </section>
      )}

      {/* PyTorch */}
      {pytorch && (
        <section>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', marginBottom: 'var(--space-2)' }}>PyTorch</div>
          <InfoRow label="Version" value={pytorch.version} />
          {pytorch.cuda_version && <InfoRow label="CUDA Toolkit" value={pytorch.cuda_version} />}
          {pytorch.cudnn_version && <InfoRow label="cuDNN" value={pytorch.cudnn_version} />}
          {pytorch.hip_version && <InfoRow label="HIP (ROCm)" value={pytorch.hip_version} />}
        </section>
      )}

      {/* FFmpeg */}
      {ffmpeg && (
        <section>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', marginBottom: 'var(--space-2)' }}>FFmpeg</div>
          {ffmpeg.version && <InfoRow label="Version" value={ffmpeg.version} />}
          <StatusRow label="h264_nvenc" available={ffmpeg.h264_nvenc} />
          <StatusRow label="h264_amf" available={ffmpeg.h264_amf} />
          <StatusRow label="h264_videotoolbox" available={ffmpeg.h264_videotoolbox} />
          <StatusRow label="libx264" available={ffmpeg.libx264} />
        </section>
      )}

      {/* System */}
      {system && (
        <section>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', marginBottom: 'var(--space-2)' }}>System</div>
          <InfoRow label="OS" value={system.os} />
          <InfoRow label="Python" value={system.python} />
          {system.cpu && <InfoRow label="CPU" value={system.cpu} />}
          {system.ram_gb && <InfoRow label="RAM" value={`${system.ram_gb} GB`} />}
        </section>
      )}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: 'var(--space-1) 0', fontSize: 'var(--font-size-small)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span>{value}</span>
    </div>
  )
}

function StatusRow({ label, available, version }: { label: string; available?: boolean; version?: string | null }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--space-1) 0', fontSize: 'var(--font-size-small)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: available ? 'var(--accept)' : 'var(--reject)', display: 'inline-block' }} />
        <span>{available ? (version ? `Available (${version})` : 'Available') : 'Not available'}</span>
      </span>
    </div>
  )
}

// ── Field helper ──────────────────────────────────────────────────────────────

function Field({
  label, hint, compact, children, style,
}: {
  label: string
  hint?: string
  compact?: boolean
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 'var(--space-1)' : 'var(--space-2)', ...style }}>
      <label style={{ fontSize: 'var(--font-size-small)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </label>
      {children}
      {hint && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>{hint}</div>}
    </div>
  )
}

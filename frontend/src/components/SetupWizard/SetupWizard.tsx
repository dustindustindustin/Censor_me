import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Cpu, MonitorSmartphone, Zap } from 'lucide-react'
import logoSrc from '../../assets/logo.svg'

interface SetupWizardProps {
  gpuDetected: boolean
  gpuVendor: string
  gpuName: string | null
  onComplete: () => void
}

type Step = 'welcome' | 'gpu-detect' | 'gpu-select' | 'progress' | 'complete'

interface GpuOption {
  id: string
  label: string
  description: string
  icon: typeof Zap
}

const GPU_OPTIONS: GpuOption[] = [
  { id: 'cuda', label: 'NVIDIA CUDA', description: 'For NVIDIA GPUs (GTX/RTX)', icon: Zap },
  { id: 'rocm', label: 'AMD ROCm', description: 'For AMD GPUs on Linux', icon: Zap },
  { id: 'directml', label: 'DirectML', description: 'For AMD/Intel GPUs on Windows', icon: MonitorSmartphone },
  { id: 'mps', label: 'Apple Metal', description: 'Built-in on Apple Silicon (no download)', icon: Zap },
  { id: 'cpu', label: 'CPU Only', description: 'No GPU acceleration (slower but works everywhere)', icon: Cpu },
]

export function SetupWizard({ gpuDetected, gpuVendor, gpuName, onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>('welcome')
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [progressLines, setProgressLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // Auto-select the best GPU option based on detection
  useEffect(() => {
    if (gpuVendor === 'nvidia') setSelectedProvider('cuda')
    else if (gpuVendor === 'amd') {
      const isLinux = navigator.platform.toLowerCase().includes('linux')
      setSelectedProvider(isLinux ? 'rocm' : 'directml')
    } else if (gpuVendor === 'apple') setSelectedProvider('mps')
    else setSelectedProvider('cpu')
  }, [gpuVendor])

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [progressLines])

  const startInstall = useCallback(() => {
    setStep('progress')
    setProgressLines([])
    setError(null)

    const IS_TAURI = '__TAURI_INTERNALS__' in window
    const port = 8010 // Will be overridden by the actual port in Tauri mode
    const base = IS_TAURI ? `ws://127.0.0.1:${port}` : window.location.origin.replace(/^http/, 'ws')
    const wsPath = IS_TAURI
      ? `${base}/system/setup/install-gpu?provider=${selectedProvider}`
      : `${base}/ws/system/setup/install-gpu?provider=${selectedProvider}`

    const ws = new WebSocket(wsPath)

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.stage === 'progress') {
        setProgressLines((prev) => [...prev, data.line])
      } else if (data.stage === 'installing' || data.stage === 'installed' || data.stage === 'skip') {
        setProgressLines((prev) => [...prev, data.message])
      } else if (data.stage === 'done') {
        setStep('complete')
      } else if (data.stage === 'error') {
        setError(data.message)
      }
    }

    ws.onerror = () => {
      setError('WebSocket connection failed. Is the backend running?')
    }
  }, [selectedProvider])

  const handleComplete = async () => {
    try {
      const IS_TAURI = '__TAURI_INTERNALS__' in window
      const base = IS_TAURI ? `http://127.0.0.1:8010` : '/api'
      await fetch(`${base}/system/setup/complete`, { method: 'POST' })
    } catch {
      // Non-fatal — worst case the wizard shows again next launch
    }
    onComplete()
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', gap: 'var(--space-6)',
      padding: 'var(--space-6)',
    }}>
      <img src={logoSrc} alt="Censor Me" style={{ height: 48, marginBottom: 'var(--space-2)' }} />

      {step === 'welcome' && (
        <div style={{ textAlign: 'center', maxWidth: 500 }}>
          <h2 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-3)' }}>
            Welcome to Censor Me
          </h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-6)' }}>
            Let's set up GPU acceleration for faster video processing.
            This only needs to happen once.
          </p>
          <button className="primary" onClick={() => setStep('gpu-detect')}
            style={{ padding: 'var(--space-3) var(--space-8)' }}>
            Get Started
          </button>
        </div>
      )}

      {step === 'gpu-detect' && (
        <div style={{ textAlign: 'center', maxWidth: 500 }}>
          <h2 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-3)' }}>
            GPU Detection
          </h2>
          {gpuDetected ? (
            <div style={{ color: 'var(--accept)', marginBottom: 'var(--space-4)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)' }}>
              <Check size={16} /> Detected: {gpuName || gpuVendor}
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-4)' }}>
              No GPU detected. You can still use CPU-only mode.
            </div>
          )}
          <button className="primary" onClick={() => setStep('gpu-select')}
            style={{ padding: 'var(--space-3) var(--space-8)' }}>
            Continue
          </button>
        </div>
      )}

      {step === 'gpu-select' && (
        <div style={{ maxWidth: 500, width: '100%' }}>
          <h2 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-3)', textAlign: 'center' }}>
            Select GPU Provider
          </h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-4)', textAlign: 'center', fontSize: 'var(--font-size-small)' }}>
            Choose the GPU acceleration backend to install.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {GPU_OPTIONS.map((opt) => (
              <div
                key={opt.id}
                onClick={() => setSelectedProvider(opt.id)}
                style={{
                  padding: 'var(--space-3) var(--space-4)',
                  borderRadius: 'var(--radius-md)',
                  border: `2px solid ${selectedProvider === opt.id ? 'var(--accent)' : 'var(--border)'}`,
                  background: selectedProvider === opt.id ? 'rgba(171, 9, 83, 0.1)' : 'var(--surface)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                }}
              >
                <opt.icon size={20} style={{ color: selectedProvider === opt.id ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 500 }}>{opt.label}</div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>{opt.description}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
            <button className="primary" onClick={startInstall} disabled={!selectedProvider}
              style={{ padding: 'var(--space-3) var(--space-8)' }}>
              {selectedProvider === 'cpu' || selectedProvider === 'mps' ? 'Continue' : 'Install'}
            </button>
          </div>
        </div>
      )}

      {step === 'progress' && (
        <div style={{ maxWidth: 600, width: '100%' }}>
          <h2 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-3)', textAlign: 'center' }}>
            {error ? 'Installation Failed' : 'Installing...'}
          </h2>
          <div
            ref={logRef}
            style={{
              background: '#0a0a0f', borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3)', height: 300, overflow: 'auto',
              fontSize: 'var(--font-size-xs)', fontFamily: 'monospace',
              color: 'var(--text-muted)', border: '1px solid var(--border)',
            }}
          >
            {progressLines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          {error && (
            <div style={{ color: 'var(--reject)', marginTop: 'var(--space-3)', textAlign: 'center' }}>
              {error}
              <div style={{ marginTop: 'var(--space-3)' }}>
                <button className="secondary" onClick={() => setStep('gpu-select')}
                  style={{ padding: 'var(--space-2) var(--space-4)' }}>
                  Try Again
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {step === 'complete' && (
        <div style={{ textAlign: 'center', maxWidth: 500 }}>
          <div style={{ color: 'var(--accept)', marginBottom: 'var(--space-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)' }}>
            <Check size={24} />
          </div>
          <h2 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-3)' }}>
            Setup Complete
          </h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-6)' }}>
            GPU acceleration is ready. You can start processing videos now.
          </p>
          <button className="primary" onClick={handleComplete}
            style={{ padding: 'var(--space-3) var(--space-8)' }}>
            Get Started
          </button>
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import logoSrc from '../../assets/logo.svg'
import { getSystemDiagnostics } from '../../api/client'

interface AboutDialogProps {
  onClose: () => void
}

export function AboutDialog({ onClose }: AboutDialogProps) {
  const [diagnostics, setDiagnostics] = useState<any>(null)

  useEffect(() => {
    getSystemDiagnostics().then(setDiagnostics).catch(console.error)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.6)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--surface)', borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-6)', width: 380, maxWidth: '90vw',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
          <img src={logoSrc} alt="Censor Me" style={{ height: 32 }} />
          <button className="ghost" onClick={onClose} style={{ padding: 'var(--space-1)', minHeight: 'auto' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div><strong>Version:</strong> 1.0.0</div>
          {diagnostics?.gpu && (
            <div><strong>GPU:</strong> {diagnostics.gpu.display_name}</div>
          )}
          {diagnostics?.pytorch && (
            <div><strong>PyTorch:</strong> {diagnostics.pytorch.version}</div>
          )}
          {diagnostics?.ffmpeg && (
            <div><strong>FFmpeg:</strong> {diagnostics.ffmpeg.version?.split(' ').slice(0, 3).join(' ') ?? 'Unknown'}</div>
          )}
          {diagnostics?.system && (
            <>
              <div><strong>OS:</strong> {diagnostics.system.os}</div>
              <div><strong>Python:</strong> {diagnostics.system.python}</div>
              {diagnostics.system.ram_gb && <div><strong>RAM:</strong> {diagnostics.system.ram_gb} GB</div>}
            </>
          )}
        </div>

        <div style={{ marginTop: 'var(--space-4)', fontSize: 'var(--font-size-xs)', color: 'var(--text-disabled)', textAlign: 'center' }}>
          Local GPU-accelerated video PII redaction
        </div>
      </div>
    </div>
  )
}

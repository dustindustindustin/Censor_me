/**
 * Root App component.
 *
 * Handles:
 * - Startup polling until the backend is ready (models loaded, ffmpeg verified)
 * - Project selector screen when no project is open
 * - Three-pane layout once a project is loaded
 */

import { useEffect, useRef, useState } from 'react'
import { createProject, getActiveScan, getProject, getSystemStatus, listProjects } from './api/client'
import { FindingsPanel } from './components/FindingsPanel/FindingsPanel'
import { Inspector } from './components/Inspector/Inspector'
import { SettingsModal } from './components/Settings/SettingsModal'
import { VideoPreview } from './components/VideoPreview/VideoPreview'
import { useProjectStore } from './store/projectStore'
import type { Project, SystemStatus } from './types'

export default function App() {
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null)
  const [initMessage, setInitMessage] = useState('Connecting to backend…')
  const [initError, setInitError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const { project, setProject, clearProject, setScanId } = useProjectStore((s) => ({
    project: s.project,
    setProject: s.setProject,
    clearProject: s.clearProject,
    setScanId: s.setScanId,
  }))

  // Wrapper around setProject that also reconnects to any in-progress scan.
  // Called when the user opens a project from the selector — handles the case
  // where they navigated away mid-scan and need to reattach to the WebSocket.
  const handleOpenProject = async (p: Project) => {
    setProject(p)
    const active = await getActiveScan(p.project_id)
    if (active) {
      setScanId(active.scan_id)
    }
  }
  const videoRef = useRef<HTMLVideoElement>(null)

  // Poll backend until ready (models downloaded and initialized)
  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      let attempts = 0
      while (!cancelled) {
        try {
          const status: SystemStatus = await getSystemStatus()
          if (status.ready) {
            if (!cancelled) {
              setSystemStatus(status)
            }
            break
          }
          setInitMessage('Initializing models…')
        } catch {
          attempts++
          if (attempts > 5) {
            setInitMessage('Waiting for backend to start…')
          }
          if (attempts > 30) {
            setInitError('Backend not responding. Make sure uvicorn is running on port 8010.')
            break
          }
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    poll()
    return () => { cancelled = true }
  }, [])

  // Update browser tab title
  useEffect(() => {
    document.title = project ? `${project.name} — Censor Me` : 'Censor Me'
  }, [project?.name])

  if (!systemStatus) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 'var(--space-4)' }}>
        <div style={{ fontSize: 'var(--font-size-title)', fontWeight: 600, color: 'var(--accent)' }}>Censor Me</div>
        {initError ? (
          <div style={{ color: 'var(--reject)', fontSize: 'var(--font-size-body)', maxWidth: 400, textAlign: 'center' }}>{initError}</div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-body)' }}>{initMessage}</div>
        )}
      </div>
    )
  }

  if (!project) {
    return (
      <ProjectSelector
        gpuDisplay={systemStatus.gpu.display_name}
        onOpen={handleOpenProject}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Status bar */}
      <div style={{
        padding: 'var(--space-2) var(--space-4)',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border-hairline)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        fontSize: 'var(--font-size-body)',
      }}>
        <span style={{ fontWeight: 600, color: 'var(--accent)', cursor: 'pointer' }} onClick={clearProject} title="Back to project list">
          Censor Me
        </span>
        <span style={{ color: 'var(--text-disabled)' }}>›</span>
        <span>{project.name}</span>
        {project.video && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
            {project.video.width}×{project.video.height} · {project.video.fps.toFixed(0)} fps · {project.video.codec}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {systemStatus.gpu.cuda_available && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
              ⚡ {systemStatus.gpu.gpu_name}
            </span>
          )}
          <button
            className="ghost"
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{ fontSize: 16, lineHeight: 1, padding: 'var(--space-1)', minHeight: 'auto' }}
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Three-pane layout */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <FindingsPanel style={{ width: 280, flexShrink: 0 }} />
        <VideoPreview videoRef={videoRef} style={{ flex: 1, minWidth: 0 }} />
        <Inspector style={{ width: 300, flexShrink: 0 }} />
      </div>

      {showSettings && (
        <SettingsModal
          projectId={project.project_id}
          initialScanSettings={project.scan_settings}
          initialOutputSettings={project.output_settings}
          gpuAvailable={systemStatus.gpu.cuda_available}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

// ── Project Selector ──────────────────────────────────────────────────────────

interface ProjectSelectorProps {
  gpuDisplay: string
  onOpen: (p: Project) => void
}

function ProjectSelector({ gpuDisplay, onOpen }: ProjectSelectorProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listProjects().then(setProjects).catch(console.error)
  }, [])

  const handleNew = async () => {
    const name = prompt('Project name:', 'Untitled Project')
    if (!name) return
    setLoading(true)
    setError(null)
    try {
      const { project_id } = await createProject(name)
      const p = await getProject(project_id)
      onOpen(p)
    } catch {
      setError('Failed to create project.')
    } finally {
      setLoading(false)
    }
  }

  const handleOpen = async (projectId: string) => {
    try {
      const p = await getProject(projectId)
      onOpen(p)
    } catch {
      setError('Failed to open project.')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 'var(--space-6)' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 'var(--font-size-title)', fontWeight: 600, color: 'var(--accent)' }}>Censor Me</div>
        <div style={{ color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>Local GPU-accelerated video PII redaction</div>
        <div style={{ color: 'var(--text-disabled)', fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-1)' }}>⚡ {gpuDisplay}</div>
      </div>

      {error && <div style={{ color: 'var(--reject)', fontSize: 'var(--font-size-body)' }}>{error}</div>}

      <button
        className="primary"
        onClick={handleNew}
        disabled={loading}
        style={{ padding: 'var(--space-3) var(--space-8)', fontSize: 'var(--font-size-body)' }}
      >
        {loading ? 'Creating…' : '+ New Project'}
      </button>

      {projects.length > 0 && (
        <div style={{ width: 420 }}>
          <div style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)', fontSize: 'var(--font-size-small)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Recent Projects
          </div>
          {projects.map((p) => (
            <div
              key={p.project_id}
              onClick={() => handleOpen(p.project_id)}
              style={{
                padding: 'var(--space-3) var(--space-4)',
                background: 'var(--surface)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 'var(--space-2)',
                cursor: 'pointer',
                border: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                transition: 'all var(--transition-fast)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; e.currentTarget.style.background = 'var(--surface-secondary)' }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--surface)' }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>{p.name}</div>
                {p.video && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', marginTop: 2 }}>
                    {p.video.width}×{p.video.height} · {(p.video.duration_ms / 60000).toFixed(1)} min
                  </div>
                )}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
                {new Date(p.updated_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

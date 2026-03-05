/**
 * Root App component.
 *
 * Handles:
 * - Startup polling until the backend is ready (models loaded, ffmpeg verified)
 * - Project selector screen when no project is open
 * - Three-pane layout once a project is loaded
 */

import { useEffect, useRef, useState } from 'react'
import { createProject, getProject, getSystemStatus, listProjects } from './api/client'
import { FindingsPanel } from './components/FindingsPanel/FindingsPanel'
import { Inspector } from './components/Inspector/Inspector'
import { VideoPreview } from './components/VideoPreview/VideoPreview'
import { useProjectStore } from './store/projectStore'
import type { Project, SystemStatus } from './types'

export default function App() {
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null)
  const [initMessage, setInitMessage] = useState('Connecting to backend…')
  const [initError, setInitError] = useState<string | null>(null)
  const { project, setProject, clearProject } = useProjectStore((s) => ({
    project: s.project,
    setProject: s.setProject,
    clearProject: s.clearProject,
  }))
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
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--accent)' }}>Censor Me</div>
        {initError ? (
          <div style={{ color: 'var(--reject)', fontSize: 13, maxWidth: 400, textAlign: 'center' }}>{initError}</div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{initMessage}</div>
        )}
      </div>
    )
  }

  if (!project) {
    return (
      <ProjectSelector
        gpuDisplay={systemStatus.gpu.display_name}
        onOpen={setProject}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Status bar */}
      <div style={{
        padding: '5px 14px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 13,
      }}>
        <span style={{ fontWeight: 700, color: 'var(--accent)', cursor: 'pointer' }} onClick={clearProject} title="Back to project list">
          Censor Me
        </span>
        <span style={{ color: 'var(--border)' }}>›</span>
        <span>{project.name}</span>
        {systemStatus.gpu.cuda_available && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
            ⚡ {systemStatus.gpu.gpu_name}
          </span>
        )}
      </div>

      {/* Three-pane layout */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <FindingsPanel style={{ width: 280, flexShrink: 0 }} />
        <VideoPreview videoRef={videoRef} style={{ flex: 1, minWidth: 0 }} />
        <Inspector style={{ width: 300, flexShrink: 0 }} />
      </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 24 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 36, fontWeight: 800, color: 'var(--accent)', letterSpacing: '-0.5px' }}>Censor Me</div>
        <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>Local GPU-accelerated video PII redaction</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>⚡ {gpuDisplay}</div>
      </div>

      {error && <div style={{ color: 'var(--reject)', fontSize: 13 }}>{error}</div>}

      <button
        className="primary"
        onClick={handleNew}
        disabled={loading}
        style={{ padding: '10px 28px', fontSize: 15 }}
      >
        {loading ? 'Creating…' : '+ New Project'}
      </button>

      {projects.length > 0 && (
        <div style={{ width: 420 }}>
          <div style={{ color: 'var(--text-muted)', marginBottom: 8, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Recent Projects
          </div>
          {projects.map((p) => (
            <div
              key={p.project_id}
              onClick={() => handleOpen(p.project_id)}
              style={{
                padding: '11px 14px',
                background: 'var(--surface)',
                borderRadius: 6,
                marginBottom: 6,
                cursor: 'pointer',
                border: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                {p.video && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>
                    {p.video.width}×{p.video.height} · {(p.video.duration_ms / 60000).toFixed(1)} min
                  </div>
                )}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {new Date(p.updated_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

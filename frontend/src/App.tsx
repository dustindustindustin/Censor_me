/**
 * Root App component.
 *
 * Handles:
 * - Startup polling until the backend is ready (models loaded, ffmpeg verified)
 * - Project selector screen when no project is open
 * - Three-pane layout once a project is loaded
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, Layers, Plus, Settings, Trash2, Zap } from 'lucide-react'
import logoSrc from './assets/logo.svg'
import { createProject, deleteProject, getActiveExport, getActiveScan, getProject, getSetupStatus, getSystemStatus, listProjects, renameProject } from './api/client'
import { AboutDialog } from './components/AboutDialog/AboutDialog'
import { SetupWizard } from './components/SetupWizard/SetupWizard'
import { BatchPanel } from './components/BatchPanel/BatchPanel'
import { ToastContainer } from './components/ToastContainer'
import { FindingsPanel } from './components/FindingsPanel/FindingsPanel'
import { Inspector } from './components/Inspector/Inspector'
import { SettingsModal } from './components/Settings/SettingsModal'
import { VideoPreview } from './components/VideoPreview/VideoPreview'
import { useProjectStore } from './store/projectStore'
import type { Project, SystemStatus } from './types'

export default function App() {
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null)
  const [initMessage, setInitMessage] = useState('Connecting to backend\u2026')
  const [initError, setInitError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showBatch, setShowBatch] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [setupNeeded, setSetupNeeded] = useState<null | { gpu_detected: boolean; gpu_vendor: string; gpu_name: string | null }>(null)
  const { project, setProject, clearProject, setScanId, setExportId, scanProgress, exportId } = useProjectStore((s) => ({
    project: s.project,
    setProject: s.setProject,
    clearProject: s.clearProject,
    setScanId: s.setScanId,
    setExportId: s.setExportId,
    scanProgress: s.scanProgress,
    exportId: s.exportId,
  }))

  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)

  const handleRenameProject = async () => {
    const name = draftName.trim()
    setEditingName(false)
    if (!name || name === project?.name) return
    try {
      await renameProject(project!.project_id, name)
      setProject({ ...project!, name })
    } catch {
      // silently revert — name in store stays as the original
    }
  }

  const handleDeleteProject = async () => {
    if (!project) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteProject(project.project_id)
      clearProject()
      setShowDeleteConfirm(false)
    } catch {
      setDeleteError('Failed to delete project. Try again.')
    } finally {
      setDeleting(false)
    }
  }

  // Wrapper around setProject that also reconnects to any in-progress scan or export.
  // Called when the user opens a project from the selector — handles the case
  // where they navigated away mid-scan/export and need to reattach to the WebSocket.
  const handleOpenProject = async (p: Project) => {
    setProject(p)
    // Reconnect scan (runs concurrently with export check)
    const [activeScan, activeExport] = await Promise.all([
      getActiveScan(p.project_id),
      getActiveExport(p.project_id),
    ])
    if (activeScan) setScanId(activeScan.scan_id)
    if (activeExport) setExportId(activeExport.export_id)
  }

  // Guard navigation away from an active project during scan or export.
  const isWorkActive = scanProgress.isRunning || exportId !== null
  const handleBackToProjects = () => {
    if (isWorkActive) {
      setShowLeaveConfirm(true)
    } else {
      clearProject()
    }
  }

  // Warn on browser tab close / refresh while work is active.
  useEffect(() => {
    if (!isWorkActive) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isWorkActive])
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
              // Check first-run setup status in Tauri mode
              if ('__TAURI_INTERNALS__' in window) {
                try {
                  const setupStatus = await getSetupStatus()
                  if (!setupStatus.complete) {
                    setSetupNeeded({
                      gpu_detected: setupStatus.gpu_detected,
                      gpu_vendor: setupStatus.gpu_vendor,
                      gpu_name: setupStatus.gpu_name,
                    })
                  }
                } catch { /* setup check is best-effort */ }
              }
            }
            break
          }
          const stageMessages: Record<string, string> = {
            loading_ocr: 'Loading OCR model\u2026',
            loading_nlp: 'Loading NLP model\u2026',
            error: 'Backend initialization failed.',
          }
          setInitMessage(stageMessages[status.stage ?? ''] ?? 'Initializing models\u2026')
        } catch {
          attempts++
          if (attempts > 5) {
            setInitMessage('Waiting for backend to start\u2026')
          }
          if (attempts > 30) {
            setInitError(
              'Backend is not responding. Check that the backend server is running ' +
              '(uvicorn backend.main:app --port 8010), verify PyTorch is installed ' +
              '(scripts\\install-pytorch.ps1), and check the console for errors.'
            )
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
    document.title = project ? `${project.name} \u2014 Censor Me` : 'Censor Me'
  }, [project?.name])

  // Listen for Tauri tray "About" event
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('show:about', () => setShowAbout(true)).then((fn) => { unlisten = fn })
    }).catch(() => {})
    return () => { unlisten?.() }
  }, [])

  if (!systemStatus) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 'var(--space-4)' }}>
        <img src={logoSrc} alt="Censor Me" style={{ width: 'clamp(200px, 40vw, 600px)' }} />
        {initError ? (
          <div style={{ color: 'var(--reject)', fontSize: 'var(--font-size-body)', maxWidth: 400, textAlign: 'center' }}>{initError}</div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-body)' }}>{initMessage}</div>
        )}
      </div>
    )
  }

  if (setupNeeded) {
    return (
      <SetupWizard
        gpuDetected={setupNeeded.gpu_detected}
        gpuVendor={setupNeeded.gpu_vendor}
        gpuName={setupNeeded.gpu_name}
        onComplete={() => setSetupNeeded(null)}
      />
    )
  }

  if (showBatch) {
    return (
      <BatchPanel
        defaultScanSettings={{
          preset: 'screen_recording_pii',
          ocr_sample_interval: 5,
          ocr_resolution_scale: 1.0,
          confidence_threshold: 0.35,
          entity_confidence_overrides: {},
          detect_faces: true,
          secure_mode: false,
          default_redaction_style: { type: 'blur', strength: 15, color: '#000000' },
        }}
        defaultOutputSettings={{
          codec: 'h264',
          container_format: 'mp4',
          resolution: 'original',
          custom_width: null,
          custom_height: null,
          quality_mode: 'crf',
          crf: 18,
          bitrate_kbps: null,
          use_hw_encoder: true,
          watermark: false,
        }}
        onClose={() => setShowBatch(false)}
      />
    )
  }

  if (!project) {
    return (
      <ProjectSelector
        gpuDisplay={systemStatus.gpu.display_name}
        onOpen={handleOpenProject}
        onBatch={() => setShowBatch(true)}
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
        <button
          className="ghost"
          onClick={handleBackToProjects}
          title="Back to project list"
          style={{ padding: 'var(--space-1) var(--space-2)', minHeight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--font-size-small)', color: 'var(--text-muted)' }}
        >
          <ArrowLeft size={14} /> Projects
        </button>
        <ChevronRight size={14} style={{ color: 'var(--text-disabled)' }} />
        {editingName ? (
          <input
            ref={nameInputRef}
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameProject()
              if (e.key === 'Escape') setEditingName(false)
            }}
            onBlur={handleRenameProject}
            autoFocus
            style={{
              fontSize: 'var(--font-size-body)',
              background: 'var(--bg)',
              border: '1px solid var(--accent)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text)',
              padding: '2px 6px',
              width: Math.max(120, draftName.length * 9),
            }}
          />
        ) : (
          <span
            onClick={() => { setDraftName(project.name); setEditingName(true) }}
            title="Click to rename"
            style={{ cursor: 'text', borderBottom: '1px dashed transparent' }}
            onMouseOver={(e) => (e.currentTarget.style.borderBottomColor = 'var(--text-disabled)')}
            onMouseOut={(e) => (e.currentTarget.style.borderBottomColor = 'transparent')}
          >
            {project.name}
          </span>
        )}
        {project.video && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
            {project.video.width}&times;{project.video.height} &middot; {project.video.fps.toFixed(0)} fps &middot; {project.video.codec}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {systemStatus.gpu.gpu_available && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
              <Zap size={12} /> {systemStatus.gpu.gpu_name}
            </span>
          )}
          <button
            className="ghost"
            onClick={() => { setShowDeleteConfirm(true); setDeleteError(null) }}
            title="Delete this project"
            style={{ padding: 'var(--space-1)', minHeight: 'auto', display: 'flex', alignItems: 'center', color: 'var(--text-muted)' }}
          >
            <Trash2 size={15} />
          </button>
          <button
            className="ghost"
            onClick={() => setShowSettings(true)}
            data-tooltip="Settings"
            style={{ padding: 'var(--space-1)', minHeight: 'auto', display: 'flex', alignItems: 'center' }}
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Delete project confirmation modal */}
      {showDeleteConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowDeleteConfirm(false) }}
        >
          <div className="glass" style={{
            width: 420, padding: 'var(--space-6)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-elevated)',
            display: 'flex', flexDirection: 'column', gap: 'var(--space-4)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <Trash2 size={20} style={{ color: 'var(--reject)', flexShrink: 0 }} />
              <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)' }}>Delete Project?</span>
            </div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              This will remove <strong style={{ color: 'var(--text)' }}>{project.name}</strong> from Censor Me
              and delete its scan data and proxy preview.
            </div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Your <strong style={{ color: 'var(--text)' }}>source video</strong> and any <strong style={{ color: 'var(--text)' }}>exported redacted videos</strong> will not be deleted.
            </div>
            {deleteError && (
              <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--reject)' }}>{deleteError}</div>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
              <button
                className="secondary"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteProject}
                disabled={deleting}
                style={{
                  padding: 'var(--space-2) var(--space-4)',
                  background: 'var(--reject)', color: '#fff',
                  border: 'none', borderRadius: 'var(--radius-md)',
                  cursor: deleting ? 'wait' : 'pointer',
                  fontSize: 'var(--font-size-body)',
                  display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
                }}
              >
                <Trash2 size={14} /> {deleting ? 'Deleting\u2026' : 'Delete Project'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Leave confirmation modal — shown when navigating away during scan/export */}
      {showLeaveConfirm && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowLeaveConfirm(false) }}
        >
          <div className="glass" style={{
            width: 420, padding: 'var(--space-6)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-elevated)',
            display: 'flex', flexDirection: 'column', gap: 'var(--space-4)',
          }}>
            <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)' }}>
              {scanProgress.isRunning ? 'Scan in progress' : 'Export in progress'}
            </div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {scanProgress.isRunning
                ? 'A scan is currently running. It will continue in the background — you can come back to this project and it will reconnect automatically.'
                : 'An export is currently encoding. It will continue in the background — you can come back to this project and it will reconnect automatically.'}
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setShowLeaveConfirm(false)}>
                Stay here
              </button>
              <button
                className="primary"
                onClick={() => { setShowLeaveConfirm(false); clearProject() }}
              >
                Leave project
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Three-pane layout */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <FindingsPanel style={{ width: 280, flexShrink: 0 }} />
        <VideoPreview videoRef={videoRef} style={{ flex: 1, minWidth: 0 }} />
        <Inspector style={{ width: 300, flexShrink: 0 }} />
      </div>

      <ToastContainer />

      {showSettings && (
        <SettingsModal
          projectId={project.project_id}
          initialScanSettings={project.scan_settings}
          initialOutputSettings={project.output_settings}
          gpuAvailable={systemStatus.gpu.gpu_available}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
    </div>
  )
}

// ── Project Selector ──────────────────────────────────────────────────────────

interface ProjectSelectorProps {
  gpuDisplay: string
  onOpen: (p: Project) => void
  onBatch: () => void
}

function ProjectSelector({ gpuDisplay, onOpen, onBatch }: ProjectSelectorProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('Untitled Project')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listProjects().then(setProjects).catch(() => {
      setError('Failed to load projects — backend may be unavailable')
    })
  }, [])

  useEffect(() => {
    if (showNewProject) inputRef.current?.select()
  }, [showNewProject])

  const handleDeleteFromSelector = async (e: React.MouseEvent, projectId: string, name: string) => {
    e.stopPropagation()
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return
    setDeletingId(projectId)
    try {
      await deleteProject(projectId)
      setProjects((prev) => prev.filter((p) => p.project_id !== projectId))
    } catch {
      setError('Failed to delete project.')
    } finally {
      setDeletingId(null)
    }
  }

  const handleCreate = async () => {
    const name = newProjectName.trim()
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
        <img src={logoSrc} alt="Censor Me" style={{ height: 64 }} />
        <div style={{ color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>Local GPU-accelerated video PII redaction</div>
        <div style={{ color: 'var(--text-disabled)', fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-1)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-1)' }}>
          <Zap size={12} /> {gpuDisplay}
        </div>
      </div>

      {error && <div style={{ color: 'var(--reject)', fontSize: 'var(--font-size-body)' }}>{error}</div>}

      {showNewProject ? (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <input
            ref={inputRef}
            type="text"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowNewProject(false) }}
            disabled={loading}
            style={{
              padding: 'var(--space-2) var(--space-3)',
              fontSize: 'var(--font-size-body)',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text)',
              width: 240,
            }}
          />
          <button
            className="primary"
            onClick={handleCreate}
            disabled={loading || !newProjectName.trim()}
            style={{ padding: 'var(--space-2) var(--space-4)' }}
          >
            {loading ? 'Creating\u2026' : 'Create'}
          </button>
          <button
            className="secondary"
            onClick={() => setShowNewProject(false)}
            disabled={loading}
            style={{ padding: 'var(--space-2) var(--space-3)' }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <button
            className="primary"
            onClick={() => setShowNewProject(true)}
            style={{ padding: 'var(--space-3) var(--space-8)', fontSize: 'var(--font-size-body)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}
          >
            <Plus size={16} /> New Project
          </button>
          <button
            className="secondary"
            onClick={onBatch}
            style={{ padding: 'var(--space-3) var(--space-6)', fontSize: 'var(--font-size-body)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}
          >
            <Layers size={16} /> Batch Mode
          </button>
        </div>
      )}

      {projects.length > 0 && (
        <div style={{ width: 420 }}>
          <div style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)', fontSize: 'var(--font-size-small)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Recent Projects
          </div>
          {projects.map((p) => (
            <div
              key={p.project_id}
              className="project-card"
              onClick={() => handleOpen(p.project_id)}
              style={{ position: 'relative' }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>{p.name}</div>
                {p.video && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', marginTop: 2 }}>
                    {p.video.width}&times;{p.video.height} &middot; {(p.video.duration_ms / 60000).toFixed(1)} min
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
                  {new Date(p.updated_at).toLocaleDateString()}
                </div>
                <button
                  onClick={(e) => handleDeleteFromSelector(e, p.project_id, p.name)}
                  disabled={deletingId === p.project_id}
                  title="Delete project"
                  style={{
                    padding: 4, minHeight: 'auto', background: 'transparent', border: 'none',
                    color: 'var(--text-disabled)', cursor: 'pointer', borderRadius: 'var(--radius-sm)',
                    display: 'flex', alignItems: 'center',
                    opacity: deletingId === p.project_id ? 0.4 : 1,
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.color = 'var(--reject)')}
                  onMouseOut={(e) => (e.currentTarget.style.color = 'var(--text-disabled)')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

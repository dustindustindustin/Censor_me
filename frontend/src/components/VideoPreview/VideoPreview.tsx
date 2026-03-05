/**
 * VideoPreview — center pane.
 * Video player, timeline, scan controls, and redaction overlay canvas.
 */

import { useEffect, useRef, useState } from 'react'
import { getProject, importVideo, proxyVideoUrl, startScan } from '../../api/client'
import { useScanProgress } from '../../hooks/useScanProgress'
import { useKeyboard } from '../../hooks/useKeyboard'
import { useProjectStore } from '../../store/projectStore'
import { OverlayCanvas } from './OverlayCanvas'
import { Timeline } from './Timeline'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  style?: React.CSSProperties
}

export function VideoPreview({ videoRef, style }: Props) {
  const {
    project,
    setProject,
    scanProgress,
    setCurrentTimeMs,
    showOcrBoxes,
    showRedactionAreas,
    toggleOcrBoxes,
    toggleRedactionAreas,
  } = useProjectStore((s) => ({
    project: s.project,
    setProject: s.setProject,
    scanProgress: s.scanProgress,
    setCurrentTimeMs: s.setCurrentTimeMs,
    showOcrBoxes: s.showOcrBoxes,
    showRedactionAreas: s.showRedactionAreas,
    toggleOcrBoxes: s.toggleOcrBoxes,
    toggleRedactionAreas: s.toggleRedactionAreas,
  }))

  const [scanId, setScanId] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)

  useScanProgress(scanId)

  useKeyboard({
    projectId: project?.project_id ?? '',
    videoRef,
  })

  // Re-load project after scan finishes to get updated events
  useEffect(() => {
    if (scanProgress.stage === 'done' && project) {
      getProject(project.project_id).then(setProject).catch(console.error)
    }
  }, [scanProgress.stage])

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!project || !e.target.files?.[0]) return
    const file = e.target.files[0]
    setImportError(null)
    setImporting(true)
    try {
      await importVideo(project.project_id, file)
      // Reload project from API to get updated video metadata + proxy path
      const updated = await getProject(project.project_id)
      setProject(updated)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Import failed'
      setImportError(msg)
    } finally {
      setImporting(false)
      // Clear file input so the same file can be re-imported if needed
      e.target.value = ''
    }
  }

  const handleScan = async () => {
    if (!project) return
    try {
      const { scan_id } = await startScan(project.project_id)
      setScanId(scan_id)
    } catch (err: unknown) {
      console.error('Scan failed to start:', err)
    }
  }

  const handleTimeUpdate = () => {
    if (!videoRef.current) return
    const ms = Math.floor(videoRef.current.currentTime * 1000)
    setCurrentTime(ms)
    setCurrentTimeMs(ms)
  }

  const handleSeek = (ms: number) => {
    if (!videoRef.current) return
    videoRef.current.currentTime = ms / 1000
  }

  const proxyUrl = project?.video ? proxyVideoUrl(project.project_id) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: '#111', ...style }}>
      {/* Toolbar */}
      <div style={{ padding: '8px 12px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ cursor: importing ? 'wait' : 'pointer' }}>
          <input
            type="file"
            accept=".mp4,.mov,.mkv,.avi,.webm"
            style={{ display: 'none' }}
            onChange={handleImport}
            disabled={importing}
          />
          <span style={{
            padding: '5px 10px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 13,
            opacity: importing ? 0.6 : 1,
          }}>
            {importing ? 'Importing…' : 'Import Video'}
          </span>
        </label>

        {project?.video && (
          <button
            className="primary"
            onClick={handleScan}
            disabled={scanProgress.isRunning}
          >
            {scanProgress.isRunning
              ? `Scanning… ${scanProgress.progressPct}%`
              : 'Scan for PII'}
          </button>
        )}

        {importError && (
          <span style={{ color: 'var(--reject)', fontSize: 12 }}>{importError}</span>
        )}

        {project?.video && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
            {project.video.width}×{project.video.height} · {project.video.fps.toFixed(0)} fps · {project.video.codec}
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            onClick={toggleOcrBoxes}
            style={{ opacity: showOcrBoxes ? 1 : 0.45, fontSize: 12 }}
            title="Toggle OCR detection boxes"
          >
            OCR boxes
          </button>
          <button
            onClick={toggleRedactionAreas}
            style={{ opacity: showRedactionAreas ? 1 : 0.45, fontSize: 12 }}
            title="Toggle redaction preview"
          >
            Redactions
          </button>
        </div>
      </div>

      {/* Scan progress bar */}
      {scanProgress.isRunning && (
        <div style={{ height: 3, background: 'var(--border)', position: 'relative' }}>
          <div style={{
            position: 'absolute', left: 0, top: 0, height: '100%',
            width: `${scanProgress.progressPct}%`,
            background: 'var(--accent)',
            transition: 'width 0.3s',
          }} />
        </div>
      )}

      {/* Video + overlay */}
      <div
        ref={videoContainerRef}
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}
      >
        {proxyUrl ? (
          <>
            <video
              ref={videoRef}
              src={proxyUrl}
              style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={() => {
                setDuration(Math.floor((videoRef.current?.duration ?? 0) * 1000))
              }}
            />
            <OverlayCanvas
              videoRef={videoRef}
              containerRef={videoContainerRef}
              currentTimeMs={currentTime}
              showRedactions={showRedactionAreas}
            />
          </>
        ) : importing ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>⟳</div>
            <div>Generating proxy video…</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>This may take a minute for large files</div>
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>▶</div>
            <div>Import a video to get started</div>
          </div>
        )}
      </div>

      {/* Timeline */}
      {duration > 0 && (
        <Timeline
          durationMs={duration}
          currentTimeMs={currentTime}
          onSeek={handleSeek}
        />
      )}
    </div>
  )
}

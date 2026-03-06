/**
 * VideoPreview — center pane.
 * Video player, timeline, scan controls, video controls bar, zoom, and redaction overlay canvas.
 */

import { useEffect, useRef, useState } from 'react'
import { getProject, importVideo, proxyVideoUrl, startScan } from '../../api/client'
import { useScanProgress } from '../../hooks/useScanProgress'
import { useKeyboard } from '../../hooks/useKeyboard'
import { useProjectStore } from '../../store/projectStore'
import { FrameTestModal } from './FrameTestModal'
import { OverlayCanvas } from './OverlayCanvas'
import { Timeline } from './Timeline'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  style?: React.CSSProperties
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function VideoPreview({ videoRef, style }: Props) {
  const {
    project,
    setProject,
    scanProgress,
    scanId,
    setScanId,
    setCurrentTimeMs,
    showRedactionAreas,
    toggleRedactionAreas,
    setTestFrameOverlay,
    zoomLevel,
    setZoomLevel,
    drawingMode,
    setDrawingMode,
  } = useProjectStore((s) => ({
    project: s.project,
    setProject: s.setProject,
    scanProgress: s.scanProgress,
    scanId: s.scanId,
    setScanId: s.setScanId,
    setCurrentTimeMs: s.setCurrentTimeMs,
    showRedactionAreas: s.showRedactionAreas,
    toggleRedactionAreas: s.toggleRedactionAreas,
    setTestFrameOverlay: s.setTestFrameOverlay,
    zoomLevel: s.zoomLevel,
    setZoomLevel: s.setZoomLevel,
    drawingMode: s.drawingMode,
    setDrawingMode: s.setDrawingMode,
  }))

  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [showFrameTest, setShowFrameTest] = useState(false)

  // Video controls local state
  const [isPlaying, setIsPlaying] = useState(false)
  const [volume, setVolume] = useState(1)
  const [playbackRate, setPlaybackRate] = useState(1)

  const videoContainerRef = useRef<HTMLDivElement>(null)

  useScanProgress(scanId)

  useKeyboard({
    projectId: project?.project_id ?? '',
    videoRef,
  })

  // Sync isPlaying with video element events
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [videoRef.current])

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
      const updated = await getProject(project.project_id)
      setProject(updated)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Import failed'
      setImportError(msg)
    } finally {
      setImporting(false)
      e.target.value = ''
    }
  }

  const handleScan = async () => {
    if (!project || scanId !== null || scanProgress.isRunning) return
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

  const handlePlayPause = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.play().catch(console.warn)
    } else {
      video.pause()
    }
  }

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    setVolume(v)
    if (videoRef.current) videoRef.current.volume = v
  }

  const handleRate = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const r = parseFloat(e.target.value)
    setPlaybackRate(r)
    if (videoRef.current) videoRef.current.playbackRate = r
  }

  const closeFrameTest = () => {
    setShowFrameTest(false)
    setTestFrameOverlay(null)
  }

  const proxyUrl = project?.video ? proxyVideoUrl(project.project_id) : null

  const isScanPending = scanId !== null && !scanProgress.isRunning
  const isScanRunning = scanProgress.isRunning

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
            cursor: importing ? 'wait' : 'pointer',
            opacity: importing ? 0.6 : 1,
          }}>
            {importing ? 'Importing…' : 'Import Video'}
          </span>
        </label>

        {project?.video && (
          <button
            className="primary"
            onClick={handleScan}
            disabled={isScanPending || isScanRunning}
          >
            {isScanPending
              ? 'Starting…'
              : isScanRunning
              ? `Scanning… ${scanProgress.progressPct}%`
              : 'Scan for PII'}
          </button>
        )}

        {project?.video && (
          <button
            onClick={() => setShowFrameTest(true)}
            disabled={isScanRunning}
            title="Test OCR and PII detection on a single frame"
            style={{ fontSize: 13 }}
          >
            Test Frame
          </button>
        )}

        {project?.video && (
          <button
            onClick={() => setDrawingMode(!drawingMode)}
            title="Draw a manual redaction box on the video"
            style={{
              fontSize: 13,
              background: drawingMode ? 'var(--accent)' : undefined,
              color: drawingMode ? '#fff' : undefined,
              borderColor: drawingMode ? 'var(--accent)' : undefined,
            }}
          >
            {drawingMode ? 'Drawing…' : 'Draw Box'}
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
            onClick={toggleRedactionAreas}
            style={{ opacity: showRedactionAreas ? 1 : 0.45, fontSize: 12 }}
            title="Toggle redaction preview"
          >
            Redactions
          </button>
        </div>
      </div>

      {/* Scan progress bar */}
      {(isScanPending || isScanRunning) && (
        <div style={{ height: 3, background: 'var(--border)', position: 'relative' }}>
          <div style={{
            position: 'absolute', left: 0, top: 0, height: '100%',
            width: isScanPending ? '2%' : `${scanProgress.progressPct}%`,
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
            {/* Zoom wrapper — only the video element is scaled */}
            <div style={{
              transform: `scale(${zoomLevel})`,
              transformOrigin: 'center center',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '100%', height: '100%',
            }}>
              <video
                ref={videoRef}
                src={proxyUrl}
                style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={() => {
                  setDuration(Math.floor((videoRef.current?.duration ?? 0) * 1000))
                }}
              />
            </div>
            {/* Canvas sits OUTSIDE the zoom wrapper so it isn't scaled.
                It uses getBoundingClientRect() on the video (post-transform coords)
                to draw at the correct screen position regardless of zoom level. */}
            <OverlayCanvas
              videoRef={videoRef}
              containerRef={videoContainerRef}
              currentTimeMs={currentTime}
              showRedactions={showRedactionAreas}
              projectId={project?.project_id ?? ''}
              sourceWidth={project?.video?.width ?? 0}
              sourceHeight={project?.video?.height ?? 0}
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

      {/* Video controls bar */}
      {proxyUrl && (
        <div style={{
          padding: '6px 12px',
          background: 'var(--surface)',
          borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
        }}>
          {/* Play/Pause */}
          <button onClick={handlePlayPause} style={{ fontSize: 16, padding: '2px 8px', minWidth: 32 }}>
            {isPlaying ? '⏸' : '▶'}
          </button>

          {/* Time */}
          <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {formatMs(currentTime)} / {formatMs(duration)}
          </span>

          {/* Volume */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Vol</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={volume}
              onChange={handleVolume}
              style={{ width: 72, accentColor: 'var(--accent)' }}
            />
          </div>

          {/* Speed */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Speed</span>
            <select
              value={playbackRate}
              onChange={handleRate}
              style={{ fontSize: 12, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 4px' }}
            >
              {[0.25, 0.5, 0.75, 1, 1.5, 2].map((r) => (
                <option key={r} value={r}>{r}×</option>
              ))}
            </select>
          </div>

          {/* Zoom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
            <button onClick={() => setZoomLevel(Math.max(1, zoomLevel - 0.5))} style={{ fontSize: 14, padding: '1px 7px' }}>−</button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 28, textAlign: 'center' }}>{zoomLevel}×</span>
            <button onClick={() => setZoomLevel(Math.min(4, zoomLevel + 0.5))} style={{ fontSize: 14, padding: '1px 7px' }}>+</button>
          </div>
        </div>
      )}

      {/* Timeline */}
      {duration > 0 && (
        <Timeline
          durationMs={duration}
          currentTimeMs={currentTime}
          onSeek={handleSeek}
        />
      )}

      {/* Frame test modal */}
      {showFrameTest && project?.video && (
        <FrameTestModal
          projectId={project.project_id}
          initialFrameIndex={Math.floor((currentTime / 1000) * project.video.fps)}
          totalFrames={Math.floor((project.video.duration_ms / 1000) * project.video.fps)}
          fps={project.video.fps}
          onClose={closeFrameTest}
        />
      )}
    </div>
  )
}

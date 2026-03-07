/**
 * VideoPreview — center pane.
 * Video player, timeline, scan controls, video controls bar, zoom, and redaction overlay canvas.
 */

import { useEffect, useRef, useState } from 'react'
import { getProject, importVideo, proxyVideoUrl, scanFrame, startRangeScan, startScan } from '../../api/client'
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
    livePreviewMode,
    toggleLivePreviewMode,
    setTestFrameOverlay,
    zoomLevel,
    setZoomLevel,
    drawingMode,
    setDrawingMode,
    staticDrawMode,
    setStaticDrawMode,
    addEvents,
    scanPreviewFrame,
  } = useProjectStore((s) => ({
    project: s.project,
    setProject: s.setProject,
    scanProgress: s.scanProgress,
    scanId: s.scanId,
    setScanId: s.setScanId,
    setCurrentTimeMs: s.setCurrentTimeMs,
    showRedactionAreas: s.showRedactionAreas,
    toggleRedactionAreas: s.toggleRedactionAreas,
    livePreviewMode: s.livePreviewMode,
    toggleLivePreviewMode: s.toggleLivePreviewMode,
    setTestFrameOverlay: s.setTestFrameOverlay,
    zoomLevel: s.zoomLevel,
    setZoomLevel: s.setZoomLevel,
    drawingMode: s.drawingMode,
    setDrawingMode: s.setDrawingMode,
    staticDrawMode: s.staticDrawMode,
    setStaticDrawMode: s.setStaticDrawMode,
    addEvents: s.addEvents,
    scanPreviewFrame: s.scanPreviewFrame,
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

  // Single-frame scan state
  const [scanningFrame, setScanningFrame] = useState(false)
  const [scanFrameMsg, setScanFrameMsg] = useState<string | null>(null)

  // Range scan state (ephemeral UI — not persisted to project)
  const [inPoint, setInPoint] = useState<number | null>(null)
  const [outPoint, setOutPoint] = useState<number | null>(null)

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

  // Seek the video to each frame as it's scanned/tracked so the user can see
  // a live preview of what is being examined. During OCR, only seeks when
  // paused. During tracking, always seeks (shows which frame is being tracked).
  useEffect(() => {
    if (!scanPreviewFrame || !videoRef.current) return
    const isTracking = scanProgress.stage === 'track' || scanProgress.stage === 'tracking'
    if (!isTracking && !videoRef.current.paused) return
    if (isTracking && !videoRef.current.paused) videoRef.current.pause()
    videoRef.current.currentTime = scanPreviewFrame.time_ms / 1000
  }, [scanPreviewFrame?.time_ms])

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

  const handleScanFrame = async () => {
    if (!project?.video || scanningFrame || scanProgress.isRunning) return
    const fps = project.video.fps
    const frameIndex = Math.round((currentTime / 1000) * fps)
    setScanningFrame(true)
    setScanFrameMsg(null)
    try {
      const result = await scanFrame(project.project_id, frameIndex)
      addEvents(result.events)
      setScanFrameMsg(
        result.count > 0
          ? `Found ${result.count} finding${result.count !== 1 ? 's' : ''} on this frame`
          : 'No PII found on this frame'
      )
    } catch (err) {
      setScanFrameMsg('Scan failed — check console')
      console.error('scanFrame error:', err)
    } finally {
      setScanningFrame(false)
      setTimeout(() => setScanFrameMsg(null), 4000)
    }
  }

  const handleRangeScan = async () => {
    if (!project || scanId !== null || scanProgress.isRunning) return
    if (inPoint === null || outPoint === null) return
    const start = Math.min(inPoint, outPoint)
    const end = Math.max(inPoint, outPoint)
    try {
      const { scan_id } = await startRangeScan(project.project_id, start, end)
      setScanId(scan_id)
    } catch (err) {
      console.error('Range scan failed to start:', err)
    }
  }

  const proxyUrl = project?.video ? proxyVideoUrl(project.project_id) : null

  const isScanPending = scanId !== null && !scanProgress.isRunning
  const isScanRunning = scanProgress.isRunning

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg)', ...style }}>
      {/* Toolbar */}
      <div style={{ padding: 'var(--space-2) var(--space-3)', background: 'var(--surface)', borderBottom: '1px solid var(--border-hairline)', display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Primary actions */}
        <label style={{ cursor: importing ? 'wait' : 'pointer' }}>
          <input
            type="file"
            accept=".mp4,.mov,.mkv,.avi,.webm"
            style={{ display: 'none' }}
            onChange={handleImport}
            disabled={importing}
          />
          <span style={{
            display: 'inline-flex', alignItems: 'center',
            padding: 'var(--space-2) var(--space-4)',
            minHeight: 36,
            background: 'var(--glass-bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--font-size-body)',
            cursor: importing ? 'wait' : 'pointer',
            opacity: importing ? 0.5 : 1,
            transition: 'all var(--transition-fast)',
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
              ? scanProgress.stage === 'track'
                ? `Tracking… ${scanProgress.progressPct}%`
                : scanProgress.stage === 'tracking'
                ? 'Tracking… 0%'
                : scanProgress.stage === 'linking'
                ? `Linking… ${scanProgress.progressPct}%`
                : scanProgress.stage === 'link_done'
                ? 'Linking… 100%'
                : scanProgress.stage === 'refining'
                ? `Refining… ${scanProgress.progressPct}%`
                : scanProgress.stage === 'refine_done'
                ? 'Refinement done'
                : `Scanning… ${scanProgress.progressPct}%`
              : 'Scan for PII'}
          </button>
        )}

        {/* Separator */}
        {project?.video && <div style={{ width: 1, height: 20, background: 'var(--border-hairline)', margin: '0 var(--space-1)' }} />}

        {/* Frame tools */}
        {project?.video && (
          <button
            className="secondary"
            onClick={() => setShowFrameTest(true)}
            disabled={isScanRunning}
            title="Test OCR and PII detection on a single frame (diagnostic, no events created)"
          >
            Test Frame
          </button>
        )}

        {project?.video && (
          <button
            className="secondary"
            onClick={handleScanFrame}
            disabled={scanningFrame || isScanRunning || isScanPending}
            title="Scan current frame for PII and add results as pending events"
          >
            {scanningFrame ? 'Scanning…' : 'Scan Frame'}
          </button>
        )}

        {project?.video && (
          <button
            className={drawingMode ? 'primary' : 'secondary'}
            onClick={() => setDrawingMode(!drawingMode)}
            title="Draw a manual redaction box on the video"
          >
            {drawingMode ? 'Drawing…' : 'Draw Box'}
          </button>
        )}

        {project?.video && drawingMode && (
          <button
            className={staticDrawMode ? 'primary' : 'ghost'}
            onClick={() => setStaticDrawMode(!staticDrawMode)}
            title={staticDrawMode
              ? 'Pin mode: drawn box stays at a fixed position for the entire video'
              : 'Track mode: drawn box follows content using CSRT tracking'}
            style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}
          >
            {staticDrawMode ? 'Pin' : 'Track'}
          </button>
        )}

        {/* Range scan — collapsible group */}
        {project?.video && (
          <details style={{ position: 'relative' }}>
            <summary style={{
              cursor: 'pointer',
              padding: 'var(--space-2) var(--space-4)',
              minHeight: 36,
              background: 'var(--glass-bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--font-size-body)',
              color: 'var(--text-muted)',
              listStyle: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)',
              transition: 'all var(--transition-fast)',
            }}>
              Range ▾
            </summary>
            <div style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 20,
              marginTop: 'var(--space-1)',
              padding: 'var(--space-2)',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-elevated)',
              display: 'flex', gap: 'var(--space-2)', whiteSpace: 'nowrap',
            }}>
              <button className="secondary" onClick={() => setInPoint(currentTime)} title="Set in-point" style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}>Set In</button>
              <button className="secondary" onClick={() => setOutPoint(currentTime)} title="Set out-point" style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}>Set Out</button>
              {inPoint !== null && outPoint !== null && (
                <button className="primary" onClick={handleRangeScan} disabled={isScanPending || isScanRunning} title={`Scan ${formatMs(Math.min(inPoint, outPoint))} – ${formatMs(Math.max(inPoint, outPoint))}`} style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}>
                  Scan Range
                </button>
              )}
              {(inPoint !== null || outPoint !== null) && (
                <button className="ghost" onClick={() => { setInPoint(null); setOutPoint(null) }} title="Clear range markers" style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}>Clear</button>
              )}
            </div>
          </details>
        )}

        {importError && (
          <span style={{ color: 'var(--reject)', fontSize: 'var(--font-size-small)' }}>{importError}</span>
        )}
        {scanFrameMsg && (
          <span style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)' }}>{scanFrameMsg}</span>
        )}

        {/* Toggles — right-aligned */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-2)' }}>
          <button
            className="ghost"
            onClick={toggleLivePreviewMode}
            style={{ opacity: livePreviewMode ? 1 : 0.4, fontSize: 'var(--font-size-small)', minHeight: 'auto', padding: 'var(--space-1) var(--space-2)', transition: 'opacity var(--transition-normal)' }}
            title="When paused, render actual blur/pixelate/solid_box effects on the canvas"
          >
            Preview Effects
          </button>
          <button
            className="ghost"
            onClick={toggleRedactionAreas}
            style={{ opacity: showRedactionAreas ? 1 : 0.4, fontSize: 'var(--font-size-small)', minHeight: 'auto', padding: 'var(--space-1) var(--space-2)', transition: 'opacity var(--transition-normal)' }}
            title="Toggle redaction preview"
          >
            Redactions
          </button>
        </div>
      </div>

      {/* Scan progress bar */}
      {(isScanPending || isScanRunning) && (
        <div style={{ height: 3, background: 'var(--border)', position: 'relative' }}>
          <div
            className={scanProgress.stage === 'done' ? 'shimmer-bar' : undefined}
            style={{
              position: 'absolute', left: 0, top: 0, height: '100%',
              width: isScanPending ? '2%' : `${scanProgress.progressPct}%`,
              background: 'var(--accent)',
              transition: 'width 0.3s',
            }}
          />
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
                style={{ maxWidth: '100%', maxHeight: '100%', display: 'block', borderRadius: 'var(--radius-lg)' }}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={() => {
                  setDuration(Math.floor((videoRef.current?.duration ?? 0) * 1000))
                }}
              />
            </div>
            {/* Canvas sits OUTSIDE the zoom wrapper so it isn't scaled. */}
            <OverlayCanvas
              videoRef={videoRef}
              containerRef={videoContainerRef}
              currentTimeMs={currentTime}
              showRedactions={showRedactionAreas}
              projectId={project?.project_id ?? ''}
              sourceWidth={project?.video?.width ?? 0}
              sourceHeight={project?.video?.height ?? 0}
              isPaused={!isPlaying}
            />
          </>
        ) : importing ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)' }}>
            <div style={{ fontSize: 'var(--font-size-title)', opacity: 0.4 }}>⟳</div>
            <div style={{ fontWeight: 500 }}>Generating proxy video…</div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-disabled)' }}>This may take a minute for large files</div>
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)' }}>
            <div style={{ fontSize: 40, opacity: 0.3 }}>▶</div>
            <div style={{ fontWeight: 500 }}>Import a video to get started</div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-disabled)' }}>Drag and drop or click Import Video above</div>
          </div>
        )}
      </div>

      {/* Video controls bar */}
      {proxyUrl && (
        <div style={{
          padding: 'var(--space-2) var(--space-3)',
          background: 'var(--surface-secondary)',
          borderTop: '1px solid var(--border-hairline)',
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 'var(--font-size-body)',
        }}>
          {/* Play/Pause */}
          <button
            onClick={handlePlayPause}
            style={{
              fontSize: 16, padding: 'var(--space-1) var(--space-2)', minWidth: 40, minHeight: 36,
              background: 'var(--accent)', color: '#fff', borderRadius: 'var(--radius-md)',
              boxShadow: '0 0 12px rgba(216, 27, 96, 0.2)',
            }}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>

          {/* Time */}
          <span style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {formatMs(currentTime)} / {formatMs(duration)}
          </span>

          {/* Volume */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>Vol</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={volume}
              onChange={handleVolume}
              style={{ width: 72, accentColor: 'var(--accent)' }}
            />
          </div>

          {/* Speed */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>Speed</span>
            <select
              value={playbackRate}
              onChange={handleRate}
              style={{ fontSize: 'var(--font-size-small)', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-1)', minHeight: 'auto' }}
            >
              {[0.25, 0.5, 0.75, 1, 1.5, 2].map((r) => (
                <option key={r} value={r}>{r}×</option>
              ))}
            </select>
          </div>

          {/* Zoom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', marginLeft: 'auto' }}>
            <button className="ghost" onClick={() => setZoomLevel(Math.max(1, zoomLevel - 0.5))} style={{ fontSize: 'var(--font-size-body)', padding: 'var(--space-1) var(--space-2)', minWidth: 32, minHeight: 32 }}>−</button>
            <span style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', minWidth: 28, textAlign: 'center' }}>{zoomLevel}×</span>
            <button className="ghost" onClick={() => setZoomLevel(Math.min(4, zoomLevel + 0.5))} style={{ fontSize: 'var(--font-size-body)', padding: 'var(--space-1) var(--space-2)', minWidth: 32, minHeight: 32 }}>+</button>
          </div>
        </div>
      )}

      {/* Timeline */}
      {duration > 0 && (
        <Timeline
          durationMs={duration}
          currentTimeMs={currentTime}
          onSeek={handleSeek}
          inPoint={inPoint}
          outPoint={outPoint}
        />
      )}

      {/* Frame test modal */}
      {showFrameTest && project?.video && (
        <FrameTestModal
          projectId={project.project_id}
          initialFrameIndex={Math.max(1, Math.floor((currentTime / 1000) * project.video.fps))}
          totalFrames={Math.floor((project.video.duration_ms / 1000) * project.video.fps)}
          fps={project.video.fps}
          onClose={closeFrameTest}
        />
      )}
    </div>
  )
}

/**
 * VideoPreview — center pane.
 * Video player, timeline, scan controls, video controls bar, zoom, and redaction overlay canvas.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, Minus, Pause, Play, Plus } from 'lucide-react'
import videoBg from '../../assets/video-bg.png'
import { getProject, importVideo, proxyVideoUrl, scanFrame, startRangeScan, startScan } from '../../api/client'
import { useScanProgress } from '../../hooks/useScanProgress'
import { useKeyboard } from '../../hooks/useKeyboard'
import { useProjectStore } from '../../store/projectStore'
import { formatMs, rangePct } from '../../utils/format'
import { FrameTestModal } from './FrameTestModal'
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
    polygonDrawMode,
    setPolygonDrawMode,
    staticDrawMode,
    setStaticDrawMode,
    addEvents,
    scanPreviewFrame,
    addNotification,
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
    polygonDrawMode: s.polygonDrawMode,
    setPolygonDrawMode: s.setPolygonDrawMode,
    staticDrawMode: s.staticDrawMode,
    setStaticDrawMode: s.setStaticDrawMode,
    addEvents: s.addEvents,
    scanPreviewFrame: s.scanPreviewFrame,
    addNotification: s.addNotification,
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
  const [rangeOpen, setRangeOpen] = useState(false)
  const rangeRef = useRef<HTMLDivElement>(null)

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
  }, [scanProgress.stage, project?.project_id])

  // Seek the video to each frame as it's scanned/tracked so the user can see
  // a live preview of what is being examined.
  useEffect(() => {
    if (!scanPreviewFrame || !videoRef.current) return
    const isTracking = scanProgress.stage === 'track' || scanProgress.stage === 'tracking'
    if (!isTracking && !videoRef.current.paused) return
    if (isTracking && !videoRef.current.paused) videoRef.current.pause()
    videoRef.current.currentTime = scanPreviewFrame.time_ms / 1000
  }, [scanPreviewFrame?.time_ms])

  // Close range dropdown on click outside
  useEffect(() => {
    if (!rangeOpen) return
    const handler = (e: MouseEvent) => {
      if (rangeRef.current && !rangeRef.current.contains(e.target as Node)) {
        setRangeOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [rangeOpen])

  const [dragOver, setDragOver] = useState(false)

  const VALID_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm']

  const doImport = async (file: File) => {
    if (!project) return
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
    }
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0]) return
    await doImport(e.target.files[0])
    e.target.value = ''
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (!project || importing || proxyUrl) return
    const file = e.dataTransfer.files[0]
    if (!file) return
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!VALID_EXTENSIONS.includes(ext)) {
      setImportError(`Unsupported format. Use: ${VALID_EXTENSIONS.join(', ')}`)
      return
    }
    doImport(file)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    if (!proxyUrl && !importing) setDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }

  const handleScan = async () => {
    if (!project || scanId !== null || scanProgress.isRunning) return
    try {
      const { scan_id } = await startScan(project.project_id)
      setScanId(scan_id)
    } catch (err: unknown) {
      console.error('Scan failed to start:', err)
      addNotification('Scan failed to start', 'error')
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
      setScanFrameMsg('Scan failed \u2014 check console')
      console.error('scanFrame error:', err)
      addNotification('Frame scan failed', 'error')
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
      addNotification('Range scan failed to start', 'error')
    }
  }

  const proxyUrl = project?.video ? proxyVideoUrl(project.project_id) : null

  const isScanPending = scanId !== null && !scanProgress.isRunning
  const isScanRunning = scanProgress.isRunning

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg)', ...style }}>
      {/* Toolbar */}
      <div style={{ padding: 'var(--space-2) var(--space-3)', background: 'var(--surface)', borderBottom: '1px solid var(--border-hairline)', display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Group 1: Import + Scan */}
        <div className="toolbar-group">
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
              {importing ? 'Importing\u2026' : 'Import Video'}
            </span>
          </label>

          {project?.video && (
            <button
              className="primary"
              onClick={handleScan}
              disabled={isScanPending || isScanRunning}
            >
              {isScanPending
                ? 'Starting\u2026'
                : isScanRunning
                ? scanProgress.stage === 'track'
                  ? `Tracking\u2026 ${scanProgress.progressPct}%`
                  : scanProgress.stage === 'tracking'
                  ? 'Tracking\u2026 0%'
                  : scanProgress.stage === 'linking'
                  ? `Linking\u2026 ${scanProgress.progressPct}%`
                  : scanProgress.stage === 'link_done'
                  ? 'Linking\u2026 100%'
                  : scanProgress.stage === 'refining'
                  ? `Refining\u2026 ${scanProgress.progressPct}%`
                  : scanProgress.stage === 'refine_done'
                  ? 'Refinement done'
                  : `Scanning\u2026 ${scanProgress.progressPct}%`
                : 'Scan for PII'}
            </button>
          )}
        </div>

        {/* Separator */}
        {project?.video && <div className="toolbar-separator" />}

        {/* Group 2: Test Frame + Scan Frame */}
        {project?.video && (
          <div className="toolbar-group">
            <button
              className="secondary"
              onClick={() => setShowFrameTest(true)}
              disabled={isScanRunning}
              data-tooltip="Test OCR and PII detection on a single frame"
            >
              Test Frame
            </button>

            <button
              className="secondary"
              onClick={handleScanFrame}
              disabled={scanningFrame || isScanRunning || isScanPending}
              data-tooltip="Scan current frame for PII and add results"
            >
              {scanningFrame ? 'Scanning\u2026' : 'Scan Frame'}
            </button>
          </div>
        )}

        {/* Separator */}
        {project?.video && <div className="toolbar-separator" />}

        {/* Group 3: Draw Box + Pin/Track */}
        {project?.video && (
          <div className="toolbar-group">
            <button
              className={drawingMode ? 'primary' : 'secondary'}
              onClick={() => setDrawingMode(!drawingMode)}
              data-tooltip="Draw a manual redaction box on the video"
            >
              {drawingMode ? 'Drawing…' : 'Draw Box'}
            </button>

            <button
              className={polygonDrawMode ? 'primary' : 'secondary'}
              onClick={() => setPolygonDrawMode(!polygonDrawMode)}
              data-tooltip="Draw a freeform polygon redaction (click vertices, double-click to finish)"
            >
              {polygonDrawMode ? 'Drawing…' : 'Draw Polygon'}
            </button>

            {(drawingMode || polygonDrawMode) && (
              <button
                className={staticDrawMode ? 'primary' : 'ghost'}
                onClick={() => setStaticDrawMode(!staticDrawMode)}
                data-tooltip={staticDrawMode
                  ? 'Pin mode: box stays at fixed position'
                  : 'Track mode: box follows content via CSRT'}
                style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}
              >
                {staticDrawMode ? 'Pin' : 'Track'}
              </button>
            )}
          </div>
        )}

        {/* Separator */}
        {project?.video && <div className="toolbar-separator" />}

        {/* Group 4: Range dropdown */}
        {project?.video && (
          <div ref={rangeRef} style={{ position: 'relative' }}>
            <button
              className="secondary"
              onClick={() => setRangeOpen(!rangeOpen)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)',
                color: 'var(--text-muted)',
              }}
            >
              Range <ChevronDown size={14} />
            </button>
            {rangeOpen && (
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
                <button className="secondary" onClick={() => setInPoint(currentTime)} data-tooltip="Set in-point" style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}>Set In</button>
                <button className="secondary" onClick={() => setOutPoint(currentTime)} data-tooltip="Set out-point" style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}>Set Out</button>
                {inPoint !== null && outPoint !== null && (
                  <button className="primary" onClick={handleRangeScan} disabled={isScanPending || isScanRunning} data-tooltip={`Scan ${formatMs(Math.min(inPoint, outPoint))} \u2013 ${formatMs(Math.max(inPoint, outPoint))}`} style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}>
                    Scan Range
                  </button>
                )}
                {(inPoint !== null || outPoint !== null) && (
                  <button className="ghost" onClick={() => { setInPoint(null); setOutPoint(null) }} data-tooltip="Clear range markers" style={{ fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-3)', minHeight: 32 }}>Clear</button>
                )}
              </div>
            )}
          </div>
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
            className="ghost toolbar-toggle"
            onClick={toggleLivePreviewMode}
            data-active={livePreviewMode}
            data-tooltip="Preview blur/pixelate/solid effects when paused"
            style={{ fontSize: 'var(--font-size-small)', minHeight: 'auto', padding: 'var(--space-1) var(--space-2)' }}
          >
            Preview Effects
          </button>
          <button
            className="ghost toolbar-toggle"
            onClick={toggleRedactionAreas}
            data-active={showRedactionAreas}
            data-tooltip="Toggle redaction preview"
            style={{ fontSize: 'var(--font-size-small)', minHeight: 'auto', padding: 'var(--space-1) var(--space-2)' }}
          >
            Redactions
          </button>
        </div>
      </div>

      {/* Scan progress bar */}
      {(isScanPending || isScanRunning) && (
        <div className="progress-track" style={{ height: 3, borderRadius: 0 }}>
          <div
            className={scanProgress.stage === 'done' ? 'shimmer-bar' : 'progress-fill'}
            style={{
              width: isScanPending ? '2%' : `${scanProgress.progressPct}%`,
              borderRadius: 0,
            }}
          />
        </div>
      )}

      {/* Video + overlay */}
      <div
        ref={videoContainerRef}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
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
            <Loader2 size={32} style={{ opacity: 0.4, animation: 'spin 1s linear infinite' }} />
            <div style={{ fontWeight: 500 }}>Generating proxy video\u2026</div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-disabled)' }}>This may take a minute for large files</div>
          </div>
        ) : (
          <div
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              width: '100%', height: '100%',
              border: dragOver ? '2px dashed var(--accent)' : '2px dashed transparent',
              borderRadius: 'var(--radius-lg)',
              background: dragOver ? 'rgba(216, 27, 96, 0.05)' : 'transparent',
              transition: 'all var(--transition-fast)',
            }}
          >
            <img src={videoBg} alt="" style={{ maxWidth: '80%', maxHeight: '60%', objectFit: 'contain', pointerEvents: 'none', opacity: dragOver ? 0.4 : 1 }} />
            {dragOver && (
              <div style={{ marginTop: 'var(--space-4)', fontSize: 'var(--font-size-body)', color: 'var(--accent)', fontWeight: 500 }}>
                Drop video here
              </div>
            )}
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
              padding: 'var(--space-1) var(--space-2)', minWidth: 40, minHeight: 36,
              background: 'var(--accent)', color: '#fff', borderRadius: 'var(--radius-md)',
              boxShadow: '0 0 12px rgba(216, 27, 96, 0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
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
              style={{ width: 72, '--value-pct': rangePct(volume, 0, 1) } as React.CSSProperties}
            />
          </div>

          {/* Speed */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>Speed</span>
            <select
              value={playbackRate}
              onChange={handleRate}
              style={{ fontSize: 'var(--font-size-small)', minHeight: 'auto' }}
            >
              {[0.25, 0.5, 0.75, 1, 1.5, 2].map((r) => (
                <option key={r} value={r}>{r}&times;</option>
              ))}
            </select>
          </div>

          {/* Zoom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', marginLeft: 'auto' }}>
            <button className="ghost" onClick={() => setZoomLevel(Math.max(1, zoomLevel - 0.5))} style={{ padding: 'var(--space-1) var(--space-2)', minWidth: 32, minHeight: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Minus size={16} />
            </button>
            <span style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-muted)', minWidth: 28, textAlign: 'center' }}>{zoomLevel}&times;</span>
            <button className="ghost" onClick={() => setZoomLevel(Math.min(4, zoomLevel + 0.5))} style={{ padding: 'var(--space-1) var(--space-2)', minWidth: 32, minHeight: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Plus size={16} />
            </button>
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

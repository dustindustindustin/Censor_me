/**
 * useExportProgress — WebSocket hook for real-time export encoding progress.
 *
 * Returns the current export state and a ``track(exportId)`` function that
 * opens a WebSocket connection to receive frame-level encoding progress events.
 *
 * State lifecycle:
 *   idle → isRunning=true (after track() called) → isRunning=false + outputPath set
 *
 * Error handling:
 *   If the WebSocket errors or the backend reports failure, ``error`` is set
 *   and ``isRunning`` is cleared. The caller can offer a retry button.
 *
 * @example
 * ```tsx
 * const { progress, track, reset } = useExportProgress()
 *
 * const handleExport = async () => {
 *   const { export_id } = await startExport(projectId)
 *   track(export_id)  // opens WebSocket and begins receiving progress
 * }
 * ```
 */

import { useEffect, useRef, useState } from 'react'
import { openExportProgressSocket } from '../api/client'

/** The current state of an export operation. */
export interface ExportProgress {
  /** True while encoding is in progress. */
  isRunning: boolean
  /** Encoding progress as a percentage (0–100). */
  pct: number
  /** Number of frames encoded so far. */
  currentFrame: number
  /** Total number of frames to encode. */
  totalFrames: number
  /** Absolute path of the output file on the server, set when export succeeds. */
  outputPath: string | null
  /** Error message if the export failed, or null if not in an error state. */
  error: string | null
}

const IDLE: ExportProgress = {
  isRunning: false,
  pct: 0,
  currentFrame: 0,
  totalFrames: 0,
  outputPath: null,
  error: null,
}

/**
 * Provides reactive export progress state and a function to start tracking.
 *
 * @returns An object with:
 *   - ``progress`` — current ExportProgress snapshot
 *   - ``track(exportId)`` — call with the ID from ``startExport()`` to begin tracking
 *   - ``reset()`` — return to idle state (e.g., to allow re-export)
 */
export function useExportProgress(): {
  progress: ExportProgress
  track: (exportId: string) => void
  reset: () => void
} {
  const [progress, setProgress] = useState<ExportProgress>(IDLE)
  // Ref prevents the WebSocket from being garbage-collected while it's active
  const wsRef = useRef<WebSocket | null>(null)

  /**
   * Open a WebSocket connection to stream encoding progress for the given export.
   * Closes any previously open connection before opening a new one.
   */
  const track = (exportId: string): void => {
    // Close any existing connection before starting a new one
    if (wsRef.current) wsRef.current.close()

    setProgress({ ...IDLE, isRunning: true })
    const ws = openExportProgressSocket(exportId)
    wsRef.current = ws

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.stage === 'encoding') {
        setProgress((p) => ({
          ...p,
          isRunning: true,
          pct: data.pct,
          currentFrame: data.current_frame,
          totalFrames: data.total_frames,
        }))
      } else if (data.stage === 'done') {
        setProgress({ ...IDLE, pct: 100, outputPath: data.output_path })
        ws.close()
      } else if (data.stage === 'error') {
        setProgress({ ...IDLE, error: data.message })
        ws.close()
      }
    }

    ws.onerror = () => {
      setProgress({ ...IDLE, error: 'Export connection lost. Check backend logs.' })
    }
  }

  // Cleanup on unmount to avoid WebSocket leaks
  useEffect(() => () => wsRef.current?.close(), [])

  return { progress, track, reset: () => setProgress(IDLE) }
}

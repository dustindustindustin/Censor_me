/**
 * useScanProgress — WebSocket hook for real-time scan pipeline progress.
 *
 * Opens a WebSocket connection to ``/ws/scan/progress/{scanId}`` and forwards
 * incoming progress events to the Zustand store via ``updateScanProgress``.
 * The store update triggers a re-render of any component subscribed to
 * ``scanProgress`` (primarily the scan progress bar in VideoPreview).
 *
 * The WebSocket is opened when ``scanId`` changes from null to a string,
 * and closed when ``scanId`` becomes null again or the component unmounts.
 *
 * @example
 * ```tsx
 * const [scanId, setScanId] = useState<string | null>(null)
 * useScanProgress(scanId)
 *
 * const handleScan = async () => {
 *   const { scan_id } = await startScan(projectId)
 *   setScanId(scan_id)   // opens WebSocket automatically
 * }
 * ```
 */

import { useEffect, useRef } from 'react'
import { openScanProgressSocket } from '../api/client'
import { useProjectStore } from '../store/projectStore'
import type { ScanProgressEvent } from '../types'

/**
 * Subscribe to scan progress events for the given scan ID.
 *
 * @param scanId - The scan ID returned by ``startScan()``, or null when idle.
 *                 Passing null closes any existing connection.
 */
export function useScanProgress(scanId: string | null): void {
  const updateScanProgress = useProjectStore((s) => s.updateScanProgress)
  // Store the WebSocket ref so we can close it on cleanup without re-running the effect
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!scanId) return

    const ws = openScanProgressSocket(scanId)
    wsRef.current = ws

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ScanProgressEvent
        updateScanProgress(data)
      } catch {
        console.error('Failed to parse scan progress event:', event.data)
      }
    }

    ws.onerror = (err) => {
      console.error('Scan progress WebSocket error:', err)
    }

    // Cleanup: close the WebSocket when scanId changes or component unmounts
    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [scanId, updateScanProgress])
}

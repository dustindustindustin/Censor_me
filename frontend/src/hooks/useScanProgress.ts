/**
 * useScanProgress — WebSocket hook for real-time scan pipeline progress.
 *
 * Opens a WebSocket connection to ``/ws/scan/progress/{scanId}`` and forwards
 * incoming progress events to the Zustand store via ``updateScanProgress``.
 * The store update triggers a re-render of any component subscribed to
 * ``scanProgress`` (primarily the scan progress bar in VideoPreview).
 *
 * If the connection drops mid-scan, the hook reconnects with exponential
 * backoff (2s, 5s, 10s, max 3 retries) and resumes from the current state.
 *
 * The WebSocket is opened when ``scanId`` changes from null to a string,
 * and closed when ``scanId`` becomes null again or the component unmounts.
 */

import { useEffect, useRef } from 'react'
import { getActiveScan, openScanProgressSocket } from '../api/client'
import { useProjectStore } from '../store/projectStore'
import type { ScanProgressEvent } from '../types'

const RECONNECT_DELAYS = [2000, 5000, 10000]

/**
 * Subscribe to scan progress events for the given scan ID.
 *
 * @param scanId - The scan ID returned by ``startScan()``, or null when idle.
 *                 Passing null closes any existing connection.
 */
export function useScanProgress(scanId: string | null): void {
  const updateScanProgress = useProjectStore((s) => s.updateScanProgress)
  const project = useProjectStore((s) => s.project)
  const wsRef = useRef<WebSocket | null>(null)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = useRef(false)  // tracks whether this effect is still mounted

  useEffect(() => {
    if (!scanId) return

    activeRef.current = true
    retryCountRef.current = 0

    function connect(id: string) {
      if (!activeRef.current) return

      const ws = openScanProgressSocket(id)
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
        updateScanProgress({ stage: 'error', message: 'Lost connection to scan progress stream' })
      }

      ws.onclose = (ev) => {
        if (!activeRef.current) return
        // Clean close (scan finished) — no reconnect needed
        if (ev.wasClean) return

        const attempt = retryCountRef.current
        if (attempt >= RECONNECT_DELAYS.length) {
          console.warn('Scan WebSocket: max reconnect attempts reached')
          updateScanProgress({
            stage: 'error',
            message: 'Lost connection to scan. The scan may still be running — reload to check status.',
          })
          return
        }

        const delay = RECONNECT_DELAYS[attempt]
        retryCountRef.current = attempt + 1
        console.warn(`Scan WebSocket dropped — reconnecting in ${delay}ms (attempt ${attempt + 1})`)

        retryTimerRef.current = setTimeout(async () => {
          if (!activeRef.current) return
          // Re-query the backend for the current scan_id (may have changed if backend restarted)
          try {
            const pid = project?.project_id
            if (pid) {
              const active = await getActiveScan(pid)
              if (active?.scan_id) connect(active.scan_id)
            } else {
              connect(id)
            }
          } catch {
            connect(id)
          }
        }, delay)
      }
    }

    connect(scanId)

    return () => {
      activeRef.current = false
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [scanId, updateScanProgress])
}

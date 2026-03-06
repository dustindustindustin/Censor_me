/**
 * Zustand project store — the single source of truth for all frontend state.
 *
 * This store is the central hub that all three panes (FindingsPanel, VideoPreview,
 * Inspector) read from and write to. React components subscribe to slices of the
 * store; mutations trigger only the subscribed components to re-render.
 *
 * State shape overview:
 *   project        — the currently open ProjectFile (null = project selector shown)
 *   events         — the live list of RedactionEvents (updated after scan + review)
 *   currentTimeMs  — the video playhead position, updated every animation frame
 *   selectedEventId — which finding is highlighted in the Inspector
 *   showOcrBoxes   — toggle for the OCR detection overlay on the video
 *   showRedactionAreas — toggle for the redaction preview overlay
 *   scanProgress   — real-time scan pipeline progress (fed by useScanProgress hook)
 *
 * Usage pattern:
 *   // Read a slice — component re-renders only when this slice changes
 *   const events = useProjectStore(s => s.events)
 *
 *   // Mutate
 *   useProjectStore.getState().updateEventStatus(id, 'accepted')
 */

import { create } from 'zustand'
import type { Project, RedactionEvent, ScanProgressEvent, TestFrameOverlayBox } from '../types'

/** Snapshot of scan pipeline progress, updated by the useScanProgress hook. */
interface ScanProgress {
  /** True while the scan pipeline is actively running. */
  isRunning: boolean
  /** Current pipeline stage label (e.g., 'ocr', 'tracking', 'done'). */
  stage: string
  /** Percentage complete (0–100), based on OCR frames processed. */
  progressPct: number
  /** Number of PII candidates found so far. */
  findingsCount: number
  /** Total OCR frames planned by FrameSampler (for the progress bar denominator). */
  totalOcrFrames: number
}

interface ProjectStore {
  // ── Active project ──────────────────────────────────────────────────────────

  /** The currently open project, or null when showing the project selector. */
  project: Project | null
  /** Open a project and initialize its events list. */
  setProject: (p: Project) => void
  /** Close the current project and return to the project selector. */
  clearProject: () => void

  // ── Events (findings) ───────────────────────────────────────────────────────

  /** Ordered list of all RedactionEvents in the current project. */
  events: RedactionEvent[]
  /** Replace the events list (called after scan completes or project loads). */
  setEvents: (events: RedactionEvent[]) => void
  /**
   * Update a single event's status optimistically.
   * The API call to persist the change is made separately by the caller.
   */
  updateEventStatus: (eventId: string, status: 'accepted' | 'rejected' | 'pending') => void
  /** Append a new event (used when a manual region is drawn). */
  addEvent: (event: RedactionEvent) => void
  /** Replace a single event in the list (e.g., after tracking updates its keyframes). */
  updateEvent: (event: RedactionEvent) => void

  // ── Playhead ────────────────────────────────────────────────────────────────

  /** Current video playhead position in milliseconds. Updated on timeupdate events. */
  currentTimeMs: number
  /** Sync the playhead position from a video timeupdate event. */
  setCurrentTimeMs: (ms: number) => void

  // ── Selection ───────────────────────────────────────────────────────────────

  /** The event_id of the finding currently shown in the Inspector, or null. */
  selectedEventId: string | null
  /** Select a finding to display in the Inspector, or pass null to deselect. */
  selectEvent: (id: string | null) => void

  // ── Overlay toggles ─────────────────────────────────────────────────────────

  /** Whether the OCR detection box overlay is visible on the video. */
  showOcrBoxes: boolean
  /** Whether the redaction region overlay is visible on the video. */
  showRedactionAreas: boolean
  toggleOcrBoxes: () => void
  toggleRedactionAreas: () => void

  // ── Test frame overlay ───────────────────────────────────────────────────────

  /** Boxes from the last test-frame run; drawn in cyan over the video. Null when no test active. */
  testFrameOverlay: TestFrameOverlayBox[] | null
  setTestFrameOverlay: (boxes: TestFrameOverlayBox[] | null) => void

  // ── Zoom ────────────────────────────────────────────────────────────────────

  /** Video zoom level (CSS scale). Range [1.0, 4.0]. */
  zoomLevel: number
  setZoomLevel: (z: number) => void

  // ── Draw mode ───────────────────────────────────────────────────────────────

  /** When true, the overlay canvas accepts mouse events for drawing new boxes. */
  drawingMode: boolean
  setDrawingMode: (on: boolean) => void

  // ── Active scan ─────────────────────────────────────────────────────────────

  /**
   * The scan_id of the in-flight scan, or null when idle.
   * Non-null from the moment startScan() resolves until the scan reaches done/error.
   * Used to eliminate the gap where the button would revert to "Scan for PII" briefly.
   */
  scanId: string | null
  setScanId: (id: string | null) => void

  // ── Scan progress ───────────────────────────────────────────────────────────

  /** Real-time scan pipeline progress, fed by the useScanProgress hook. */
  scanProgress: ScanProgress
  /**
   * Process a single WebSocket progress event from the scan pipeline.
   * Maps the discriminated union to the relevant progress fields.
   */
  updateScanProgress: (event: ScanProgressEvent) => void
  /** Reset scan progress to idle state (before or after a scan). */
  resetScanProgress: () => void
}

const DEFAULT_SCAN_PROGRESS: ScanProgress = {
  isRunning: false,
  stage: '',
  progressPct: 0,
  findingsCount: 0,
  totalOcrFrames: 0,
}

export const useProjectStore = create<ProjectStore>((set) => ({
  // ── Active project ──────────────────────────────────────────────────────────

  project: null,
  setProject: (p) => set({ project: p, events: p.events }),
  clearProject: () => set({ project: null, events: [], selectedEventId: null }),

  // ── Events ──────────────────────────────────────────────────────────────────

  events: [],
  setEvents: (events) => set({ events }),

  updateEventStatus: (eventId, status) =>
    set((state) => ({
      events: state.events.map((e) =>
        e.event_id === eventId ? { ...e, status } : e
      ),
    })),

  addEvent: (event) =>
    set((state) => ({ events: [...state.events, event] })),

  updateEvent: (event) =>
    set((state) => ({
      events: state.events.map((e) => e.event_id === event.event_id ? event : e),
    })),

  // ── Playhead ────────────────────────────────────────────────────────────────

  currentTimeMs: 0,
  setCurrentTimeMs: (ms) => set({ currentTimeMs: ms }),

  // ── Selection ───────────────────────────────────────────────────────────────

  selectedEventId: null,
  selectEvent: (id) => set({ selectedEventId: id }),

  // ── Overlays ────────────────────────────────────────────────────────────────

  showOcrBoxes: false,
  showRedactionAreas: true,
  toggleOcrBoxes: () => set((s) => ({ showOcrBoxes: !s.showOcrBoxes })),
  toggleRedactionAreas: () => set((s) => ({ showRedactionAreas: !s.showRedactionAreas })),

  // ── Test frame overlay ───────────────────────────────────────────────────────

  testFrameOverlay: null,
  setTestFrameOverlay: (boxes) => set({ testFrameOverlay: boxes }),

  // ── Zoom ────────────────────────────────────────────────────────────────────

  zoomLevel: 1,
  setZoomLevel: (z) => set({ zoomLevel: z }),

  // ── Draw mode ───────────────────────────────────────────────────────────────

  drawingMode: false,
  setDrawingMode: (on) => set({ drawingMode: on }),

  // ── Active scan ─────────────────────────────────────────────────────────────

  scanId: null,
  setScanId: (id) => set((s) => ({
    scanId: id,
    // Reset progress when clearing the scan (scan completed or errored)
    scanProgress: id === null ? DEFAULT_SCAN_PROGRESS : s.scanProgress,
  })),

  // ── Scan progress ───────────────────────────────────────────────────────────

  scanProgress: DEFAULT_SCAN_PROGRESS,

  updateScanProgress: (event) =>
    set((state) => {
      const prev = state.scanProgress

      if (event.stage === 'starting') {
        return { scanProgress: { ...prev, isRunning: true, progressPct: 0, findingsCount: 0, totalOcrFrames: event.total_ocr_frames, stage: 'starting' } }
      }
      if (event.stage === 'ocr') {
        return { scanProgress: { ...prev, stage: 'ocr', progressPct: event.progress_pct, findingsCount: event.findings_so_far } }
      }
      if (event.stage === 'done') {
        return { scanId: null, scanProgress: { ...prev, isRunning: false, stage: 'done', progressPct: 100, findingsCount: event.total_findings } }
      }
      if (event.stage === 'error') {
        return { scanId: null, scanProgress: { ...prev, isRunning: false, stage: 'error' } }
      }
      // All other stages (linking, link_done, tracking, track, scene_change):
      // just update the stage label without changing other fields
      return { scanProgress: { ...prev, stage: event.stage } }
    }),

  resetScanProgress: () => set({ scanProgress: DEFAULT_SCAN_PROGRESS }),
}))

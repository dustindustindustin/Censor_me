/**
 * Typed API client for the Censor Me backend.
 *
 * Supports two modes:
 *   - **Dev mode** (no Tauri): REST uses ``/api`` prefix (Vite proxy strips it),
 *     WebSocket uses ``/ws`` prefix (Vite proxy strips it).
 *   - **Tauri mode**: REST and WebSocket go directly to ``http://127.0.0.1:{port}``.
 *     The port is obtained from the Tauri IPC ``get_backend_port`` command.
 */

import axios from 'axios'
import type { FrameTestResult, OutputSettings, Project, RedactionEvent, Rule, ScanSettings, SystemStatus } from '../types'

// ── Dual-mode URL resolution ─────────────────────────────────────────────────

const IS_TAURI = '__TAURI_INTERNALS__' in window

let _port = 8010

/** Called from main.tsx after getting the port from Tauri IPC. */
export function setBackendPort(p: number) { _port = p }

function apiBase(): string {
  return IS_TAURI ? `http://127.0.0.1:${_port}` : '/api'
}

function wsBase(): string {
  if (IS_TAURI) return `ws://127.0.0.1:${_port}`
  return window.location.origin.replace(/^http/, 'ws')
}

const api = axios.create({
  baseURL: apiBase(),
  timeout: 30_000,
})

const statusApi = axios.create({
  baseURL: apiBase(),
  timeout: 3_000,
})

/** Re-initialize axios base URLs after setBackendPort is called. */
export function reinitAxios() {
  api.defaults.baseURL = apiBase()
  statusApi.defaults.baseURL = apiBase()
}

// ── System ────────────────────────────────────────────────────────────────────

/**
 * Check backend readiness and hardware capabilities.
 *
 * The frontend polls this on startup until ``ready`` is true, which indicates
 * that ffmpeg was found and EasyOCR + Presidio models have been initialized.
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  const { data } = await statusApi.get('/system/status')
  return data
}

/**
 * Fetch detailed GPU diagnostics (VRAM, PyTorch, FFmpeg, system info).
 * Used by the GPU / Performance tab in Settings.
 */
export async function getSystemDiagnostics(): Promise<any> {
  const { data } = await api.get('/system/diagnostics')
  return data
}

export async function getSetupStatus(): Promise<{
  complete: boolean
  gpu_detected: boolean
  gpu_vendor: string
  gpu_name: string | null
}> {
  const { data } = await statusApi.get('/system/setup/status')
  return data
}

export async function completeSetup(): Promise<void> {
  await api.post('/system/setup/complete')
}

export function openSetupInstallSocket(provider: string): WebSocket {
  const base = wsBase()
  if (IS_TAURI) return new WebSocket(`${base}/system/setup/install-gpu?provider=${provider}`)
  return new WebSocket(`${base}/ws/system/setup/install-gpu?provider=${provider}`)
}

export async function copyExportTo(projectId: string, destination: string): Promise<void> {
  await api.post(`/export/${projectId}/copy-to`, { destination })
}

// ── Projects ──────────────────────────────────────────────────────────────────

/**
 * List all saved projects, sorted by most recently modified.
 * Returns summary objects (not full ProjectFile) for performance.
 */
export async function listProjects(): Promise<Project[]> {
  const { data } = await api.get('/projects/')
  return data
}

/**
 * Create a new empty project with the given name.
 * Returns the UUID of the newly created project.
 */
export async function createProject(name: string): Promise<{ project_id: string }> {
  const { data } = await api.post('/projects/', null, { params: { name } })
  return data
}

/**
 * Load the full project state by ID, including all events and settings.
 * Called after video import, scan completion, and on project open.
 */
export async function getProject(projectId: string): Promise<Project> {
  const { data } = await api.get(`/projects/${projectId}`)
  return data
}

/**
 * Permanently delete a project and all its files (proxy, exports, project.json).
 * This operation is not reversible.
 */
export async function deleteProject(projectId: string): Promise<void> {
  await api.delete(`/projects/${projectId}`)
}

/**
 * Rename a project.
 */
export async function renameProject(projectId: string, name: string): Promise<{ name: string }> {
  const { data } = await api.patch(`/projects/${projectId}/name`, { name })
  return data
}

/**
 * Permanently remove a single RedactionEvent from the project.
 * This operation is not reversible without undo.
 */
export async function deleteEvent(projectId: string, eventId: string): Promise<void> {
  await api.delete(`/projects/${projectId}/events/${eventId}`)
}

/**
 * Append a single RedactionEvent to the project.
 * Used by the Frame Test modal to manually add a detected candidate.
 */
export async function addEventToProject(projectId: string, event: RedactionEvent): Promise<RedactionEvent> {
  const { data } = await api.post(`/projects/${projectId}/events`, event)
  return data
}

/**
 * Accept or reject a single redaction event.
 *
 * @param status - One of 'accepted', 'rejected', or 'pending'.
 */
export async function updateEventStatus(
  projectId: string,
  eventId: string,
  status: 'accepted' | 'rejected' | 'pending'
): Promise<void> {
  await api.patch(`/projects/${projectId}/events/${eventId}/status`, null, {
    params: { status },
  })
}

/**
 * Accept, reject, or reset multiple events in a single request.
 *
 * @param eventIds - Specific event IDs to update, or undefined to apply to ALL events.
 */
export async function bulkUpdateEventStatus(
  projectId: string,
  status: 'accepted' | 'rejected' | 'pending',
  eventIds?: string[],
): Promise<{ updated: number }> {
  const { data } = await api.patch(`/projects/${projectId}/events/bulk-status`, {
    status,
    event_ids: eventIds ?? null,
  })
  return data
}

// ── Video ─────────────────────────────────────────────────────────────────────

/**
 * Upload a video file and import it into a project.
 *
 * The backend saves the file, extracts metadata via ffprobe, and generates
 * a 720p proxy video for UI playback. This call may take 30–60 seconds for
 * large files while the proxy is being generated.
 *
 * @param file - The video file selected by the user.
 */
export async function importVideo(projectId: string, file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  await api.post(`/video/import/${projectId}`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 300_000, // Proxy generation can take several minutes for long videos
  })
}

/**
 * Return the URL for streaming the proxy video.
 *
 * The backend serves the proxy with HTTP range request support, allowing the
 * browser's <video> element to seek without buffering the full file.
 */
/**
 * Import a video from a local file path (Tauri native dialog mode).
 * Avoids multipart upload — the backend reads the file directly from disk.
 */
export async function importVideoFromPath(projectId: string, path: string): Promise<void> {
  await api.post(`/video/import-path/${projectId}`, { path }, {
    timeout: 300_000,
  })
}

export function proxyVideoUrl(projectId: string): string {
  if (IS_TAURI) return `http://127.0.0.1:${_port}/video/proxy/${projectId}`
  return `/api/video/proxy/${projectId}`
}

// ── Scan ──────────────────────────────────────────────────────────────────────

/**
 * Start the PII detection pipeline for a project.
 *
 * Returns a ``scan_id`` immediately. If a scan is already running for this
 * project (e.g., the user navigated away and came back), returns the existing
 * scan_id with ``resumed: true`` so the client can reconnect to the WebSocket.
 *
 * Connect to the WebSocket returned by ``openScanProgressSocket(scan_id)`` to
 * receive real-time progress events. Results are saved automatically when done.
 */
export async function startScan(projectId: string): Promise<{ scan_id: string; resumed: boolean }> {
  const { data } = await api.post(`/scan/start/${projectId}`)
  return data
}

export async function cancelScan(scanId: string): Promise<void> {
  await api.post(`/scan/cancel/${scanId}`)
}

/**
 * Check whether a scan is currently running for a project.
 *
 * Returns the active scan's id and status, or null if no scan is running.
 * Used when re-opening a project to auto-reconnect to an in-progress scan.
 */
export async function getActiveScan(
  projectId: string,
): Promise<{ scan_id: string; status: string } | null> {
  try {
    const { data } = await api.get(`/scan/active/${projectId}`)
    return data
  } catch {
    return null  // 404 means no active scan — not an error
  }
}

/**
 * Open a WebSocket connection to receive real-time scan progress events.
 *
 * Messages are ``ScanProgressEvent`` JSON objects. The connection closes
 * automatically when the scan reaches 'done' or 'error' stage.
 *
 * @param scanId - The scan ID returned by ``startScan()``.
 */
export function openScanProgressSocket(scanId: string): WebSocket {
  const base = wsBase()
  if (IS_TAURI) return new WebSocket(`${base}/scan/progress/${scanId}`)
  return new WebSocket(`${base}/ws/scan/progress/${scanId}`)
}

/**
 * Apply a redaction style to all (or a subset of) events in one request.
 *
 * @param eventIds - Specific event IDs to update, or undefined to apply to ALL events.
 */
export async function bulkUpdateEventStyle(
  projectId: string,
  style: import('../types').RedactionStyle,
  eventIds?: string[],
): Promise<{ updated: number }> {
  const { data } = await api.patch(`/projects/${projectId}/events/bulk-style`, {
    style,
    event_ids: eventIds ?? null,
  })
  return data
}

/**
 * Update the redaction style (blur/pixelate/solid_box, strength, color) for one event.
 * Changes take effect at export time; no re-scan needed.
 */
export async function updateEventStyle(
  projectId: string,
  eventId: string,
  style: import('../types').RedactionStyle
): Promise<import('../types').RedactionEvent> {
  const { data } = await api.patch(`/projects/${projectId}/events/${eventId}/style`, style)
  return data
}

/**
 * Replace a single event's keyframe list (used by resize handles).
 */
export async function updateEventKeyframes(
  projectId: string,
  eventId: string,
  keyframes: import('../types').Keyframe[]
): Promise<import('../types').RedactionEvent> {
  const { data } = await api.patch(`/projects/${projectId}/events/${eventId}/keyframes`, { keyframes })
  return data
}

/**
 * Run tracking on a manually-drawn single-keyframe event.
 *
 * By default, tracks bidirectionally (forward + backward) using CSRT.
 * Pass { static: true } to pin the box at a fixed position for the full video.
 */
export async function trackManualEvent(
  projectId: string,
  eventId: string,
  options?: { static?: boolean },
): Promise<import('../types').RedactionEvent> {
  const { data } = await api.post(`/scan/track-event/${projectId}/${eventId}`, null, {
    params: options,
    timeout: 300_000,  // Tracking a long video can take minutes
  })
  return data
}

/**
 * Run OCR + Presidio on a single frame and return raw, unfiltered results.
 * Use this to verify detection is working before running a full scan.
 *
 * The timeout is long because the first call loads EasyOCR and Presidio models.
 */
export async function testFrame(projectId: string, frameIndex: number): Promise<FrameTestResult> {
  const { data } = await api.get(`/scan/test-frame/${projectId}`, {
    params: { frame_index: frameIndex },
    timeout: 120_000,
  })
  return data
}

/**
 * Scan a single frame for PII and save results as pending RedactionEvents.
 *
 * Unlike testFrame() (read-only diagnostic), this creates real events in the project.
 * Use before a full scan to calibrate detection settings on a specific frame.
 */
export async function scanFrame(
  projectId: string,
  frameIndex: number,
): Promise<{ events: RedactionEvent[]; count: number }> {
  const { data } = await api.post(`/scan/frame/${projectId}`, null, {
    params: { frame_index: frameIndex },
    timeout: 120_000,
  })
  return data
}

/**
 * Start a scan limited to a specific time range (start_ms to end_ms).
 *
 * Returns a scan_id immediately. Connect to openScanProgressSocket(scan_id)
 * for real-time progress. New events are appended to the project (existing
 * events from other ranges are preserved).
 */
export async function startRangeScan(
  projectId: string,
  startMs: number,
  endMs: number,
): Promise<{ scan_id: string; resumed: boolean }> {
  const { data } = await api.post(`/scan/range/${projectId}`, null, {
    params: { start_ms: startMs, end_ms: endMs },
  })
  return data
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function updateProjectSettings(
  projectId: string,
  scan: ScanSettings,
  output: OutputSettings,
): Promise<Project> {
  const { data } = await api.patch(`/projects/${projectId}/settings`, {
    scan_settings: scan,
    output_settings: output,
  })
  return data
}

export async function getRules(): Promise<{ default: Rule[]; custom: Rule[] }> {
  const { data } = await api.get('/rules/')
  return data
}

export async function addCustomRule(rule: Rule): Promise<{ added: string }> {
  const { data } = await api.post('/rules/custom', rule)
  return data
}

export async function updateCustomRule(
  ruleId: string,
  patch: Partial<Omit<Rule, 'rule_id'>>,
): Promise<Rule> {
  const { data } = await api.patch(`/rules/custom/${ruleId}`, patch)
  return data
}

export async function deleteCustomRule(ruleId: string): Promise<void> {
  await api.delete(`/rules/custom/${ruleId}`)
}

export async function testRule(
  pattern: string,
  sampleText: string,
): Promise<{ matches: string[]; count: number }> {
  const { data } = await api.post('/rules/test', null, {
    params: { pattern, sample_text: sampleText },
  })
  return data
}

// ── Presets ───────────────────────────────────────────────────────────────────

export async function getPresets(): Promise<any[]> {
  const { data } = await api.get('/presets/')
  return data
}

export async function getPreset(presetId: string): Promise<any> {
  const { data } = await api.get(`/presets/${presetId}`)
  return data
}

export async function saveCustomPreset(preset: {
  preset_id: string
  name: string
  description?: string
  category?: string
  scan_settings: Record<string, unknown>
}): Promise<{ saved: string }> {
  const { data } = await api.post('/presets/custom', preset)
  return data
}

export async function deleteCustomPreset(presetId: string): Promise<void> {
  await api.delete(`/presets/custom/${presetId}`)
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Start exporting the redacted video for a project.
 *
 * Only accepted events are included. Returns an ``export_id`` immediately.
 * Connect to ``openExportProgressSocket(export_id)`` for frame-level progress,
 * or poll ``GET /export/{project_id}/status/{export_id}`` as an alternative.
 */
export async function startExport(projectId: string): Promise<{ export_id: string; status: string }> {
  const { data } = await api.post(`/export/${projectId}`, null, { timeout: 30_000 })
  return data
}

/**
 * Open a WebSocket connection to receive real-time export encoding progress.
 *
 * Messages include ``stage``, ``current_frame``, ``total_frames``, and ``pct``.
 * The connection closes when export is 'done' or 'error'.
 */
export function openExportProgressSocket(exportId: string): WebSocket {
  const base = wsBase()
  if (IS_TAURI) return new WebSocket(`${base}/export/progress/${exportId}`)
  return new WebSocket(`${base}/ws/export/progress/${exportId}`)
}

/**
 * Return the download URL for the most recently exported video of a project.
 * Use this as an ``<a href>`` download link after export completes.
 */
export function exportDownloadUrl(projectId: string): string {
  if (IS_TAURI) return `http://127.0.0.1:${_port}/export/${projectId}/download`
  return `/api/export/${projectId}/download`
}

/**
 * Fetch an audit report for the project.
 *
 * @param format - 'json' for a structured report; 'html' for a human-readable summary.
 */
export async function getReport(projectId: string, format: 'json' | 'html' = 'json'): Promise<unknown> {
  const { data } = await api.get(`/export/${projectId}/report`, { params: { format } })
  return data
}

/**
 * Return the URL to download an audit report in the given format.
 * Use as an href or with window.open() for direct browser download.
 */
export function reportDownloadUrl(projectId: string, format: 'json' | 'html' = 'html'): string {
  if (IS_TAURI) return `http://127.0.0.1:${_port}/export/${projectId}/report?format=${format}`
  return `/api/export/${projectId}/report?format=${format}`
}

// ── Batch ────────────────────────────────────────────────────────────────────

/** Submit a batch of video file paths for processing. */
export async function submitBatch(body: {
  video_paths: string[]
  scan_settings: import('../types').ScanSettings
  output_settings: import('../types').OutputSettings
  auto_accept?: boolean
  auto_export?: boolean
}): Promise<{ batch_id: string; total: number; status: string }> {
  const { data } = await api.post('/batch/submit', body, { timeout: 30_000 })
  return data
}

/** List all batch jobs (running and completed). */
export async function listBatches(): Promise<any[]> {
  const { data } = await api.get('/batch/')
  return data
}

/** Get the current status of a batch job. */
export async function getBatchStatus(batchId: string): Promise<any> {
  const { data } = await api.get(`/batch/${batchId}`)
  return data
}

/** Cancel a running batch job. */
export async function cancelBatch(batchId: string): Promise<void> {
  await api.post(`/batch/${batchId}/cancel`)
}

/** Open a WebSocket for real-time batch progress events. */
export function openBatchProgressSocket(batchId: string): WebSocket {
  const base = wsBase()
  if (IS_TAURI) return new WebSocket(`${base}/batch/progress/${batchId}`)
  return new WebSocket(`${base}/ws/batch/progress/${batchId}`)
}

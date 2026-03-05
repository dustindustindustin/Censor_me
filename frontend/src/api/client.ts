/**
 * Typed API client for the Censor Me backend.
 *
 * All HTTP calls to the FastAPI backend go through this module. Functions
 * return typed responses that match the backend Pydantic models (via the
 * shared types in ``../types``).
 *
 * URL structure:
 *   - REST calls use the ``/api`` prefix (proxied to localhost:8010 by Vite).
 *   - WebSocket calls use the ``/ws`` prefix (proxied to ws://localhost:8010).
 *
 * During development Vite proxies both prefixes to the backend:
 *   /api/* → http://localhost:8010/*  (strips /api)
 *   /ws/*  → ws://localhost:8010/*   (strips /ws)
 */

import axios from 'axios'
import type { Project, SystemStatus } from '../types'

const api = axios.create({
  baseURL: '/api',
  timeout: 30_000,
})

/**
 * Separate axios instance for the startup status poll with a short timeout.
 * If the backend isn't up yet, we want to fail fast (3s) and retry,
 * rather than hanging for 30s on each attempt.
 */
const statusApi = axios.create({
  baseURL: '/api',
  timeout: 3_000,
})

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
export function proxyVideoUrl(projectId: string): string {
  return `/api/video/proxy/${projectId}`
}

// ── Scan ──────────────────────────────────────────────────────────────────────

/**
 * Start the PII detection pipeline for a project.
 *
 * Returns a ``scan_id`` immediately. Connect to the WebSocket returned by
 * ``openScanProgressSocket(scan_id)`` to receive real-time progress events.
 * Results are saved to the project automatically when the scan completes.
 */
export async function startScan(projectId: string): Promise<{ scan_id: string }> {
  const { data } = await api.post(`/scan/start/${projectId}`)
  return data
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
  // Replace http/https with ws/wss so WebSocket uses the right protocol.
  // In dev, Vite's /ws proxy forwards this to ws://localhost:8010/scan/progress/{scanId}.
  const wsBase = window.location.origin.replace(/^http/, 'ws')
  return new WebSocket(`${wsBase}/ws/scan/progress/${scanId}`)
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
  const wsBase = window.location.origin.replace(/^http/, 'ws')
  return new WebSocket(`${wsBase}/ws/export/progress/${exportId}`)
}

/**
 * Return the download URL for the most recently exported video of a project.
 * Use this as an ``<a href>`` download link after export completes.
 */
export function exportDownloadUrl(projectId: string): string {
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

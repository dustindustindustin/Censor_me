/**
 * Shared TypeScript types that mirror the backend Pydantic models.
 *
 * These types are the frontend's contract with the API. Keep them in sync with
 * the corresponding Python models in ``backend/models/``. When the backend schema
 * changes, update these types and the API client together.
 *
 * Naming convention matches the Python models exactly for easy cross-referencing.
 */

// ── PII classification ────────────────────────────────────────────────────────

/**
 * The type of sensitive information detected.
 * Maps 1:1 to backend ``PiiType`` enum values.
 *
 * High-confidence (regex-based): phone, email, credit_card, ssn, account_id, postal_code
 * Medium-confidence (NLP-based): person, address, username
 * Special: custom (user-defined rule), manual (user-drawn), unknown (unmapped)
 */
export type PiiType =
  | 'phone' | 'email' | 'person' | 'address'
  | 'credit_card' | 'ssn' | 'account_id' | 'employee_id'
  | 'postal_code' | 'username' | 'face'
  | 'custom' | 'manual' | 'unknown'

/**
 * The algorithm used to track a bounding box between OCR keyframes.
 * - csrt: OpenCV CSRT correlation filter (default, no GPU required)
 * - sam2: Segment Anything 2 (planned v1.0, GPU required)
 * - manual: User positioned every keyframe by hand
 * - none: Static box, no tracking (single-frame redaction)
 */
export type TrackingMethod = 'csrt' | 'sam2' | 'manual' | 'none'

/**
 * User's review decision for a detected event.
 * - pending: Not yet reviewed; shown on timeline but not exported.
 * - accepted: Confirmed PII; included in the redacted export.
 * - rejected: False positive; excluded from export.
 */
export type EventStatus = 'pending' | 'accepted' | 'rejected'

/** The visual style applied to a redaction region in the exported video. */
export type RedactionStyleType = 'blur' | 'pixelate' | 'solid_box'

// ── Geometry ──────────────────────────────────────────────────────────────────

/**
 * Axis-aligned bounding box in pixel coordinates of the *source* video.
 * The renderer scales these to the output resolution at export time.
 */
export interface BoundingBox {
  x: number  // Left edge in pixels
  y: number  // Top edge in pixels
  w: number  // Width in pixels
  h: number  // Height in pixels
}

/**
 * A bounding box at a specific point in time.
 * The renderer interpolates linearly between adjacent keyframes to produce
 * smooth-moving redaction overlays in the exported video.
 */
export interface Keyframe {
  time_ms: number  // Timestamp in milliseconds from the start of the video
  bbox: BoundingBox
}

/** A contiguous time interval during which a redaction is active. */
export interface TimeRange {
  start_ms: number  // Start of the interval in milliseconds (inclusive)
  end_ms: number    // End of the interval in milliseconds (inclusive)
}

// ── Redaction style ───────────────────────────────────────────────────────────

/** Visual appearance of a redacted region in the exported video. */
export interface RedactionStyle {
  type: RedactionStyleType
  /** Blur kernel size (blur), pixel block size (pixelate), or unused (solid_box). */
  strength: number
  /** Hex color string for solid_box type, e.g. '#000000'. */
  color: string
}

// ── Core model ────────────────────────────────────────────────────────────────

/**
 * The central data model for a single redaction region.
 *
 * Both auto-detected PII events (source='auto') and user-drawn regions
 * (source='manual') share this schema. Stored in project.json and used
 * throughout the pipeline, UI, and export.
 */
export interface RedactionEvent {
  event_id: string
  source: 'auto' | 'manual'
  pii_type: PiiType
  /** Confidence score [0.0–1.0]. Always 1.0 for manual regions. */
  confidence: number
  /** The detected text. null in secure mode (when stored_text is disabled). */
  extracted_text: string | null
  time_ranges: TimeRange[]
  /** Bounding box positions at sampled timestamps; renderer interpolates between them. */
  keyframes: Keyframe[]
  tracking_method: TrackingMethod
  redaction_style: RedactionStyle
  status: EventStatus
}

// ── Video & project ───────────────────────────────────────────────────────────

/** Immutable properties of the imported source video, extracted via ffprobe. */
export interface VideoMetadata {
  path: string
  file_hash: string
  duration_ms: number
  fps: number
  width: number
  height: number
  codec: string
  format: string
}

/**
 * Complete state of a Censor Me project as returned by GET /projects/{id}.
 * Mirrors the backend ``ProjectFile`` Pydantic model.
 */
export interface Project {
  project_id: string
  name: string
  created_at: string   // ISO 8601 UTC timestamp
  updated_at: string   // ISO 8601 UTC timestamp
  video: VideoMetadata | null  // null until a video has been imported
  proxy_path: string | null    // null until proxy generation completes
  scan_settings: ScanSettings
  output_settings: OutputSettings
  events: RedactionEvent[]
}

// ── System status ─────────────────────────────────────────────────────────────

/** Hardware acceleration info returned by GET /system/status. */
export interface GpuInfo {
  cuda_available: boolean
  gpu_name: string | null
  nvenc_available: boolean
  /** Human-readable string for the status bar, e.g. "GPU: RTX A4500". */
  display_name: string
}

/**
 * Backend readiness and hardware status.
 * The frontend polls this endpoint until ready=true before showing the UI.
 */
export interface SystemStatus {
  ready: boolean
  gpu: GpuInfo
}

// ── Test frame live overlay ───────────────────────────────────────────────────

/** A single box drawn on the live video from a test-frame result (cyan overlay). */
export interface TestFrameOverlayBox {
  bbox: [number, number, number, number]  // [x, y, w, h] in source video pixels
  pii_type: PiiType
  text: string
}

// ── Settings ──────────────────────────────────────────────────────────────────

export type RuleType = 'regex' | 'context' | 'allowlist' | 'denylist' | 'field_label'

export interface Rule {
  rule_id: string
  name: string
  type: RuleType
  enabled: boolean
  pattern: string | null
  label: string | null
  priority: number
  confidence: number
  context_pixels: number | null
  description: string
}

export interface ScanSettings {
  preset: string
  ocr_sample_interval: number
  ocr_resolution_scale: number
  confidence_threshold: number
  entity_confidence_overrides: Record<string, number>
  detect_faces: boolean
  secure_mode: boolean
  default_redaction_style: RedactionStyle
}

export interface OutputSettings {
  codec: string
  resolution: string
  custom_width: number | null
  custom_height: number | null
  quality_mode: string
  crf: number
  bitrate_kbps: number | null
  use_nvenc: boolean
  watermark: boolean
}

// ── Frame test diagnostic ─────────────────────────────────────────────────────

export interface OcrBox {
  text: string
  confidence: number
  bbox: [number, number, number, number]  // [x, y, w, h]
}

export interface FrameTestCandidate {
  text: string
  pii_type: PiiType
  confidence: number
  bbox: [number, number, number, number]
}

export interface FrameTestRawResult {
  entity_type: string
  text: string
  confidence: number
  mapped_pii_type: PiiType | null
  skip_reason: string | null
  would_appear_in_scan: boolean
}

export interface FrameTestResult {
  frame_index: number
  time_ms: number
  total_frames: number
  fps: number
  video_path: string
  use_gpu: boolean
  ocr: {
    box_count: number
    boxes: OcrBox[]
  }
  presidio: {
    error: string | null
    active_threshold: number
    raw_count: number
    kept_count: number
    filtered_count: number
    candidates: FrameTestCandidate[]
    raw: FrameTestRawResult[]
  }
  error?: string
}

// ── WebSocket progress events ─────────────────────────────────────────────────

/**
 * Discriminated union of all progress events emitted by the scan pipeline.
 *
 * Each event has a ``stage`` field used as the discriminant. The frontend's
 * ``useScanProgress`` hook maps these to store updates and UI changes.
 *
 * Lifecycle: starting → ocr (N times) → linking → link_done → tracking →
 *            track (M times) → done
 *
 * Error at any stage emits: error
 */
/** A single PII detection box included in a live scan preview event. */
export interface ScanPreviewBox {
  bbox: [number, number, number, number]  // [x, y, w, h] in source video pixels
  pii_type: PiiType
}

export type ScanProgressEvent =
  | { stage: 'starting'; total_ocr_frames: number }
  | { stage: 'ocr'; frame: number; time_ms: number; ocr_boxes: number; findings_so_far: number; progress_pct: number; scan_boxes: ScanPreviewBox[] }
  | { stage: 'scene_change'; frame: number; time_ms: number }
  | { stage: 'linking'; total_candidates: number; progress_pct?: number }
  | { stage: 'link_done'; events_found: number }
  | { stage: 'refining'; total_refine_frames?: number; progress_pct?: number }
  | { stage: 'refine_done'; events_found: number; extra_candidates: number }
  | { stage: 'tracking'; total_events: number }
  | { stage: 'track'; frames_done: number; total_frames: number; active_trackers: number; progress_pct: number; time_ms: number }
  | { stage: 'done'; total_findings: number }
  | { stage: 'error'; message: string }

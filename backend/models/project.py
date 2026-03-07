"""
Project file data model — persisted as JSON alongside the source video.

A "project" in Censor Me is the unit of work. It ties together:
- The path and metadata of the source video
- The path of the generated proxy video (for UI preview)
- Scan and output settings chosen by the user
- The full list of RedactionEvents (both auto-detected and manual)

Projects are saved as ``project.json`` inside a per-project directory under
``PROJECTS_DIR`` (default: ``~/censor_me_projects/{project_id}/``).
"""

from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, Field

from backend.models.events import RedactionEvent, RedactionStyle


class VideoMetadata(BaseModel):
    """
    Immutable properties of the imported source video.

    Extracted once at import time via ``ffprobe`` and stored in the project.
    Used by the scan pipeline (to compute timestamps from frame indices),
    the renderer (to match output resolution), and the UI (for display).
    """

    path: str = Field(description="Absolute path to the source video file.")
    file_hash: str = Field(description="SHA-256 hash for change detection.")
    duration_ms: int = Field(description="Total duration in milliseconds.")
    fps: float = Field(description="Frames per second of the source video.")
    width: int = Field(description="Frame width in pixels (native resolution).")
    height: int = Field(description="Frame height in pixels (native resolution).")
    codec: str = Field(description="Video codec name, e.g. 'h264', 'hevc'.")
    format: str = Field(description="Container format, e.g. 'mov,mp4,m4a,3gp'.")


class OutputSettings(BaseModel):
    """
    Settings that control the exported redacted video.

    These are applied at export time by ``RedactionRenderer`` and ``VideoService``.
    Changing them after a scan does not require re-scanning — only re-exporting.
    """

    codec: str = Field(
        default="h264",
        description="Output video codec. 'h264' (default) or 'h265'."
    )
    resolution: str = Field(
        default="match_input",
        description=(
            "Output resolution. One of: 'match_input', '720p', '1080p', '4K', 'custom'."
        )
    )
    custom_width: int | None = Field(
        default=None,
        description="Output width in pixels when resolution='custom'."
    )
    custom_height: int | None = Field(
        default=None,
        description="Output height in pixels when resolution='custom'."
    )
    quality_mode: str = Field(
        default="crf",
        description="Quality control mode: 'crf' (constant rate factor) or 'bitrate'."
    )
    crf: int = Field(
        default=23, ge=0, le=51,
        description=(
            "CRF value for libx264 (lower = better quality, larger file). "
            "Also maps to NVENC -cq:v when GPU encoding is used."
        )
    )
    bitrate_kbps: int | None = Field(
        default=None,
        description="Target bitrate in kbps when quality_mode='bitrate'."
    )
    use_nvenc: bool = Field(
        default=True,
        description=(
            "Attempt NVENC hardware encoding when a compatible GPU is detected. "
            "Falls back to libx264 automatically if NVENC is unavailable."
        )
    )
    watermark: bool = Field(
        default=False,
        description="Overlay a 'Redacted' watermark on the exported video."
    )


class ScanSettings(BaseModel):
    """
    Settings that control the OCR + PII detection pipeline.

    These are applied at scan time. Changing them requires re-running the scan
    to update findings.
    """

    preset: str = Field(
        default="screen_recording_pii",
        description="Named preset that configures rules and sampling defaults."
    )
    ocr_sample_interval: int = Field(
        default=5,
        description=(
            "Analyze 1 frame every N frames. At 30 fps, interval=5 gives 6 fps OCR. "
            "Lower values increase accuracy but slow down scanning."
        )
    )
    ocr_resolution_scale: float = Field(
        default=1.0,
        description=(
            "Scale factor applied to frames before OCR. "
            "1.5 or 2.0 helps detect small-font text; increases scan time."
        )
    )
    confidence_threshold: float = Field(
        default=0.35,
        description=(
            "Minimum Presidio confidence score [0.0–1.0] to include a detection. "
            "Higher values reduce false positives; lower values improve recall. "
            "0.35 is recommended — Presidio phone/email recognizers often score 0.4–0.5."
        )
    )
    entity_confidence_overrides: dict[str, float] = Field(
        default_factory=lambda: {
            "phone": 0.35,
            "email": 0.35,
            "person": 0.50,
            "ssn": 0.35,
            "credit_card": 0.35,
            "account_id": 0.35,
            "face": 0.40,
        },
        description=(
            "Per-PII-type confidence thresholds. Overrides the global "
            "confidence_threshold for specific entity types. Types not listed "
            "here fall back to the global threshold."
        )
    )
    detect_faces: bool = Field(
        default=True,
        description=(
            "When True, run face detection on each sampled frame in addition "
            "to OCR. Catches webcam overlays and profile pictures."
        )
    )
    secure_mode: bool = Field(
        default=True,
        description=(
            "When True, ``extracted_text`` is never stored in the project file. "
            "Findings are tracked by bbox/time only. Reduces PII exposure at rest."
        )
    )
    default_redaction_style: RedactionStyle = Field(
        default_factory=RedactionStyle,
        description=(
            "Default redaction style applied to new events created by scans or "
            "manual drawing. Changing this affects future events only."
        )
    )


class ProjectFile(BaseModel):
    """
    The complete state of a Censor Me project, serialized to ``project.json``.

    This is the single source of truth for a project. It is loaded at startup,
    updated incrementally during scan and review, and saved back to disk.

    The project directory layout::

        ~/censor_me_projects/
        └── {project_id}/
            ├── project.json        ← this model
            ├── {source_video}.mp4  ← uploaded source (if stored locally)
            ├── .proxy/
            │   └── proxy.mp4       ← 720p proxy for UI playback
            └── exports/
                └── {name}_redacted.mp4
    """

    project_id: str = Field(default_factory=lambda: str(uuid4()))
    name: str = Field(default="Untitled Project", max_length=200)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    video: VideoMetadata | None = Field(
        default=None,
        description="Source video metadata. None until a video has been imported."
    )
    proxy_path: str | None = Field(
        default=None,
        description="Absolute path to the generated proxy video file."
    )
    scan_settings: ScanSettings = Field(default_factory=ScanSettings)
    output_settings: OutputSettings = Field(default_factory=OutputSettings)
    events: list[RedactionEvent] = Field(
        default_factory=list,
        description="All detected and manually-added redaction events."
    )

    def save(self, project_dir: Path) -> None:
        """
        Serialize this project to ``{project_dir}/project.json``.

        Updates ``updated_at`` to the current UTC time before writing.
        Creates the directory if it does not exist.
        """
        self.updated_at = datetime.now(timezone.utc)
        project_dir.mkdir(parents=True, exist_ok=True)
        project_file = project_dir / "project.json"
        project_file.write_text(self.model_dump_json(indent=2))

    @classmethod
    def load(cls, project_dir: Path) -> "ProjectFile":
        """
        Deserialize a project from ``{project_dir}/project.json``.

        Raises ``FileNotFoundError`` if the project file does not exist.
        Raises ``ValidationError`` if the JSON does not match the schema.
        """
        import json

        project_file = project_dir / "project.json"
        data = json.loads(project_file.read_text())
        return cls.model_validate(data)

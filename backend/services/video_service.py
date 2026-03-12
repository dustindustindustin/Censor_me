"""
VideoService — all ffmpeg-based video I/O operations.

Responsibilities:
  - Extract video metadata (fps, duration, resolution, codec) via ``ffprobe``.
  - Generate a 720p proxy video for responsive UI playback.
  - Extract individual frames for OCR analysis.
  - Hash source files to detect changes between sessions.

The actual redaction rendering and encoding is handled by ``RedactionRenderer``,
which streams processed frames directly to ffmpeg's stdin (no temp files).
"""

import hashlib
from pathlib import Path

import cv2
import ffmpeg

from backend.models.project import VideoMetadata
from backend.utils.ffmpeg_path import get_ffmpeg_path, get_ffprobe_path


class VideoService:
    """
    Provides video I/O operations backed by ffmpeg and OpenCV.

    Most methods work with the *source* (full-resolution) video. The proxy
    is a separately generated 720p copy used only for UI playback.
    """

    def get_metadata(self, video_path: Path) -> VideoMetadata:
        """
        Extract metadata from a video file using ``ffprobe``.

        Parses the first video stream found in the file. Audio streams and
        other tracks are ignored; only video properties are extracted.

        Args:
            video_path: Path to the video file.

        Returns:
            A ``VideoMetadata`` instance with fps, resolution, codec, etc.

        Raises:
            ValueError: If no video stream is found in the file.
            ffmpeg.Error: If ffprobe cannot open or parse the file.
        """
        probe = ffmpeg.probe(str(video_path), cmd=get_ffprobe_path())
        video_stream = next(
            (s for s in probe["streams"] if s["codec_type"] == "video"), None
        )
        if not video_stream:
            raise ValueError(f"No video stream found in {video_path}")

        # r_frame_rate is a rational string like "30/1" or "2997/100"
        fps_parts = video_stream.get("r_frame_rate", "30/1").split("/")
        fps = float(fps_parts[0]) / float(fps_parts[1])

        duration_ms = int(float(probe["format"].get("duration", 0)) * 1000)

        return VideoMetadata(
            path=str(video_path),
            file_hash=self._hash_file(video_path),
            duration_ms=duration_ms,
            fps=fps,
            width=video_stream.get("width", 0),
            height=video_stream.get("height", 0),
            codec=video_stream.get("codec_name", "unknown"),
            format=probe["format"].get("format_name", "unknown"),
        )

    def generate_proxy(self, video_path: Path, project_dir: Path, height: int = 720) -> Path:
        """
        Generate a 720p proxy video for UI preview and store it in the project.

        The proxy is encoded with ``-movflags +faststart`` so the browser can
        begin playing before the file is fully downloaded and can seek freely.
        Using a lower resolution proxy keeps the UI responsive while the full-
        resolution source is used only at export time.

        Args:
            video_path:  Path to the full-resolution source video.
            project_dir: The project directory; proxy is stored in ``.proxy/``.
            height:      Target height in pixels (width scales proportionally).

        Returns:
            Path to the generated proxy file at ``{project_dir}/.proxy/proxy.mp4``.
        """
        proxy_dir = project_dir / ".proxy"
        proxy_dir.mkdir(parents=True, exist_ok=True)
        proxy_path = proxy_dir / "proxy.mp4"

        (
            ffmpeg
            .input(str(video_path))
            # -2 means "make width divisible by 2 while maintaining aspect ratio"
            .filter("scale", -2, height)
            .output(
                str(proxy_path),
                vcodec="libx264",
                crf=28,           # Slightly lower quality is fine for preview
                preset="fast",
                movflags="+faststart",  # Moves moov atom to the front for browser seek
                acodec="aac",
            )
            .overwrite_output()
            .run(cmd=get_ffmpeg_path(), quiet=True)
        )

        return proxy_path

    def extract_frames(
        self,
        video_path: Path,
        interval: int = 5,
        scale: float = 1.0,
    ):
        """
        Generator that yields selected frames from a video for OCR processing.

        Uses ``CAP_PROP_POS_FRAMES`` seeking to jump directly to each target
        frame without decoding the frames in between. This is ~5× faster than
        reading every frame and discarding non-sampled ones.

        Note: The scan orchestrator uses inline adaptive sampling. This method
        is a lower-level frame reader for callers that need sequential frame access.

        Args:
            video_path: Source video file path.
            interval:   Yield 1 frame every N frames.
            scale:      Resize factor applied before yielding. 1.5 helps with small text.

        Yields:
            Tuples of ``(frame_index, time_ms, frame_array)`` where:
            - ``frame_index`` is the 0-based frame number in the source video.
            - ``time_ms`` is the corresponding timestamp in milliseconds.
            - ``frame_array`` is a BGR numpy array.
        """
        cap = cv2.VideoCapture(str(video_path))
        try:
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            frame_idx = 0

            while frame_idx < total:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                ret, frame = cap.read()
                if not ret:
                    break

                if scale != 1.0:
                    h, w = frame.shape[:2]
                    frame = cv2.resize(frame, (int(w * scale), int(h * scale)))

                time_ms = int((frame_idx / fps) * 1000)
                yield frame_idx, time_ms, frame

                frame_idx += interval
        finally:
            cap.release()

    def _hash_file(self, path: Path, chunk_size: int = 65536) -> str:
        """
        Compute a SHA-256 hash of a file for change detection.

        Used to detect if the source video has been replaced since the project
        was last saved, so the app can warn the user that findings may be stale.

        Args:
            path:       File to hash.
            chunk_size: Number of bytes to read per chunk (avoids loading the
                        entire file into memory).

        Returns:
            Lowercase hex string of the SHA-256 digest.
        """
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(chunk_size):
                h.update(chunk)
        return h.hexdigest()

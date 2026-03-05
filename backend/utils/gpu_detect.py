"""
GPU and hardware capability detection.

Runs at startup to determine whether CUDA (for OCR) and NVENC (for video encoding)
are available. Results are stored in ``app.state.gpu`` and exposed to the frontend
via ``GET /system/status`` for display in the status bar.

Detection is done by running external commands (``nvidia-smi``, ``nvcc``, ``ffmpeg``)
as subprocesses rather than importing CUDA bindings, so the app starts correctly
even when no GPU is present.
"""

import subprocess
from dataclasses import dataclass


@dataclass
class GpuInfo:
    """
    Hardware acceleration capabilities detected at startup.

    Attributes:
        cuda_available:  True if an NVIDIA GPU with CUDA support was found.
        gpu_name:        Display name of the GPU (e.g., "NVIDIA RTX A4500").
                         None if no GPU was detected.
        cuda_version:    CUDA toolkit version string (e.g., "12.0").
                         None if nvcc is not on PATH.
        nvenc_available: True if ffmpeg was compiled with h264_nvenc encoder.
                         Always False when cuda_available is False.
        display_name:    Human-readable string for the UI status bar
                         (e.g., "GPU: NVIDIA RTX A4500" or "CPU only").
    """

    cuda_available: bool
    gpu_name: str | None
    cuda_version: str | None
    nvenc_available: bool
    display_name: str


def detect_gpu() -> GpuInfo:
    """
    Probe for NVIDIA GPU, CUDA, and NVENC support.

    Attempts three checks in order:
    1. ``nvidia-smi`` — confirms an NVIDIA GPU and driver are present.
    2. ``nvcc --version`` — retrieves the installed CUDA toolkit version.
    3. ``ffmpeg -encoders`` — checks if h264_nvenc is compiled into ffmpeg.

    All checks are non-fatal: if a command is not found or times out, the
    corresponding capability is marked as unavailable and detection continues.

    Returns:
        A ``GpuInfo`` dataclass summarizing available hardware acceleration.
    """
    cuda_available = False
    gpu_name = None
    cuda_version = None
    nvenc_available = False

    # --- Check 1: NVIDIA GPU via nvidia-smi ---
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            # Output format: "GPU Name, Driver Version"
            parts = result.stdout.strip().split(", ")
            gpu_name = parts[0].strip()
            cuda_available = True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        # nvidia-smi not found or timed out → no GPU
        pass

    # --- Check 2: CUDA toolkit version via nvcc ---
    if cuda_available:
        try:
            result = subprocess.run(
                ["nvcc", "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                # Look for a line containing "release X.Y" in the version output
                for line in result.stdout.splitlines():
                    if "release" in line.lower():
                        cuda_version = line.split("release")[-1].split(",")[0].strip()
                        break
        except (FileNotFoundError, subprocess.TimeoutExpired):
            # nvcc not on PATH — CUDA toolkit may be installed without it being in PATH
            pass

    # --- Check 3: NVENC support in ffmpeg ---
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and "h264_nvenc" in result.stdout:
            # NVENC is only usable when CUDA is also available
            nvenc_available = cuda_available
    except (FileNotFoundError, subprocess.TimeoutExpired):
        # ffmpeg not found; startup.py will catch this separately with a clearer error
        pass

    display_name = f"GPU: {gpu_name}" if (cuda_available and gpu_name) else "CPU only (no GPU detected)"

    return GpuInfo(
        cuda_available=cuda_available,
        gpu_name=gpu_name,
        cuda_version=cuda_version,
        nvenc_available=nvenc_available,
        display_name=display_name,
    )

"""
GPU and hardware capability detection.

Runs at startup to determine what GPU (NVIDIA, AMD, Apple Metal) and hardware
video encoder (NVENC, AMF, VideoToolbox) are available. Results are stored in
``app.state.gpu`` and exposed to the frontend via ``GET /system/status``.

Detection is done by running external commands (``nvidia-smi``, ``rocm-smi``,
``ffmpeg``) as subprocesses and querying PyTorch backends, so the app starts
correctly even when no GPU is present.
"""

import logging
import subprocess
import sys
from dataclasses import dataclass

from backend.utils.ffmpeg_path import get_ffmpeg_path

logger = logging.getLogger(__name__)


@dataclass
class GpuInfo:
    """
    Hardware acceleration capabilities detected at startup.

    Attributes:
        gpu_vendor:      "nvidia", "amd", "apple", or "none".
        gpu_name:        Display name of the GPU (e.g., "NVIDIA RTX A4500").
        cuda_available:  True if NVIDIA CUDA is usable via PyTorch.
        cuda_version:    CUDA toolkit version string (e.g., "12.4"). None if N/A.
        mps_available:   True on macOS with Metal Performance Shaders.
        rocm_available:  True on Linux with AMD ROCm (PyTorch HIP backend).
        directml_available: True on Windows with torch-directml installed.
        hw_encoder:      ffmpeg encoder name: "h264_nvenc", "h264_amf",
                         "h264_videotoolbox", or None (CPU-only).
        nvenc_available: True if hw_encoder == "h264_nvenc". Kept for backward compat.
        display_name:    Human-readable string for the UI status bar.
    """

    gpu_vendor: str
    gpu_name: str | None
    cuda_available: bool
    cuda_version: str | None
    mps_available: bool
    rocm_available: bool
    directml_available: bool
    hw_encoder: str | None
    nvenc_available: bool
    display_name: str

    @property
    def gpu_available_for_ocr(self) -> bool:
        """True if any PyTorch GPU backend is available for EasyOCR inference.

        ROCm uses torch.cuda APIs under the hood (HIP), so easyocr.Reader(gpu=True)
        works for ROCm already. MPS works with EasyOCR 1.7+.
        """
        return self.cuda_available or self.rocm_available or self.mps_available


def _check_ffmpeg_encoder(encoder_name: str) -> bool:
    """Return True if ffmpeg has the given encoder compiled in."""
    try:
        result = subprocess.run(
            [get_ffmpeg_path(), "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0 and encoder_name in result.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _detect_nvidia() -> tuple[bool, bool, str | None, str | None]:
    """Check for NVIDIA GPU via nvidia-smi and CUDA toolkit via nvcc.

    Returns (nvidia_hw_found, cuda_torch_ready, gpu_name, cuda_version).

    ``nvidia_hw_found`` is True whenever nvidia-smi exits 0 — independent of
    whether the bundled PyTorch has CUDA support compiled in.
    ``cuda_torch_ready`` is True only when both nvidia_hw_found AND
    torch.cuda.is_available().
    """
    nvidia_hw_found = False
    cuda_torch_ready = False
    gpu_name = None
    cuda_version = None

    # nvidia-smi
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            parts = result.stdout.strip().split(", ")
            gpu_name = parts[0].strip()
            nvidia_hw_found = True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Verify PyTorch can actually use CUDA (not just driver present)
    if nvidia_hw_found:
        try:
            import torch
            if not torch.cuda.is_available():
                logger.warning(
                    "nvidia-smi detected a GPU but torch.cuda.is_available() returned False. "
                    "PyTorch was likely installed without CUDA support. "
                    "Run scripts/install-pytorch to fix this."
                )
            elif getattr(torch.version, "hip", None):
                # ROCm HIP backend — not real NVIDIA CUDA
                pass
            else:
                cuda_torch_ready = True
        except ImportError:
            pass

    # CUDA toolkit version via nvcc (only relevant when torch CUDA is ready)
    if cuda_torch_ready:
        try:
            result = subprocess.run(
                ["nvcc", "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    if "release" in line.lower():
                        cuda_version = line.split("release")[-1].split(",")[0].strip()
                        break
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    return nvidia_hw_found, cuda_torch_ready, gpu_name, cuda_version


def _detect_apple_mps() -> tuple[bool, str | None]:
    """Check for Apple Metal Performance Shaders (macOS only).

    Returns (mps_available, gpu_name).
    """
    if sys.platform != "darwin":
        return False, None

    mps_available = False
    gpu_name = None

    try:
        import torch
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            mps_available = True
    except ImportError:
        pass

    # Get Apple GPU name via system_profiler
    if mps_available:
        try:
            result = subprocess.run(
                ["system_profiler", "SPDisplaysDataType"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    line = line.strip()
                    if line.startswith("Chipset Model:") or line.startswith("Chip:"):
                        gpu_name = line.split(":", 1)[1].strip()
                        break
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        if not gpu_name:
            gpu_name = "Apple GPU"

    return mps_available, gpu_name


def _detect_amd_rocm() -> tuple[bool, str | None]:
    """Check for AMD ROCm (Linux) via rocm-smi and PyTorch HIP backend.

    Returns (rocm_available, gpu_name).
    """
    rocm_available = False
    gpu_name = None

    # Check PyTorch HIP backend first (most reliable)
    try:
        import torch
        if torch.cuda.is_available() and getattr(torch.version, "hip", None):
            rocm_available = True
            if torch.cuda.device_count() > 0:
                gpu_name = torch.cuda.get_device_name(0)
    except ImportError:
        pass

    # Fallback: check rocm-smi
    if not rocm_available:
        try:
            result = subprocess.run(
                ["rocm-smi", "--showproductname"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                rocm_available = True
                for line in result.stdout.splitlines():
                    line = line.strip()
                    if line and not line.startswith("=") and "GPU" not in line.upper()[:3]:
                        gpu_name = line
                        break
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    return rocm_available, gpu_name


def _detect_amd_windows() -> tuple[bool, str | None]:
    """Check for AMD GPU on Windows (for DirectML / AMF encoding).

    Returns (amd_detected, gpu_name).
    """
    if sys.platform != "win32":
        return False, None

    gpu_name = None
    try:
        result = subprocess.run(
            ["wmic", "path", "win32_videocontroller", "get", "name"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                line = line.strip()
                if line and line.lower() != "name" and ("amd" in line.lower() or "radeon" in line.lower()):  # noqa: E501
                    gpu_name = line
                    break
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    return gpu_name is not None, gpu_name


def _detect_directml() -> bool:
    """Check if torch-directml is installed and usable."""
    try:
        import torch_directml  # noqa: F401
        return True
    except ImportError:
        return False


def detect_gpu() -> GpuInfo:
    """
    Probe for GPU acceleration: NVIDIA CUDA, Apple MPS, or AMD ROCm/AMF.

    Detection order:
    1. NVIDIA (nvidia-smi + torch.cuda + h264_nvenc)
    2. Apple Metal/MPS (macOS only, + h264_videotoolbox)
    3. AMD ROCm (Linux, torch HIP + h264_amf)
    4. AMD Windows (wmic + h264_amf + optional DirectML)
    5. CPU fallback

    Returns:
        A ``GpuInfo`` dataclass summarizing available hardware acceleration.
    """

    # --- 1. Try NVIDIA ---
    nvidia_hw_found, cuda_torch_ready, nvidia_name, cuda_version = _detect_nvidia()
    if cuda_torch_ready:
        hw_encoder = "h264_nvenc" if _check_ffmpeg_encoder("h264_nvenc") else None
        display = f"GPU: {nvidia_name}" if nvidia_name else "GPU: NVIDIA"
        logger.info("GPU detected: NVIDIA — %s (CUDA %s, encoder=%s)",
                     nvidia_name, cuda_version, hw_encoder)
        return GpuInfo(
            gpu_vendor="nvidia",
            gpu_name=nvidia_name,
            cuda_available=True,
            cuda_version=cuda_version,
            mps_available=False,
            rocm_available=False,
            directml_available=False,
            hw_encoder=hw_encoder,
            nvenc_available=hw_encoder == "h264_nvenc",
            display_name=display,
        )
    elif nvidia_hw_found:
        hw_encoder = "h264_nvenc" if _check_ffmpeg_encoder("h264_nvenc") else None
        display = f"GPU: {nvidia_name} (CUDA not installed)" if nvidia_name else "GPU: NVIDIA (CUDA not installed)"  # noqa: E501
        logger.info("NVIDIA GPU found but CUDA torch not installed: %s", nvidia_name)
        return GpuInfo(
            gpu_vendor="nvidia",
            gpu_name=nvidia_name,
            cuda_available=False,
            cuda_version=None,
            mps_available=False,
            rocm_available=False,
            directml_available=False,
            hw_encoder=hw_encoder,
            nvenc_available=False,
            display_name=display,
        )

    # --- 2. Try Apple MPS (macOS) ---
    mps_available, apple_name = _detect_apple_mps()
    if mps_available:
        hw_encoder = "h264_videotoolbox" if _check_ffmpeg_encoder("h264_videotoolbox") else None
        display = f"GPU: {apple_name} (Metal)" if apple_name else "GPU: Apple Metal"
        logger.info("GPU detected: Apple Metal — %s (encoder=%s)", apple_name, hw_encoder)
        return GpuInfo(
            gpu_vendor="apple",
            gpu_name=apple_name,
            cuda_available=False,
            cuda_version=None,
            mps_available=True,
            rocm_available=False,
            directml_available=False,
            hw_encoder=hw_encoder,
            nvenc_available=False,
            display_name=display,
        )

    # --- 3. Try AMD ROCm (Linux) ---
    rocm_available, rocm_name = _detect_amd_rocm()
    if rocm_available:
        hw_encoder = "h264_amf" if _check_ffmpeg_encoder("h264_amf") else None
        display = f"GPU: {rocm_name} (ROCm)" if rocm_name else "GPU: AMD (ROCm)"
        logger.info("GPU detected: AMD ROCm — %s (encoder=%s)", rocm_name, hw_encoder)
        return GpuInfo(
            gpu_vendor="amd",
            gpu_name=rocm_name,
            cuda_available=False,
            cuda_version=None,
            mps_available=False,
            rocm_available=True,
            directml_available=False,
            hw_encoder=hw_encoder,
            nvenc_available=False,
            display_name=display,
        )

    # --- 4. Try AMD on Windows (AMF encoding + optional DirectML) ---
    amd_win, amd_name = _detect_amd_windows()
    if amd_win:
        directml = _detect_directml()
        hw_encoder = "h264_amf" if _check_ffmpeg_encoder("h264_amf") else None
        suffix = "DirectML" if directml else "AMF"
        display = f"GPU: {amd_name} ({suffix})" if amd_name else f"GPU: AMD ({suffix})"
        logger.info("GPU detected: AMD Windows — %s (encoder=%s, directml=%s)",
                     amd_name, hw_encoder, directml)
        return GpuInfo(
            gpu_vendor="amd",
            gpu_name=amd_name,
            cuda_available=False,
            cuda_version=None,
            mps_available=False,
            rocm_available=False,
            directml_available=directml,
            hw_encoder=hw_encoder,
            nvenc_available=False,
            display_name=display,
        )

    # --- 5. CPU fallback ---
    logger.info("No GPU detected — using CPU only")
    return GpuInfo(
        gpu_vendor="none",
        gpu_name=None,
        cuda_available=False,
        cuda_version=None,
        mps_available=False,
        rocm_available=False,
        directml_available=False,
        hw_encoder=None,
        nvenc_available=False,
        display_name="CPU only (no GPU detected)",
    )

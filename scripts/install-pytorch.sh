#!/usr/bin/env bash
# install-pytorch.sh — Detect platform + GPU and install the correct PyTorch variant.
#
# Usage:
#   ./scripts/install-pytorch.sh          # auto-detect
#   ./scripts/install-pytorch.sh cpu      # force CPU-only
#   ./scripts/install-pytorch.sh cuda     # force CUDA
#   ./scripts/install-pytorch.sh rocm     # force ROCm
#   ./scripts/install-pytorch.sh mps      # force macOS Metal (default torch)

set -euo pipefail

FORCE="${1:-auto}"

detect_gpu() {
    # NVIDIA — check nvidia-smi
    if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
        echo "cuda"
        return
    fi

    # macOS — Metal/MPS is available on Apple Silicon and recent Intel Macs
    if [[ "$(uname -s)" == "Darwin" ]]; then
        echo "mps"
        return
    fi

    # AMD ROCm — check rocm-smi or /opt/rocm
    if command -v rocm-smi &>/dev/null || [[ -d /opt/rocm ]]; then
        echo "rocm"
        return
    fi

    echo "cpu"
}

if [[ "$FORCE" == "auto" ]]; then
    GPU=$(detect_gpu)
else
    GPU="$FORCE"
fi

echo "==> Detected GPU backend: $GPU"

case "$GPU" in
    cuda)
        echo "==> Installing PyTorch with CUDA support..."
        uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
        ;;
    rocm)
        echo "==> Installing PyTorch with ROCm support..."
        uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm6.2
        ;;
    mps)
        echo "==> Installing PyTorch (MPS support built-in on macOS)..."
        uv pip install torch torchvision torchaudio
        ;;
    cpu)
        echo "==> Installing PyTorch (CPU-only)..."
        uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
        ;;
    *)
        echo "ERROR: Unknown GPU backend '$GPU'. Use: auto, cuda, rocm, mps, cpu"
        exit 1
        ;;
esac

echo "==> PyTorch installed. Verifying..."
python -c "
import torch
print(f'  PyTorch {torch.__version__}')
print(f'  CUDA available: {torch.cuda.is_available()}')
if hasattr(torch.backends, 'mps'):
    print(f'  MPS available:  {torch.backends.mps.is_available()}')
if hasattr(torch.version, 'hip') and torch.version.hip:
    print(f'  ROCm/HIP:       {torch.version.hip}')
"
echo "==> Done."

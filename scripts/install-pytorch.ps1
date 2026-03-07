# install-pytorch.ps1 — Detect platform + GPU and install the correct PyTorch variant.
#
# Usage:
#   .\scripts\install-pytorch.ps1          # auto-detect
#   .\scripts\install-pytorch.ps1 cpu      # force CPU-only
#   .\scripts\install-pytorch.ps1 cuda     # force CUDA
#   .\scripts\install-pytorch.ps1 directml # force DirectML (AMD on Windows)

param(
    [string]$Backend = "auto"
)

$ErrorActionPreference = "Stop"

function Detect-GPU {
    # NVIDIA — check nvidia-smi
    try {
        $null = & nvidia-smi 2>$null
        if ($LASTEXITCODE -eq 0) { return "cuda" }
    } catch {}

    # AMD on Windows — check for AMD GPU via WMIC/CIM
    try {
        $gpus = Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue
        foreach ($gpu in $gpus) {
            if ($gpu.Name -match "AMD|Radeon") { return "directml" }
        }
    } catch {}

    return "cpu"
}

if ($Backend -eq "auto") {
    $GPU = Detect-GPU
} else {
    $GPU = $Backend
}

Write-Host "==> Detected GPU backend: $GPU"

switch ($GPU) {
    "cuda" {
        Write-Host "==> Installing PyTorch with CUDA support..."
        uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
    }
    "directml" {
        Write-Host "==> Installing PyTorch + DirectML for AMD GPU..."
        uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
        uv pip install torch-directml
    }
    "cpu" {
        Write-Host "==> Installing PyTorch (CPU-only)..."
        uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
    }
    default {
        Write-Host "ERROR: Unknown GPU backend '$GPU'. Use: auto, cuda, directml, cpu"
        exit 1
    }
}

Write-Host "==> PyTorch installed. Verifying..."
python -c @"
import torch
print(f'  PyTorch {torch.__version__}')
print(f'  CUDA available: {torch.cuda.is_available()}')
try:
    import torch_directml
    print(f'  DirectML available: True')
except ImportError:
    pass
"@

Write-Host "==> Done."

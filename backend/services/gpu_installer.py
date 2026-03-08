"""GPU provider installer — installs the correct PyTorch variant at first run.

Used by the setup wizard to install CUDA, ROCm, or DirectML PyTorch wheels
into the bundled Python environment. Streams progress to a WebSocket.
"""

import asyncio
import logging
import sys

from fastapi import WebSocket

logger = logging.getLogger(__name__)

# pip install commands for each GPU provider
_INSTALL_COMMANDS: dict[str, list[str]] = {
    "cuda": [
        sys.executable, "-m", "pip", "install", "--upgrade",
        "torch", "torchvision", "torchaudio",
        "--index-url", "https://download.pytorch.org/whl/cu124",
    ],
    "rocm": [
        sys.executable, "-m", "pip", "install", "--upgrade",
        "torch", "torchvision", "torchaudio",
        "--index-url", "https://download.pytorch.org/whl/rocm6.2",
    ],
    "directml": [
        sys.executable, "-m", "pip", "install", "--upgrade",
        "torch-directml",
    ],
}


async def install_gpu_provider(provider: str, websocket: WebSocket) -> None:
    """Install GPU PyTorch wheels and stream progress to the WebSocket.

    Args:
        provider: One of "cuda", "rocm", "directml", "mps", "cpu".
        websocket: WebSocket to send progress events to.
    """
    if provider in ("cpu", "mps"):
        await websocket.send_json({
            "stage": "skip",
            "message": f"No additional install needed for {provider}.",
        })
        return

    if provider not in _INSTALL_COMMANDS:
        await websocket.send_json({
            "stage": "error",
            "message": f"Unknown provider: {provider}",
        })
        return

    cmd = _INSTALL_COMMANDS[provider]
    await websocket.send_json({
        "stage": "installing",
        "message": f"Installing PyTorch for {provider}...",
        "command": " ".join(cmd),
    })

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    assert proc.stdout is not None
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace").rstrip()
        if text:
            await websocket.send_json({"stage": "progress", "line": text})

    return_code = await proc.wait()
    if return_code != 0:
        raise RuntimeError(f"pip install failed with exit code {return_code}")

    await websocket.send_json({
        "stage": "installed",
        "message": f"PyTorch {provider} installed successfully.",
    })

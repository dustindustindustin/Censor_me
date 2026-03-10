#!/usr/bin/env python3
"""
Build a portable, self-contained CensorMe distribution.

Downloads a standalone Python, installs all dependencies, pre-downloads ML
models, bundles a static ffmpeg binary, builds the frontend, compiles the
Tauri binary, and packages everything into a single archive.

Usage:
    python scripts/build-portable.py [--skip-tauri] [--skip-models]

Output:
    dist/CensorMe-{platform}-{arch}.{zip|tar.gz}
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
BUILD_DIR = DIST / "CensorMe"

# Suffix of the install_only asset for each platform in python-build-standalone
_PBS_SUFFIXES = {
    ("Windows", "AMD64"): "x86_64-pc-windows-msvc-install_only.tar.gz",
    ("Darwin", "arm64"):  "aarch64-apple-darwin-install_only.tar.gz",
    ("Linux",  "x86_64"): "x86_64-unknown-linux-gnu-install_only.tar.gz",
}


def get_python_standalone_url(system: str, machine: str) -> str:
    """Return a download URL for the latest CPython 3.12 install_only build."""
    key = (system, machine)
    if key not in _PBS_SUFFIXES:
        print(f"  ERROR: No standalone Python build for {system}/{machine}")
        sys.exit(1)
    suffix = _PBS_SUFFIXES[key]

    # Try to resolve the latest release from the astral-sh maintained fork
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest",
            headers={"Accept": "application/vnd.github+json", "User-Agent": "censor-me-build"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        for asset in data.get("assets", []):
            name = asset["name"]
            if "cpython-3.12" in name and suffix in name:
                url = asset["browser_download_url"]
                print(f"  Resolved latest python-build-standalone: {name}")
                return url
    except Exception as exc:
        print(f"  WARNING: GitHub API lookup failed ({exc}), trying fallback URL")

    # Hard-coded fallback — update tag/version if this goes stale
    tag, ver = "20250317", "3.12.9"
    return (
        f"https://github.com/astral-sh/python-build-standalone/releases/download"
        f"/{tag}/cpython-{ver}+{tag}-{suffix}"
    )

# Static ffmpeg binaries
FFMPEG_URLS = {
    ("Windows", "AMD64"): "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    ("Darwin", "arm64"): "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip",
    ("Linux", "x86_64"): "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
}


def detect_platform() -> tuple[str, str]:
    system = platform.system()
    machine = platform.machine()
    return system, machine


def download(url: str, dest: Path, label: str = "") -> None:
    if dest.exists():
        print(f"  [cached] {dest.name}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  Downloading {label or url}...")
    urllib.request.urlretrieve(url, dest)
    print(f"  Saved to {dest}")


def extract_archive(archive: Path, dest: Path) -> None:
    print(f"  Extracting {archive.name}...")
    if archive.name.endswith(".tar.gz") or archive.name.endswith(".tgz"):
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(dest)
    elif archive.name.endswith(".tar.xz"):
        with tarfile.open(archive, "r:xz") as tar:
            tar.extractall(dest)
    elif archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive, "r") as zf:
            zf.extractall(dest)


def step_download_python(system: str, machine: str) -> Path:
    """Download and extract standalone Python."""
    print("\n=== Step 1: Standalone Python ===")
    cache_dir = DIST / "cache"
    archive = cache_dir / f"python-{system}-{machine}.tar.gz"
    url = get_python_standalone_url(system, machine)
    download(url, archive, "python-build-standalone")

    python_dir = BUILD_DIR / "python"
    if python_dir.exists():
        shutil.rmtree(python_dir)

    extract_archive(archive, BUILD_DIR)
    # python-build-standalone extracts to a "python/" directory
    if not python_dir.exists():
        # Some archives use "python" as root, others use "cpython-..."
        for d in BUILD_DIR.iterdir():
            if d.is_dir() and d.name.startswith("cpython"):
                d.rename(python_dir)
                break

    return python_dir


def step_install_deps(python_dir: Path, system: str) -> None:
    """Install all Python dependencies into the standalone Python."""
    print("\n=== Step 2: Install Python dependencies ===")
    if system == "Windows":
        pip = python_dir / "python.exe"
    else:
        pip = python_dir / "bin" / "python3"

    # Install base dependencies (CPU PyTorch — GPU variant installed at first run)
    subprocess.run(
        [str(pip), "-m", "pip", "install", "--upgrade", "pip"],
        check=True,
    )
    subprocess.run(
        [str(pip), "-m", "pip", "install",
         "torch", "torchvision", "torchaudio",
         "--index-url", "https://download.pytorch.org/whl/cpu"],
        check=True,
    )
    # Install all project dependencies (torch already installed above, pip will skip it)
    subprocess.run(
        [str(pip), "-m", "pip", "install", str(ROOT)],
        check=True,
    )


def step_download_models(python_dir: Path, system: str, skip: bool = False) -> None:
    """Pre-download EasyOCR and spaCy models."""
    print("\n=== Step 3: Pre-download ML models ===")
    if skip:
        print("  Skipping (--skip-models)")
        return

    models_dir = BUILD_DIR / "models"
    models_dir.mkdir(parents=True, exist_ok=True)

    if system == "Windows":
        python = python_dir / "python.exe"
    else:
        python = python_dir / "bin" / "python3"

    # EasyOCR models
    easyocr_dir = models_dir / "easyocr"
    easyocr_dir.mkdir(exist_ok=True)
    subprocess.run(
        [str(python), "-c",
         f"import easyocr; easyocr.Reader(['en'], gpu=False, model_storage_directory=r'{easyocr_dir.as_posix()}')"],
        check=True,
    )

    # spaCy model — install into site-packages so spacy.load() can find it
    subprocess.run(
        [str(python), "-m", "spacy", "download", "en_core_web_lg"],
        check=True,
    )


def step_download_ffmpeg(system: str, machine: str) -> None:
    """Download a static ffmpeg binary."""
    print("\n=== Step 4: Download static ffmpeg ===")
    key = (system, machine)
    if key not in FFMPEG_URLS:
        print(f"  WARNING: No ffmpeg URL for {system}/{machine}, skipping")
        return

    cache_dir = DIST / "cache"
    ext = ".zip" if system == "Windows" else ".tar.xz" if system == "Linux" else ".zip"
    archive = cache_dir / f"ffmpeg-{system}-{machine}{ext}"
    download(FFMPEG_URLS[key], archive, "static ffmpeg")

    bin_dir = BUILD_DIR / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)

    temp = DIST / "ffmpeg_temp"
    if temp.exists():
        shutil.rmtree(temp)
    extract_archive(archive, temp)

    # Find the ffmpeg binary in the extracted archive
    ffmpeg_name = "ffmpeg.exe" if system == "Windows" else "ffmpeg"
    for root, dirs, files in os.walk(temp):
        if ffmpeg_name in files:
            src = Path(root) / ffmpeg_name
            shutil.copy2(src, bin_dir / ffmpeg_name)
            # Also copy ffprobe if available
            probe_name = "ffprobe.exe" if system == "Windows" else "ffprobe"
            if (Path(root) / probe_name).exists():
                shutil.copy2(Path(root) / probe_name, bin_dir / probe_name)
            break

    shutil.rmtree(temp)


def step_build_frontend() -> None:
    """Build the React frontend."""
    print("\n=== Step 5: Build frontend ===")
    # On Windows, pnpm is a .cmd script and requires shell=True to be found
    is_windows = platform.system() == "Windows"
    subprocess.run(
        ["pnpm", "--prefix", str(ROOT / "frontend"), "install"],
        check=True,
        shell=is_windows,
    )
    subprocess.run(
        ["pnpm", "--prefix", str(ROOT / "frontend"), "build"],
        check=True,
        shell=is_windows,
    )


def step_copy_backend() -> None:
    """Copy the backend source into the build directory."""
    print("\n=== Step 6: Copy backend source ===")
    dest = BUILD_DIR / "backend"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(
        ROOT / "backend", dest,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache"),
    )


def step_generate_icons() -> None:
    """Generate all Tauri icon sizes from the source PNG."""
    print("\n=== Step 6.5: Generate app icons ===")
    icon_src = ROOT / "resources" / "Censor Me Icon Cropped.png"
    if not icon_src.exists():
        print(f"  WARNING: Icon source not found at {icon_src}, skipping")
        return
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "generate-icons.py")],
        check=True,
    )


def step_build_tauri(skip: bool = False) -> None:
    """Build the Tauri desktop binary."""
    print("\n=== Step 7: Build Tauri binary ===")
    if skip:
        print("  Skipping (--skip-tauri)")
        return
    subprocess.run(
        ["cargo", "tauri", "build", "--no-bundle"],
        cwd=str(ROOT),
        check=True,
    )
    # Copy the binary to the build directory
    system = platform.system()
    if system == "Windows":
        binary = ROOT / "src-tauri" / "target" / "release" / "censor-me.exe"
        dest_name = "CensorMe.exe"
    elif system == "Darwin":
        binary = ROOT / "src-tauri" / "target" / "release" / "censor-me"
        dest_name = "CensorMe"
    else:
        binary = ROOT / "src-tauri" / "target" / "release" / "censor-me"
        dest_name = "censor-me"

    if binary.exists():
        shutil.copy2(binary, BUILD_DIR / dest_name)


def step_create_data_dir() -> None:
    """Create the data directory structure."""
    print("\n=== Step 8: Create data directory ===")
    (BUILD_DIR / "data" / "projects").mkdir(parents=True, exist_ok=True)


def step_package(system: str, machine: str) -> Path:
    """Create the final distributable archive."""
    print("\n=== Step 9: Package ===")
    arch = "x64" if machine in ("AMD64", "x86_64") else machine
    if system == "Windows":
        archive_name = f"CensorMe-Windows-{arch}"
        archive_path = DIST / f"{archive_name}.zip"
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for file_path in BUILD_DIR.rglob("*"):
                if file_path.is_file():
                    arcname = f"CensorMe/{file_path.relative_to(BUILD_DIR)}"
                    zf.write(file_path, arcname)
    else:
        archive_name = f"CensorMe-{system}-{arch}"
        archive_path = DIST / f"{archive_name}.tar.gz"
        with tarfile.open(archive_path, "w:gz") as tar:
            tar.add(BUILD_DIR, arcname="CensorMe")

    size_mb = archive_path.stat().st_size / 1024 / 1024
    print(f"\n  Archive: {archive_path} ({size_mb:.0f} MB)")
    return archive_path


def main():
    parser = argparse.ArgumentParser(description="Build portable CensorMe distribution")
    parser.add_argument("--skip-tauri", action="store_true", help="Skip Tauri binary build")
    parser.add_argument("--skip-models", action="store_true", help="Skip ML model downloads")
    args = parser.parse_args()

    system, machine = detect_platform()
    print(f"Building CensorMe for {system} {machine}")

    # Clean previous build
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    python_dir = step_download_python(system, machine)
    step_install_deps(python_dir, system)
    step_download_models(python_dir, system, skip=args.skip_models)
    step_download_ffmpeg(system, machine)
    step_build_frontend()
    step_copy_backend()
    step_generate_icons()
    step_build_tauri(skip=args.skip_tauri)
    step_create_data_dir()
    archive = step_package(system, machine)

    print(f"\n{'='*60}")
    print(f"Build complete: {archive}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()

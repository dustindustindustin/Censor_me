#!/usr/bin/env python3
"""
Generate all required Tauri v2 app icons from the source PNG.

Source: resources/Censor Me Icon Cropped.png
Output: src-tauri/icons/

Run from the project root:
    python scripts/generate-icons.py
"""

import struct
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow not installed. Run: pip install Pillow")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "resources" / "Censor Me Icon Cropped.png"
ICONS_DIR = ROOT / "src-tauri" / "icons"


def generate_icons(src_path: Path, icons_dir: Path) -> None:
    icons_dir.mkdir(parents=True, exist_ok=True)

    img = Image.open(src_path).convert("RGBA")
    print(f"  Source: {src_path.name}  ({img.width}x{img.height})")

    # --- PNG sizes ----------------------------------------------------------------
    # 32x32.png        — Linux tray / small display
    # 128x128.png      — Linux app icon
    # 128x128@2x.png   — macOS HiDPI (rendered at 256x256)
    # icon.png         — Primary icon used by Tauri for tray/dock (512x512)
    png_specs = [
        (32,  "32x32.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
        (512, "icon.png"),
    ]
    for size, name in png_specs:
        out = img.resize((size, size), Image.LANCZOS)
        out.save(icons_dir / name, format="PNG", optimize=True)
        print(f"  {name}")

    # --- Windows ICO --------------------------------------------------------------
    # Multi-resolution ICO: 16, 32, 48, 64, 128, 256
    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    frames = [img.resize(s, Image.LANCZOS).convert("RGBA") for s in ico_sizes]
    frames[0].save(
        icons_dir / "icon.ico",
        format="ICO",
        sizes=ico_sizes,
        append_images=frames[1:],
    )
    print("  icon.ico")

    # --- macOS ICNS ---------------------------------------------------------------
    # Build a minimal ICNS using the iconset data we already have.
    # Tauri only needs this on macOS builds; on Windows it's unused.
    _write_icns(img, icons_dir / "icon.icns")
    print("  icon.icns")

    print(f"\n  All icons written to: {icons_dir}")


def _write_icns(img: "Image.Image", dest: Path) -> None:
    """Write a minimal Apple ICNS file with the most common icon types."""
    # ICNS icon type codes and their pixel dimensions
    # (type_code, size, is_hidpi)
    icns_specs = [
        (b"icp4",  16,   False),  # ic04 — 16x16
        (b"icp5",  32,   False),  # ic05 — 32x32
        (b"icp6",  64,   False),  # ic06 — 64x64
        (b"ic07",  128,  False),  # 128x128
        (b"ic08",  256,  False),  # 256x256
        (b"ic09",  512,  False),  # 512x512
        (b"ic10",  1024, False),  # 1024x1024 (512@2x)
        (b"ic11",  32,   True),   # 16x16@2x
        (b"ic12",  64,   True),   # 32x32@2x
        (b"ic13",  256,  True),   # 128x128@2x
        (b"ic14",  512,  True),   # 256x256@2x
    ]

    import io
    chunks = []
    for type_code, size, _ in icns_specs:
        resized = img.resize((size, size), Image.LANCZOS).convert("RGBA")
        buf = io.BytesIO()
        resized.save(buf, format="PNG")
        png_data = buf.getvalue()
        # Each chunk: 4-byte type + 4-byte length (includes the 8-byte header)
        chunk_len = 8 + len(png_data)
        chunks.append(type_code + struct.pack(">I", chunk_len) + png_data)

    total_len = 8 + sum(len(c) for c in chunks)
    with open(dest, "wb") as f:
        f.write(b"icns")
        f.write(struct.pack(">I", total_len))
        for chunk in chunks:
            f.write(chunk)


if __name__ == "__main__":
    print("\n=== Generating app icons ===")
    if not SRC.exists():
        print(f"ERROR: Source image not found: {SRC}")
        sys.exit(1)
    generate_icons(SRC, ICONS_DIR)

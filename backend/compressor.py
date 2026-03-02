"""PDF compression using Ghostscript."""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

# Ghostscript quality presets
# ebook: ~150 DPI, good for email
# printer: ~300 DPI, good balance
# prepress: ~300 DPI, high quality
QUALITY_PRESETS = {
    "email": {
        "gs_setting": "/ebook",
        "description": "Email-friendly (< 10MB target)",
    },
    "standard": {
        "gs_setting": "/ebook",
        "description": "Standard quality (< 25MB target)",
    },
    "high": {
        "gs_setting": "/printer",
        "description": "High quality (larger file)",
    },
}


def compress_pdf(
    input_path: Path,
    output_path: Path,
    quality: str = "standard",
    target_size_mb: float | None = None,
) -> dict:
    """
    Compress a PDF using Ghostscript.

    Returns dict with:
        - original_size: int (bytes)
        - compressed_size: int (bytes)
        - reduction_pct: float
        - output_path: str
    """
    original_size = input_path.stat().st_size
    preset = QUALITY_PRESETS.get(quality, QUALITY_PRESETS["standard"])

    try:
        cmd = [
            settings.GHOSTSCRIPT_PATH,
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.4",
            f"-dPDFSETTINGS={preset['gs_setting']}",
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            "-dColorImageDownsampleType=/Bicubic",
            "-dGrayImageDownsampleType=/Bicubic",
            "-dMonoImageDownsampleType=/Subsample",
            f"-sOutputFile={output_path}",
            str(input_path),
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
        )

        if result.returncode != 0:
            logger.error(f"Ghostscript compression failed: {result.stderr}")
            # Fall back: just copy the file
            import shutil
            shutil.copy2(input_path, output_path)

        compressed_size = output_path.stat().st_size

        # If compressed is larger than original, use original
        if compressed_size >= original_size:
            import shutil
            shutil.copy2(input_path, output_path)
            compressed_size = original_size

        # If we have a target size and we're still too big, try more aggressive compression
        if target_size_mb and compressed_size > target_size_mb * 1024 * 1024:
            compressed_size = _aggressive_compress(input_path, output_path, target_size_mb)

        reduction_pct = (1 - compressed_size / original_size) * 100 if original_size > 0 else 0

        return {
            "original_size": original_size,
            "compressed_size": compressed_size,
            "reduction_pct": round(reduction_pct, 1),
            "output_path": str(output_path),
        }

    except subprocess.TimeoutExpired:
        logger.error("Ghostscript compression timed out")
        import shutil
        shutil.copy2(input_path, output_path)
        return {
            "original_size": original_size,
            "compressed_size": original_size,
            "reduction_pct": 0,
            "output_path": str(output_path),
        }


def _aggressive_compress(input_path: Path, output_path: Path, target_size_mb: float) -> int:
    """Try progressively lower DPI to hit target size."""
    for dpi in [120, 96, 72]:
        try:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                tmp_path = tmp.name

            cmd = [
                settings.GHOSTSCRIPT_PATH,
                "-sDEVICE=pdfwrite",
                "-dCompatibilityLevel=1.4",
                "-dPDFSETTINGS=/screen",
                "-dNOPAUSE",
                "-dQUIET",
                "-dBATCH",
                f"-dColorImageResolution={dpi}",
                f"-dGrayImageResolution={dpi}",
                f"-dMonoImageResolution={dpi}",
                "-dColorImageDownsampleType=/Bicubic",
                "-dGrayImageDownsampleType=/Bicubic",
                f"-sOutputFile={tmp_path}",
                str(input_path),
            ]

            subprocess.run(cmd, capture_output=True, text=True, timeout=300)

            tmp_size = Path(tmp_path).stat().st_size
            if tmp_size <= target_size_mb * 1024 * 1024:
                import shutil
                shutil.move(tmp_path, output_path)
                return tmp_size

            Path(tmp_path).unlink(missing_ok=True)

        except Exception as e:
            logger.warning(f"Aggressive compression at {dpi} DPI failed: {e}")
            Path(tmp_path).unlink(missing_ok=True)

    return output_path.stat().st_size


def get_file_size_display(size_bytes: int) -> str:
    """Format file size for display."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"

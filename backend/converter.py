"""Convert various document formats to PDF."""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from config import settings

logger = logging.getLogger(__name__)


CONVERTIBLE_EXTENSIONS = {
    ".docx", ".doc", ".vsd", ".vsdx",  # LibreOffice
    ".heic", ".heif",                   # pillow-heif
    ".jpg", ".jpeg", ".png", ".tiff", ".tif",  # Pillow
    ".txt",                              # text to PDF
}


def convert_to_pdf(input_path: Path, output_dir: Path) -> Optional[Path]:
    """Convert a file to PDF. Returns the output PDF path, or None if already PDF or unsupported."""
    ext = input_path.suffix.lower()

    if ext == ".pdf":
        return None  # Already a PDF

    if ext in {".docx", ".doc", ".vsd", ".vsdx"}:
        return _convert_with_libreoffice(input_path, output_dir)
    elif ext in {".heic", ".heif"}:
        return _convert_heic_to_pdf(input_path, output_dir)
    elif ext in {".jpg", ".jpeg", ".png", ".tiff", ".tif"}:
        return _convert_image_to_pdf(input_path, output_dir)
    elif ext == ".txt":
        return _convert_text_to_pdf(input_path, output_dir)
    else:
        logger.warning(f"Unsupported file type: {ext} for {input_path.name}")
        return None


def _accept_tracked_changes(docx_path: Path) -> Optional[Path]:
    """Accept all tracked changes in a DOCX file so LibreOffice renders clean output.
    Returns path to a cleaned temp copy, or None if not a DOCX or on failure."""
    if docx_path.suffix.lower() not in (".docx",):
        return None
    try:
        from lxml import etree
        import zipfile as zf
        import copy

        # Word XML namespaces
        W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

        with zf.ZipFile(str(docx_path), "r") as z:
            if "word/document.xml" not in z.namelist():
                return None
            doc_xml = z.read("word/document.xml")

        tree = etree.fromstring(doc_xml)

        changed = False

        # Accept insertions: unwrap w:ins elements (keep their children)
        for ins in tree.iter(f"{{{W}}}ins"):
            parent = ins.getparent()
            if parent is None:
                continue
            idx = list(parent).index(ins)
            for child in list(ins):
                ins.remove(child)
                parent.insert(idx, child)
                idx += 1
            parent.remove(ins)
            changed = True

        # Accept deletions: remove w:del elements entirely
        for deletion in tree.iter(f"{{{W}}}del"):
            parent = deletion.getparent()
            if parent is not None:
                parent.remove(deletion)
                changed = True

        # Remove revision properties (rPrChange, pPrChange, sectPrChange, tblPrChange)
        for tag in ("rPrChange", "pPrChange", "sectPrChange", "tblPrChange", "trPrChange", "tcPrChange"):
            for el in tree.iter(f"{{{W}}}{tag}"):
                parent = el.getparent()
                if parent is not None:
                    parent.remove(el)
                    changed = True

        # Remove move-from (treat as deletion)
        for mf in tree.iter(f"{{{W}}}moveFrom"):
            parent = mf.getparent()
            if parent is not None:
                parent.remove(mf)
                changed = True

        # Accept move-to (treat as insertion — unwrap)
        for mt in tree.iter(f"{{{W}}}moveTo"):
            parent = mt.getparent()
            if parent is None:
                continue
            idx = list(parent).index(mt)
            for child in list(mt):
                mt.remove(child)
                parent.insert(idx, child)
                idx += 1
            parent.remove(mt)
            changed = True

        if not changed:
            return None

        # Write modified DOCX to temp file
        tmp = tempfile.NamedTemporaryFile(suffix=".docx", delete=False)
        tmp_path = Path(tmp.name)
        tmp.close()

        with zf.ZipFile(str(docx_path), "r") as zin, zf.ZipFile(str(tmp_path), "w") as zout:
            for item in zin.infolist():
                if item.filename == "word/document.xml":
                    zout.writestr(item, etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True))
                else:
                    zout.writestr(item, zin.read(item.filename))

        return tmp_path

    except Exception as e:
        logger.warning(f"Failed to accept tracked changes for {docx_path.name}: {e}")
        return None


def _convert_with_libreoffice(input_path: Path, output_dir: Path) -> Optional[Path]:
    """Convert Word docs and Visio files to PDF using LibreOffice headless."""
    cleaned_path = None
    try:
        # Bug 7: Accept tracked changes in DOCX before conversion
        cleaned_path = _accept_tracked_changes(input_path)
        convert_path = cleaned_path if cleaned_path else input_path

        # LibreOffice needs a writable user profile dir to avoid conflicts
        with tempfile.TemporaryDirectory() as profile_dir:
            cmd = [
                settings.LIBREOFFICE_PATH,
                "--headless",
                "--norestore",
                f"-env:UserInstallation=file://{profile_dir}",
                "--convert-to", "pdf",
                "--outdir", str(output_dir),
                str(convert_path),
            ]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
            )

            if result.returncode != 0:
                logger.error(f"LibreOffice conversion failed for {input_path.name}: {result.stderr}")
                if cleaned_path:
                    cleaned_path.unlink(missing_ok=True)
                return None

            # LibreOffice names output after the input file stem
            lo_output = output_dir / f"{convert_path.stem}.pdf"
            expected_output = output_dir / f"{input_path.stem}.pdf"

            # If we used a temp file, rename output to match original filename
            if cleaned_path and lo_output.exists() and lo_output != expected_output:
                lo_output.rename(expected_output)
                cleaned_path.unlink(missing_ok=True)
            elif cleaned_path:
                cleaned_path.unlink(missing_ok=True)

            if expected_output.exists():
                return expected_output

            logger.error(f"LibreOffice output not found at {expected_output}")
            return None

    except subprocess.TimeoutExpired:
        logger.error(f"LibreOffice conversion timed out for {input_path.name}")
        if cleaned_path:
            cleaned_path.unlink(missing_ok=True)
        return None
    except Exception as e:
        logger.error(f"LibreOffice conversion error for {input_path.name}: {e}")
        if cleaned_path:
            cleaned_path.unlink(missing_ok=True)
        return None


def _convert_heic_to_pdf(input_path: Path, output_dir: Path) -> Optional[Path]:
    """Convert HEIC/HEIF images to PDF. Uses macOS sips first, pillow_heif fallback."""
    import platform

    output_path = output_dir / f"{input_path.stem}.pdf"

    # Try macOS sips first — handles iPhone HEIC metadata issues that crash pillow_heif
    if platform.system() == "Darwin":
        try:
            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
                tmp_jpg = tmp.name

            result = subprocess.run(
                ["sips", "-s", "format", "jpeg", str(input_path), "--out", tmp_jpg],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode == 0 and Path(tmp_jpg).exists():
                img = Image.open(tmp_jpg)
                img = img.convert("RGB")
                _image_to_pdf_page(img, output_path)
                Path(tmp_jpg).unlink(missing_ok=True)
                return output_path

            Path(tmp_jpg).unlink(missing_ok=True)
        except Exception as e:
            logger.warning(f"sips conversion failed for {input_path.name}, trying pillow_heif: {e}")
            Path(tmp_jpg).unlink(missing_ok=True) if 'tmp_jpg' in dir() else None

    # Fallback: pillow_heif (for non-macOS or if sips fails)
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()

        img = Image.open(input_path)
        img = img.convert("RGB")

        _image_to_pdf_page(img, output_path)
        return output_path

    except Exception as e:
        logger.error(f"HEIC conversion error for {input_path.name}: {e}")
        return None


def _convert_image_to_pdf(input_path: Path, output_dir: Path) -> Optional[Path]:
    """Convert standard image formats to PDF."""
    try:
        img = Image.open(input_path)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")

        output_path = output_dir / f"{input_path.stem}.pdf"
        _image_to_pdf_page(img, output_path)
        return output_path

    except Exception as e:
        logger.error(f"Image conversion error for {input_path.name}: {e}")
        return None


def _image_to_pdf_page(img: Image.Image, output_path: Path):
    """Place an image onto a PDF page, scaled to fit letter size with margins."""
    page_w, page_h = letter  # 612 x 792 points
    margin = 36  # 0.5 inch margins

    available_w = page_w - 2 * margin
    available_h = page_h - 2 * margin

    img_w, img_h = img.size
    scale = min(available_w / img_w, available_h / img_h)

    draw_w = img_w * scale
    draw_h = img_h * scale

    # Center on page
    x = margin + (available_w - draw_w) / 2
    y = margin + (available_h - draw_h) / 2

    c = canvas.Canvas(str(output_path), pagesize=letter)

    # Save image as temp JPEG for embedding
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        img.save(tmp, "JPEG", quality=90)
        tmp_path = tmp.name

    c.drawImage(tmp_path, x, y, draw_w, draw_h, preserveAspectRatio=True)
    c.save()

    # Clean up temp
    Path(tmp_path).unlink(missing_ok=True)


def _convert_text_to_pdf(input_path: Path, output_dir: Path) -> Optional[Path]:
    """Convert a text file to PDF."""
    try:
        text = input_path.read_text(encoding="utf-8", errors="replace")
        output_path = output_dir / f"{input_path.stem}.pdf"

        c = canvas.Canvas(str(output_path), pagesize=letter)
        page_w, page_h = letter
        margin = 72  # 1 inch
        y = page_h - margin
        line_height = 14

        c.setFont("Courier", 10)

        for line in text.split("\n"):
            if y < margin:
                c.showPage()
                c.setFont("Courier", 10)
                y = page_h - margin

            # Truncate very long lines
            if len(line) > 100:
                line = line[:100] + "..."

            c.drawString(margin, y, line)
            y -= line_height

        c.save()
        return output_path

    except Exception as e:
        logger.error(f"Text conversion error for {input_path.name}: {e}")
        return None


def get_pdf_page_count(pdf_path: Path) -> int:
    """Get the number of pages in a PDF using trailer data only (fast)."""
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(pdf_path), strict=False)
        return len(reader.pages)
    except Exception:
        return 0


async def async_convert_to_pdf(input_path: Path, output_dir: Path) -> Optional[Path]:
    """Async wrapper around convert_to_pdf — runs in a thread pool."""
    import asyncio
    return await asyncio.to_thread(convert_to_pdf, input_path, output_dir)


async def async_get_pdf_page_count(pdf_path: Path) -> int:
    """Async wrapper around get_pdf_page_count — runs in a thread pool."""
    import asyncio
    return await asyncio.to_thread(get_pdf_page_count, pdf_path)

"""AI-powered document classification using local LLM (Ollama) or Claude API."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from pathlib import Path
from typing import Optional

import subprocess
import tempfile

import httpx
import pytesseract
from PIL import Image
from pypdf import PdfReader

from config import settings
from north_star import NORTH_STAR_MANIFEST

pytesseract.pytesseract.tesseract_cmd = settings.TESSERACT_PATH
from models import ClassificationResult, SectionCategory

logger = logging.getLogger(__name__)

CONTENT_CLASSIFICATION_PROMPT = """You are classifying documents for a Phase I Environmental Site Assessment (ESA) report compiled by ODIC Environmental.

""" + NORTH_STAR_MANIFEST + """

Based on the reference above, classify this document into exactly ONE section.

SECTIONS:
1. RELIANCE_LETTER - Formal reliance letter (1-2 pages). Legal language granting third party reliance.
2. EO_INSURANCE - E&O insurance certificate (1-3 pages). ACORD form, policy numbers, coverage amounts.
3. COVER_WRITEUP - Main ESA report body by ODIC Environmental (20-80 pages). Executive summary, findings, TOC with numbered sections. ONLY ODIC-authored documents.
4. APPENDIX_A - Site maps, location maps, plot plans (1-5 pages). Property boundary drawings, NOT photographs.
5. APPENDIX_B - ONLY the pre-formatted Photo Appendix document (compiled photo grid with captions). NOT raw iPhone photos.
6. APPENDIX_C - EDR Radius environmental database report (200-1500 pages). Facility listings, database tables.
7. APPENDIX_D - Historical records only. Subcategories: sanborn (fire insurance maps), aerials (overhead photos with dates), topos (USGS contour maps), city_directory (old address listings).
8. APPENDIX_E - SHORT documents FROM government agencies: permits (BAAQMD, building, fire), regulatory letters (DTSC, RWQCB), UST forms, CERS certifications, property profiles, inspection reports, FOIA responses. Typically 1-20 pages each. Also includes ALL raw .HEIC/.JPG iPhone photos from site visits.
9. REPORTS_AFTER_E - LONG technical reports FROM consulting firms: monitoring reports, site investigations, remediation plans, groundwater data packages. Typically 50+ pages each.
10. APPENDIX_F - Environmental professional qualifications (2-10 pages). Resume, certifications, PE/PG licenses.

UNCLASSIFIED - Only if truly uncategorizable.

Respond ONLY with JSON:
{"category": "SECTION_NAME", "subcategory": "subcategory_or_null", "confidence": 0.0-1.0, "reasoning": "what you see in the content"}

For APPENDIX_D, set subcategory to: sanborn, aerials, topos, or city_directory.
For all others, subcategory is null."""


def _ocr_pdf_pages(pdf_path: Path, max_pages: int = 2, max_chars: int = 3000) -> str:
    """Render PDF pages to images via Ghostscript, then OCR with Tesseract."""
    text_parts = []
    with tempfile.TemporaryDirectory() as tmpdir:
        # Ghostscript: render first N pages to PNG
        out_pattern = str(Path(tmpdir) / "page_%d.png")
        cmd = [
            settings.GHOSTSCRIPT_PATH,
            "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dQUIET",
            "-sDEVICE=png16m", "-r200",
            f"-dFirstPage=1", f"-dLastPage={max_pages}",
            f"-sOutputFile={out_pattern}",
            str(pdf_path),
        ]
        subprocess.run(cmd, timeout=30, check=True, capture_output=True)

        # OCR each rendered page
        for i in range(1, max_pages + 1):
            img_path = Path(tmpdir) / f"page_{i}.png"
            if not img_path.exists():
                break
            img = Image.open(img_path)
            page_text = pytesseract.image_to_string(img)
            text_parts.append(page_text)
            if sum(len(t) for t in text_parts) > max_chars:
                break

    return "\n".join(text_parts)[:max_chars]


def _extract_text_from_pdf(pdf_path: Path, max_pages: int = 3, max_chars: int = 3000) -> str:
    """Extract text from the first few pages of a PDF, with OCR fallback for scans."""
    try:
        reader = PdfReader(str(pdf_path))
        text_parts = []
        for i, page in enumerate(reader.pages[:max_pages]):
            text = page.extract_text() or ""
            text_parts.append(text)
            if sum(len(t) for t in text_parts) > max_chars:
                break
        result = "\n".join(text_parts)[:max_chars]

        # OCR fallback: if digital extraction yielded little text, try Tesseract
        if len(result.strip()) < 50:
            try:
                ocr_text = _ocr_pdf_pages(pdf_path, max_pages=2, max_chars=max_chars)
                if len(ocr_text.strip()) > len(result.strip()):
                    result = ocr_text
            except Exception as e:
                logger.warning(f"OCR fallback failed for {pdf_path.name}: {e}")

        return result
    except Exception as e:
        logger.warning(f"Could not extract text from {pdf_path.name}: {e}")
        return ""


def _extract_text_from_docx(docx_path: Path, max_chars: int = 3000) -> str:
    """Extract text from a Word document."""
    try:
        from docx import Document
        doc = Document(str(docx_path))
        text_parts = []
        for para in doc.paragraphs:
            text_parts.append(para.text)
            if sum(len(t) for t in text_parts) > max_chars:
                break
        return "\n".join(text_parts)[:max_chars]
    except Exception as e:
        logger.warning(f"Could not extract text from {docx_path.name}: {e}")
        return ""


# ---- Legacy filename classifier (kept as sanity check) ----

def classify_by_filename_legacy(filename: str, relative_path: str = "") -> Optional[ClassificationResult]:
    """Fast classification using filename/path patterns. Now used as a sanity check after AI classification."""
    name_lower = filename.lower()
    path_lower = relative_path.lower()

    # Determine if file is an image
    IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".tiff", ".tif", ".gif", ".bmp"}
    ext_lower = Path(filename).suffix.lower()
    is_image = ext_lower in IMAGE_EXTENSIONS

    # IMAGE FILES: route early
    if is_image:
        image_override_patterns = [
            (r"aerial", SectionCategory.APPENDIX_D, "aerials", "Aerial photograph"),
            (r"sanborn", SectionCategory.APPENDIX_D, "sanborn", "Sanborn map scan"),
            (r"topo", SectionCategory.APPENDIX_D, "topos", "Topographic map scan"),
            (r"site.?location.?map|location.?map", SectionCategory.APPENDIX_A, None, "Site location map"),
            (r"site.?plot.?plan|plot.?plan", SectionCategory.APPENDIX_A, None, "Site plot plan"),
            (r"site.?map", SectionCategory.APPENDIX_A, None, "Site map"),
        ]
        for pattern, category, subcategory, reason in image_override_patterns:
            if re.search(pattern, name_lower):
                return ClassificationResult(
                    category=category,
                    subcategory=subcategory,
                    confidence=0.92,
                    reasoning=f"Image file + filename match: {reason}",
                )

        return ClassificationResult(
            category=SectionCategory.APPENDIX_E,
            confidence=0.90,
            reasoning="Image file — supporting evidence",
        )

    # NON-IMAGE FILES below this point

    # Appendix cover/divider pages — small files that start with "Appendix [A-F]"
    appendix_cover_match = re.match(r"appendix\s*([a-f])\b", name_lower)
    if appendix_cover_match:
        letter = appendix_cover_match.group(1).upper()
        section_map = {
            "A": SectionCategory.APPENDIX_A,
            "B": SectionCategory.APPENDIX_B,
            "C": SectionCategory.APPENDIX_C,
            "D": SectionCategory.APPENDIX_D,
            "E": SectionCategory.APPENDIX_E,
            "F": SectionCategory.APPENDIX_F,
        }
        file_path = Path(filename)
        file_size = 0
        try:
            file_size = file_path.stat().st_size if file_path.exists() else 0
        except Exception:
            pass
        # Small files (< 50KB) or any file matching "appendix X" that looks like a cover page
        is_small = file_size > 0 and file_size < 50 * 1024
        # Check for cover/divider indicators in filename
        is_cover = any(kw in name_lower for kw in ("cover", "divider", "tab", "separator"))
        if is_small or is_cover or (letter in section_map and "qualifications" not in name_lower and file_size == 0):
            return ClassificationResult(
                category=section_map.get(letter, SectionCategory.APPENDIX_E),
                confidence=0.95,
                reasoning="Appendix cover/divider page",
                sort_order=-1,
            )

    # Appendix divider pages
    if name_lower.startswith("appendix") and "qualifications" in name_lower:
        return ClassificationResult(
            category=SectionCategory.APPENDIX_F,
            confidence=0.95,
            reasoning="Filename indicates Appendix F - Qualifications",
        )

    for letter_code, section in [
        ("appendix a", SectionCategory.APPENDIX_A),
        ("appendix b", SectionCategory.APPENDIX_B),
        ("appendix c", SectionCategory.APPENDIX_C),
        ("appendix d", SectionCategory.APPENDIX_D),
        ("appendix e", SectionCategory.APPENDIX_E),
        ("appendix f", SectionCategory.APPENDIX_F),
    ]:
        if name_lower.startswith(letter_code):
            return ClassificationResult(
                category=section,
                confidence=0.90,
                reasoning=f"Filename starts with '{letter_code}'",
            )

    # Strong filename patterns (non-image files only)
    patterns = [
        (r"sanborn", SectionCategory.APPENDIX_D, "sanborn", "Sanborn map"),
        (r"esai[_-]?aerials?", SectionCategory.APPENDIX_D, "aerials", "ESAI aerial photograph"),
        (r"aerials?[_-]?\d*\.pdf", SectionCategory.APPENDIX_D, "aerials", "Aerial photograph"),
        (r"aerial", SectionCategory.APPENDIX_D, "aerials", "Aerial photograph"),
        (r"esai[_-]?sanborn", SectionCategory.APPENDIX_D, "sanborn", "ESAI Sanborn map"),
        (r"esai[_-]?topos?[_-]?\d*", SectionCategory.APPENDIX_D, "topos", "ESAI topographic map"),
        (r"topo", SectionCategory.APPENDIX_D, "topos", "Topographic map"),
        (r"esai[_-]?city[_-]?dir", SectionCategory.APPENDIX_D, "city_directory", "ESAI city directory"),
        (r"city.?dir", SectionCategory.APPENDIX_D, "city_directory", "City directory"),
        (r"esai[_-]?radius", SectionCategory.APPENDIX_C, None, "ESAI radius/database report"),
        (r"esai[_-]?report", SectionCategory.COVER_WRITEUP, None, "ESAI report document"),
        (r"radius", SectionCategory.APPENDIX_C, None, "Radius/database report"),
        (r"site.?location.?map", SectionCategory.APPENDIX_A, None, "Site location map"),
        (r"site.?plot.?plan|plot.?plan", SectionCategory.APPENDIX_A, None, "Site plot plan"),
        (r"photo.?appendix|site.?photo", SectionCategory.APPENDIX_B, None, "Site photographs"),
        (r"e[\&\.\s]o\b|^eo[\s_-]|insurance.*coverage|errors.*omissions", SectionCategory.EO_INSURANCE, None, "E&O insurance"),
        (r"\breliance\b", SectionCategory.RELIANCE_LETTER, None, "Reliance letter"),
        (r"^cover\.", SectionCategory.COVER_WRITEUP, None, "Cover page"),
        (r"qualification", SectionCategory.APPENDIX_F, None, "Professional qualifications"),
        (r"property.?detail|property.?profile", SectionCategory.APPENDIX_E, None, "Property profile"),  # sort_order=1 applied in post-processing
        (r"records?.?request", SectionCategory.APPENDIX_E, None, "Records request"),
        (r"bldg.?permit|building.?permit", SectionCategory.APPENDIX_E, None, "Building permits"),
        (r"dtsc.?response", SectionCategory.APPENDIX_E, None, "DTSC response"),
        (r"baaqmd", SectionCategory.APPENDIX_E, None, "BAAQMD records"),
        (r"case\s*#?\s*\d{4,}", SectionCategory.APPENDIX_E, None, "Regulatory case file"),
    ]

    for pattern, category, subcategory, reason in patterns:
        if re.search(pattern, name_lower):
            return ClassificationResult(
                category=category,
                subcategory=subcategory,
                confidence=0.90,
                reasoning=f"Filename pattern match: {reason}",
            )

    # Path-based patterns (folder names)
    folder_patterns = [
        (r"bla-\d+", SectionCategory.REPORTS_AFTER_E, "BLA folder - supporting records"),
        (r"ec_attachments", SectionCategory.REPORTS_AFTER_E, "EC Attachments - compliance records"),
        (r"smeh_", SectionCategory.REPORTS_AFTER_E, "SMEH folder - environmental records"),
        (r"geotracker", SectionCategory.REPORTS_AFTER_E, "GeoTracker records"),
        (r"site.?documents", SectionCategory.REPORTS_AFTER_E, "Site documents"),
    ]

    for pattern, category, reason in folder_patterns:
        if re.search(pattern, path_lower):
            return ClassificationResult(
                category=category,
                confidence=0.85,
                reasoning=f"Folder pattern match: {reason}",
            )

    # ESAI report body (only non-image, non-historical files)
    if "esai" in name_lower and name_lower.endswith((".docx", ".pdf")):
        if not re.search(r"aerial|sanborn|topo|city.?dir|radius", name_lower):
            return ClassificationResult(
                category=SectionCategory.COVER_WRITEUP,
                confidence=0.80,
                reasoning="ESAI report document (main body)",
            )

    # Generic camera photo filenames → APPENDIX_B
    generic_photo_patterns = [
        r'^\d{8}_\d+',
        r'^IMG_\d+',
        r'^DSCN?\d+',
        r'^P\d{7}',
        r'^PHOTO',
        r'^PXL_\d+',
    ]
    name_stem = Path(filename).stem
    if any(re.match(p, name_stem, re.IGNORECASE) for p in generic_photo_patterns):
        return ClassificationResult(
            category=SectionCategory.APPENDIX_B,
            confidence=0.90,
            reasoning="Generic camera photo filename",
        )

    return None


# Keep old name as alias for backward compatibility in imports
classify_by_filename = classify_by_filename_legacy


def apply_preference_rules(
    result: ClassificationResult,
    filename: str,
    all_filenames: list[str] | None = None,
) -> tuple[ClassificationResult, list[str]]:
    """Post-classification logic for version preferences and special sort orders.

    Returns (updated_result, filenames_to_exclude).
    filenames_to_exclude: base filenames that should be auto-excluded (superseded).
    """
    name_lower = filename.lower()
    stem = Path(filename).stem.lower()
    exclude_filenames: list[str] = []

    # Property profile → sort first in APPENDIX_E (after cover page)
    if result.category == SectionCategory.APPENDIX_E and re.search(r"property.?detail|property.?profile", name_lower):
        result.sort_order = 1

    # Revised/marked version preference
    is_revised = bool(re.search(r"\brev\b|\brevised\b", name_lower))
    is_marked = "marked" in name_lower

    if is_revised:
        result.confidence = min(1.0, (result.confidence or 0.8) + 0.05)
        result.reasoning = f"[PREFERRED: revised version] {result.reasoning}"

        # Find base filename without revision markers to exclude older versions
        if all_filenames:
            base = re.sub(r"[-_\s]*(rev|revised|v\d+|final|draft)[-_\s]*", "", stem, flags=re.IGNORECASE).strip()
            if base:
                for other in all_filenames:
                    other_stem = Path(other).stem.lower()
                    if other_stem == stem:
                        continue  # skip self
                    other_base = re.sub(r"[-_\s]*(rev|revised|v\d+|final|draft)[-_\s]*", "", other_stem, flags=re.IGNORECASE).strip()
                    if other_base == base and not re.search(r"\brev\b|\brevised\b", other_stem):
                        exclude_filenames.append(other)

    if is_marked and result.category == SectionCategory.APPENDIX_D:
        result.sort_order = 0  # Prefer marked version within section

    return result, exclude_filenames


# ---- Content-based AI classification (new primary path) ----

def needs_ai_classification(filename: str) -> Optional[ClassificationResult]:
    """Pre-filter: only trivially obvious cases skip AI entirely."""
    ext = Path(filename).suffix.lower()

    # HEIC/HEIF are always iPhone site photos → APPENDIX_E (supporting evidence)
    if ext in (".heic", ".heif"):
        return ClassificationResult(
            category=SectionCategory.APPENDIX_E,
            confidence=0.99,
            reasoning="iPhone site photograph — supporting evidence",
        )

    # Visio files are always maps/plot plans
    if ext in (".vsd", ".vsdx"):
        return ClassificationResult(
            category=SectionCategory.APPENDIX_A,
            confidence=0.99,
            reasoning="Visio file — site map or plot plan",
        )

    return None  # Needs AI classification


def render_page_to_base64(pdf_path: Path, page: int = 0) -> Optional[str]:
    """Render a single PDF page to PNG via Ghostscript, return base64 string."""
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name

        cmd = [
            settings.GHOSTSCRIPT_PATH,
            "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dQUIET",
            "-sDEVICE=png16m", "-r150",
            f"-dFirstPage={page + 1}", f"-dLastPage={page + 1}",
            f"-sOutputFile={tmp_path}",
            str(pdf_path),
        ]
        subprocess.run(cmd, timeout=30, check=True, capture_output=True)

        tmp_file = Path(tmp_path)
        if tmp_file.exists() and tmp_file.stat().st_size > 0:
            with open(tmp_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
            tmp_file.unlink(missing_ok=True)
            return b64

        tmp_file.unlink(missing_ok=True)
        return None
    except Exception as e:
        logger.warning(f"Failed to render page {page} of {pdf_path.name}: {e}")
        Path(tmp_path).unlink(missing_ok=True) if 'tmp_path' in locals() else None
        return None


def extract_classification_content(pdf_path: Path, filename: str, rel_path: str) -> dict:
    """Extract everything AI needs to classify a document."""
    content = {
        "filename": filename,
        "relative_path": rel_path,
        "page_count": 0,
        "file_size_kb": 0,
        "first_page_text": "",
        "first_page_image_b64": None,
    }

    try:
        content["file_size_kb"] = int(pdf_path.stat().st_size / 1024)
    except Exception:
        pass

    try:
        reader = PdfReader(str(pdf_path))
        content["page_count"] = len(reader.pages)
    except Exception:
        pass

    # Extract text from first 2 pages (500 chars is enough for header/title classification)
    content["first_page_text"] = _extract_text_from_pdf(pdf_path, max_pages=2, max_chars=500)

    # If text is too short (scanned PDF), try OCR
    if len(content["first_page_text"].strip()) < 50:
        try:
            ocr_text = _ocr_pdf_pages(pdf_path, max_pages=1, max_chars=500)
            if len(ocr_text.strip()) > len(content["first_page_text"].strip()):
                content["first_page_text"] = ocr_text
        except Exception:
            pass

    return content


def _build_content_user_message(content: dict) -> str:
    """Build the user message for content-based classification."""
    parts = [
        f"Filename: {content['filename']}",
    ]
    if content.get('relative_path'):
        parts.append(f"Path: {content['relative_path']}")
    parts.append(f"Pages: {content['page_count']}, Size: {content['file_size_kb']}KB")

    text = content["first_page_text"].strip()
    if text:
        parts.append(f"\nText:\n{text[:500]}")
    else:
        parts.append("\n(No text extracted — scanned document or image)")

    return "\n".join(parts)


async def _classify_with_ollama_vision(content: dict) -> ClassificationResult:
    """Classify using Ollama vision model for scanned PDFs / images."""
    user_message = _build_content_user_message(content)

    messages = [
        {"role": "system", "content": CONTENT_CLASSIFICATION_PROMPT},
        {
            "role": "user",
            "content": user_message,
            "images": [content["first_page_image_b64"]],
        },
    ]

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{settings.OLLAMA_URL}/api/chat",
            json={
                "model": settings.OLLAMA_VL_MODEL,
                "messages": messages,
                "stream": False,
                "format": "json",
            },
        )
        response.raise_for_status()
        data = response.json()
        return _parse_ai_response(data["message"]["content"])


async def _classify_with_ollama(content: dict) -> ClassificationResult:
    """Classify using a local Ollama text model."""
    user_message = _build_content_user_message(content)

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{settings.OLLAMA_URL}/api/generate",
            json={
                "model": settings.OLLAMA_MODEL,
                "prompt": f"{CONTENT_CLASSIFICATION_PROMPT}\n\n{user_message}",
                "stream": False,
                "format": "json",
            },
        )
        response.raise_for_status()
        data = response.json()
        return _parse_ai_response(data["response"])


def _build_user_message(original_filename: str, relative_path: str, ext: str, text_content: str) -> str:
    """Build the classification prompt for the AI model (legacy format for Anthropic)."""
    return f"""Classify this document:

Filename: {original_filename}
File path: {relative_path}
File type: {ext}

Text content excerpt:
{text_content[:2000] if text_content else "(No text could be extracted - classify based on filename and path)"}
"""


def _parse_ai_response(response_text: str) -> ClassificationResult:
    """Parse a JSON classification response from any AI model."""
    # Strip markdown code fences if present
    text = response_text.strip()
    if text.startswith("```"):
        text = re.sub(r"```(?:json)?\s*", "", text)
        text = text.rstrip("`").strip()

    data = json.loads(text)

    return ClassificationResult(
        category=SectionCategory(data["category"]),
        subcategory=data.get("subcategory"),
        confidence=float(data.get("confidence", 0.8)),
        reasoning=data.get("reasoning", "AI classification"),
    )


async def _classify_with_anthropic(user_message: str) -> ClassificationResult:
    """Classify using Claude API (paid, requires API key)."""
    import anthropic

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    response = client.messages.create(
        model=settings.CLAUDE_MODEL,
        max_tokens=300,
        system=CONTENT_CLASSIFICATION_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )

    return _parse_ai_response(response.content[0].text)


async def classify_document_by_content(
    pdf_path: Path,
    filename: str,
    relative_path: str = "",
) -> ClassificationResult:
    """Primary content-based classifier. Analyzes document content via AI."""

    # Pre-filter: trivially obvious file types skip AI
    prefilter = needs_ai_classification(filename)
    if prefilter is not None:
        return prefilter

    # Extract content for AI analysis
    content = extract_classification_content(pdf_path, filename, relative_path)

    ai_result = None

    try:
        ai_result = await _classify_with_ollama(content)
    except Exception as e:
        logger.error(f"AI classification failed for {filename}: {e}")

    # If AI failed entirely, fall back to legacy filename classifier
    if ai_result is None:
        legacy = classify_by_filename_legacy(filename, relative_path)
        if legacy:
            legacy.reasoning = f"[FALLBACK] {legacy.reasoning} (AI classification unavailable)"
            return legacy
        return ClassificationResult(
            category=SectionCategory.UNCLASSIFIED,
            confidence=0.0,
            reasoning="Classification failed: AI unavailable and no filename match",
        )

    # Sanity check: compare AI result with legacy filename classifier
    legacy = classify_by_filename_legacy(filename, relative_path)
    if (
        legacy
        and legacy.confidence >= 0.85
        and legacy.category != ai_result.category
    ):
        ai_result.reasoning = (
            f"{ai_result.reasoning} "
            f"[NOTE: filename suggests {legacy.category.value} — {legacy.reasoning}]"
        )

    return ai_result


async def classify_document(
    file_path: Path,
    original_filename: str,
    relative_path: str = "",
) -> ClassificationResult:
    """Classify a document — routes to content-based AI or legacy depending on backend config."""

    # If AI is disabled, use legacy filename classifier
    if settings.AI_BACKEND == "none":
        result = classify_by_filename_legacy(original_filename, relative_path)
        if result:
            return result
        return ClassificationResult(
            category=SectionCategory.UNCLASSIFIED,
            confidence=0.0,
            reasoning="AI disabled and filename did not match any pattern",
        )

    # Anthropic path — keep existing behavior
    if settings.AI_BACKEND == "anthropic":
        # Try filename first for speed
        result = classify_by_filename_legacy(original_filename, relative_path)
        if result and result.confidence >= 0.85:
            return result

        ext = file_path.suffix.lower()
        text_content = ""
        if ext == ".pdf":
            text_content = _extract_text_from_pdf(file_path)
        elif ext in (".docx", ".doc"):
            text_content = _extract_text_from_docx(file_path)

        user_message = _build_user_message(original_filename, relative_path, ext, text_content)

        try:
            if not settings.ANTHROPIC_API_KEY:
                raise ValueError("ANTHROPIC_API_KEY not set")
            return await _classify_with_anthropic(user_message)
        except Exception as e:
            logger.error(f"Anthropic classification failed for {original_filename}: {e}")
            if result:
                return result
            return ClassificationResult(
                category=SectionCategory.UNCLASSIFIED,
                confidence=0.0,
                reasoning=f"Classification failed: {str(e)}",
            )

    # Default: Ollama content-based classification (new primary path)
    return await classify_document_by_content(file_path, original_filename, relative_path)


async def classify_all_documents_queued(
    documents: list[tuple],
    result_queue: asyncio.Queue,
    concurrency: int | None = None,
):
    """Classify documents concurrently, pushing results to a queue for SSE streaming.

    Each item in `documents` is (doc_id, pdf_path, filename, rel_path).
    Results pushed: {doc_id, result, filename, current, total} or None sentinel.
    """
    sem = asyncio.Semaphore(concurrency or settings.OLLAMA_CONCURRENCY)
    total = len(documents)
    counter = {"done": 0}

    async def _classify_one(doc_id: int, pdf_path: Path, filename: str, rel_path: str):
        async with sem:
            result = await classify_document(pdf_path, filename, rel_path)
            counter["done"] += 1
            await result_queue.put({
                "doc_id": doc_id,
                "result": result,
                "filename": filename,
                "current": counter["done"],
                "total": total,
            })

    tasks = [
        _classify_one(doc_id, pdf_path, filename, rel_path)
        for doc_id, pdf_path, filename, rel_path in documents
    ]
    await asyncio.gather(*tasks, return_exceptions=True)

    # Sentinel to signal completion
    await result_queue.put(None)


# ---- Assembly validation (unchanged) ----

ASSEMBLY_VALIDATION_PROMPT = """You are an expert Phase I Environmental Site Assessment (ESA) report validator. Review this document manifest and identify misclassifications.

The correct report template order is:
1. RELIANCE_LETTER - Reliance letter to a third party
2. EO_INSURANCE - E&O insurance certificate
3. COVER_WRITEUP - Main Phase I ESA report body (should be 1-3 documents max: the report itself, maybe a cover letter)
4. APPENDIX_A - Property Location Map & Plot Plan
5. APPENDIX_B - Site Photographs (photos from site visit)
6. APPENDIX_C - Database/Radius Report
7. APPENDIX_D - Historical Records (Sanborn maps, aerials, topos, city directories)
8. APPENDIX_E - Public Agency Records, property profiles, FOIA responses
9. REPORTS_AFTER_E - Supporting reports (permits, monitoring data, GeoTracker, BLA reports, remediation reports)
10. APPENDIX_F - Qualifications of Environmental Professional

Common misclassification patterns to check:
- E&O insurance classified as RELIANCE_LETTER or vice versa
- Too many documents (>3) in COVER_WRITEUP — extra docs are likely APPENDIX_E or REPORTS_AFTER_E
- Photos/images in wrong sections (should almost always be APPENDIX_B)
- Historical aerial photos or Sanborn maps not in APPENDIX_D
- Monitoring reports or permits in APPENDIX_E instead of REPORTS_AFTER_E
- Historical maps in APPENDIX_E instead of APPENDIX_D
- Radius/database reports not in APPENDIX_C

Review the manifest below and return a JSON object with a "corrections" array. Each correction should have:
- "document_id": the ID of the document to move
- "current_section": current section name
- "suggested_section": correct section name
- "reason": brief explanation

If no corrections are needed, return {"corrections": []}.

IMPORTANT: Only suggest corrections you are confident about. Do not move documents if you're unsure.

Document manifest:
{manifest}"""


async def validate_assembly(report_id: int, db) -> dict:
    """Review the full document manifest and fix cross-document misclassifications."""
    from database import Document

    if settings.AI_BACKEND == "none":
        return {"applied": 0, "flagged": 0, "skipped": True}

    try:
        docs = db.query(Document).filter(
            Document.report_id == report_id,
            Document.is_included == True,
        ).order_by(Document.category, Document.sort_order, Document.id).all()

        if not docs:
            return {"applied": 0, "flagged": 0, "skipped": True}

        # Build manifest string — summarize large sections to fit context window
        from collections import defaultdict
        by_section: dict[str, list] = defaultdict(list)
        for doc in docs:
            by_section[doc.category].append(doc)

        lines = ["id | filename | section | subcategory | pages | confidence"]
        MAX_PER_SECTION = 10
        for section, section_docs in by_section.items():
            if len(section_docs) <= MAX_PER_SECTION:
                for doc in section_docs:
                    lines.append(
                        f"{doc.id} | {doc.original_filename} | {doc.category} | "
                        f"{doc.subcategory or '-'} | {doc.page_count or '?'} | "
                        f"{doc.confidence or '?'}"
                    )
            else:
                for doc in section_docs[:5]:
                    lines.append(
                        f"{doc.id} | {doc.original_filename} | {doc.category} | "
                        f"{doc.subcategory or '-'} | {doc.page_count or '?'} | "
                        f"{doc.confidence or '?'}"
                    )
                remaining = len(section_docs) - 5
                total_pages = sum(d.page_count or 0 for d in section_docs[5:])
                lines.append(
                    f"... | ({remaining} more similar files) | {section} | "
                    f"- | {total_pages} total pages | -"
                )
        manifest = "\n".join(lines)

        prompt = ASSEMBLY_VALIDATION_PROMPT.replace("{manifest}", manifest)

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{settings.OLLAMA_URL}/api/generate",
                json={
                    "model": settings.OLLAMA_MODEL,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                },
            )
            response.raise_for_status()
            data = response.json()

        # Parse response
        raw = data["response"].strip()
        if raw.startswith("```"):
            raw = re.sub(r"```(?:json)?\s*", "", raw)
            raw = raw.rstrip("`").strip()

        result = json.loads(raw)
        corrections = result.get("corrections", [])

        # Build doc lookup
        doc_map = {doc.id: doc for doc in docs}

        applied = 0
        for correction in corrections:
            doc_id = correction.get("document_id")
            suggested = correction.get("suggested_section")
            reason = correction.get("reason", "")

            if doc_id not in doc_map:
                continue

            # Validate the suggested section is a real category
            try:
                new_category = SectionCategory(suggested)
            except ValueError:
                logger.warning(f"Validator suggested invalid section '{suggested}' for doc {doc_id}")
                continue

            doc = doc_map[doc_id]
            old_category = doc.category
            if old_category == new_category.value:
                continue

            # Guard: don't override high-confidence classifications
            if doc.confidence and doc.confidence >= 0.90:
                logger.info(
                    f"Validator skipping override for {doc.original_filename} "
                    f"(confidence {doc.confidence}): suggested {new_category.value}"
                )
                continue

            # Guard: NEVER move anything INTO COVER_WRITEUP via validator
            if new_category == SectionCategory.COVER_WRITEUP:
                logger.info(
                    f"Validator blocked move to COVER_WRITEUP for {doc.original_filename}"
                )
                continue

            doc.category = new_category.value
            doc.reasoning = f"AI validator: {reason}"
            doc.confidence = 0.85
            applied += 1
            logger.info(f"Validator moved doc {doc_id} ({doc.original_filename}): {old_category} → {new_category.value}")

        if applied > 0:
            db.commit()

        logger.info(f"Assembly validation for report {report_id}: {applied} corrections applied")
        return {"applied": applied, "flagged": 0, "skipped": False}

    except Exception as e:
        logger.warning(f"Assembly validation failed for report {report_id}: {e}")
        return {"applied": 0, "flagged": 0, "skipped": True}


async def classify_documents_batch(
    documents: list[tuple[Path, str, str]],
    progress_callback=None,
) -> list[ClassificationResult]:
    """Classify multiple documents. Each tuple is (file_path, original_filename, relative_path)."""
    results = []
    total = len(documents)

    for i, (file_path, filename, rel_path) in enumerate(documents):
        if progress_callback:
            progress_callback(i / total, f"Classifying: {filename}")

        result = await classify_document(file_path, filename, rel_path)
        results.append(result)

    if progress_callback:
        progress_callback(1.0, "Classification complete")

    return results

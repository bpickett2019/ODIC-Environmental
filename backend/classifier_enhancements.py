"""Smart sampling and ordering hint extraction for 18K-page documents.

For large documents, we can't afford to read every page. Instead:
- Read first 5 pages (metadata, classification hints)
- Read last 5 pages (conclusion, appendix structure)
- For Appendix D docs: extract sanborn/aerial/topo/city_directory hints
- For Appendix E docs: detect property profile (rank first)
- Extract cross-contamination clues (project ID, address, company)
"""

import logging
import re
from pathlib import Path
from typing import Optional
from pypdf import PdfReader

logger = logging.getLogger(__name__)


def get_page_count_safe(pdf_path: Path) -> int:
    """Get PDF page count safely."""
    try:
        reader = PdfReader(str(pdf_path))
        return len(reader.pages)
    except Exception as e:
        logger.warning(f"Could not get page count for {pdf_path.name}: {e}")
        return 0


def extract_first_n_pages(pdf_path: Path, n: int = 5, max_chars: int = 5000) -> str:
    """Extract text from first N pages of a PDF."""
    try:
        reader = PdfReader(str(pdf_path))
        text_parts = []
        for i, page in enumerate(reader.pages[:n]):
            text = page.extract_text() or ""
            text_parts.append(text)
            if sum(len(t) for t in text_parts) > max_chars:
                break
        return "\n".join(text_parts)[:max_chars]
    except Exception:
        return ""


def extract_last_n_pages(pdf_path: Path, n: int = 3, max_chars: int = 3000) -> str:
    """Extract text from last N pages of a PDF."""
    try:
        reader = PdfReader(str(pdf_path))
        start_idx = max(0, len(reader.pages) - n)
        text_parts = []
        for page in reader.pages[start_idx:]:
            text = page.extract_text() or ""
            text_parts.append(text)
            if sum(len(t) for t in text_parts) > max_chars:
                break
        return "\n".join(text_parts)[:max_chars]
    except Exception:
        return ""


def extract_header_footer(pdf_path: Path, max_chars: int = 500) -> str:
    """Extract text from header/footer area of first page (top 10% and bottom 10%)."""
    try:
        reader = PdfReader(str(pdf_path))
        if not reader.pages:
            return ""
        
        first_page = reader.pages[0]
        text = first_page.extract_text() or ""
        
        # Get rough text lines
        lines = text.split("\n")
        if len(lines) < 4:
            return text[:max_chars]
        
        # Header: first 3 lines + footer: last 3 lines
        header = "\n".join(lines[:3])
        footer = "\n".join(lines[-3:])
        return (header + "\n---\n" + footer)[:max_chars]
    except Exception:
        return ""


def extract_ordering_hint(pdf_path: Path, category: str, max_chars: int = 2000) -> Optional[str]:
    """
    Extract subcategory hint for Appendix D documents.
    
    For a PDF that might be:
    - Sanborn fire insurance map
    - Aerial photograph
    - Topographic map
    - City directory
    
    Return: "sanborn", "aerials", "topos", "city_directory", or None
    """
    if category != "APPENDIX_D":
        return None
    
    first_pages = extract_first_n_pages(pdf_path, n=5, max_chars=max_chars)
    
    # Patterns to detect each type
    sanborn_patterns = [
        r"sanborn",
        r"fire.*insurance.*map",
        r"insurance map",
        r"sanborn-perthes",
    ]
    
    aerial_patterns = [
        r"aerial",
        r"orthophoto",
        r"orthoimagery",
        r"air photo",
        r"usgs.*photo",
    ]
    
    topo_patterns = [
        r"topographic",
        r"topo.*map",
        r"usgs.*quad",
        r"quadrangle",
        r"contour.*map",
    ]
    
    city_dir_patterns = [
        r"city.*director",
        r"city directory",
        r"polk.*director",
        r"business directory",
    ]
    
    text_lower = first_pages.lower()
    
    # Score each type
    sanborn_score = sum(1 for p in sanborn_patterns if re.search(p, text_lower))
    aerial_score = sum(1 for p in aerial_patterns if re.search(p, text_lower))
    topo_score = sum(1 for p in topo_patterns if re.search(p, text_lower))
    city_dir_score = sum(1 for p in city_dir_patterns if re.search(p, text_lower))
    
    # Return highest scoring match
    scores = [
        (sanborn_score, "sanborn"),
        (aerial_score, "aerials"),
        (topo_score, "topos"),
        (city_dir_score, "city_directory"),
    ]
    scores.sort(reverse=True)
    
    if scores[0][0] > 0:
        return scores[0][1]
    
    return None


def detect_property_profile(pdf_path: Path, category: str, max_chars: int = 2000) -> bool:
    """
    Detect if a document in Appendix E is a Property Profile/Detail Report.
    These should be sorted FIRST in Appendix E.
    """
    if category != "APPENDIX_E":
        return False
    
    first_pages = extract_first_n_pages(pdf_path, n=3, max_chars=max_chars)
    text_lower = first_pages.lower()
    
    patterns = [
        r"property.*detail",
        r"property.*profile",
        r"title company report",
        r"preliminary title report",
        r"property information",
    ]
    
    return any(re.search(p, text_lower) for p in patterns)


def detect_cross_contamination(pdf_path: Path, expected_project_id: Optional[str] = None) -> Optional[dict]:
    """
    Extract project metadata from document header/footer.
    Return dict with found_project_id, found_address, found_company
    
    Flags if different from expected project.
    """
    header_footer = extract_header_footer(pdf_path, max_chars=1000)
    
    # Try to extract project ID (usually looks like "6384674" or "BLA-0000014401")
    project_patterns = [
        r"project\s*(?:id|#|number)?:?\s*([0-9a-z\-]{4,})",
        r"(?:bla|ec|smeh|fa)\s*[-_]?\s*([0-9a-z]{7,})",
        r"^([0-9]{7,10})\b",  # 7-10 digit project number
    ]
    
    found_project_id = None
    for pattern in project_patterns:
        match = re.search(pattern, header_footer, re.IGNORECASE)
        if match:
            found_project_id = match.group(1)
            break
    
    # Try to extract address
    address_pattern = r"(\d+\s+\w+\s+(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd))"
    found_address = None
    match = re.search(address_pattern, header_footer, re.IGNORECASE)
    if match:
        found_address = match.group(1)
    
    # Try to extract company name (anything that looks like a firm name)
    company_patterns = [
        r"©\s*(\w+(?:\s+\w+)*)",
        r"(environmental|engineering|consulting)\s+(\w+(?:\s+\w+)*)",
    ]
    found_company = None
    for pattern in company_patterns:
        match = re.search(pattern, header_footer, re.IGNORECASE)
        if match:
            found_company = match.group(0) if pattern.count("(") == 1 else match.group(2)
            break
    
    return {
        "found_project_id": found_project_id,
        "found_address": found_address,
        "found_company": found_company,
    }


def smart_text_extraction(pdf_path: Path, total_pages: int) -> tuple[str, dict]:
    """
    Smart extraction for large documents.
    
    - For small docs (<50 pages): read fully
    - For large docs (50-18000 pages): sample key pages
    
    Returns: (extracted_text, metadata_dict)
    """
    if total_pages < 50:
        # Small doc - read it all
        try:
            from pypdf import PdfReader
            reader = PdfReader(str(pdf_path))
            text_parts = []
            for page in reader.pages:
                text = page.extract_text() or ""
                text_parts.append(text)
                if sum(len(t) for t in text_parts) > 10000:  # 10K chars limit
                    break
            extracted = "\n".join(text_parts)[:10000]
        except Exception:
            extracted = extract_first_n_pages(pdf_path, n=5, max_chars=5000)
    else:
        # Large doc - sample smartly
        # First 5 pages + last 3 pages + every 100th page up to a limit
        extracted_parts = []
        
        # First 5 pages
        extracted_parts.append(extract_first_n_pages(pdf_path, n=5, max_chars=3000))
        
        # Last 3 pages
        extracted_parts.append(extract_last_n_pages(pdf_path, n=3, max_chars=2000))
        
        # Sample every Nth page (limit to 5 samples)
        sample_interval = max(1, total_pages // 100)
        sample_count = 0
        for i in range(50, min(total_pages - 50, 500), sample_interval):
            if sample_count >= 5:
                break
            try:
                reader = PdfReader(str(pdf_path))
                if i < len(reader.pages):
                    text = reader.pages[i].extract_text() or ""
                    extracted_parts.append(text[:500])
                    sample_count += 1
            except Exception:
                pass
        
        extracted = "\n[SAMPLE PAGE]\n".join(extracted_parts)[:8000]
    
    # Extract metadata from header
    contamination_check = detect_cross_contamination(pdf_path)
    
    return extracted, contamination_check

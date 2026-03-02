"""PDF assembly engine - merge documents into a single report PDF."""

from __future__ import annotations

import logging
import re
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from config import settings

logger = logging.getLogger(__name__)


def _strip_trailing_blanks(reader: PdfReader) -> list[int]:
    """Return list of page indices to include, stripping trailing near-blank pages.

    Walks backwards from the last page. Pages with < 10 chars of text are considered blank.
    """
    pages = list(range(len(reader.pages)))
    while pages:
        last_idx = pages[-1]
        try:
            text = reader.pages[last_idx].extract_text() or ""
            if len(text.strip()) >= 10:
                break  # Real content found
            pages.pop()
        except Exception:
            break  # Can't read page, keep it
    return pages


def assemble_report(
    documents: list[dict],
    output_path: Path,
    has_reliance_letter: bool = True,
    progress_callback=None,
) -> dict:
    """
    Assemble a complete report from classified documents.

    documents: list of dicts with keys:
        - pdf_path: Path to the PDF file
        - category: SectionCategory value
        - subcategory: optional subcategory string
        - sort_order: int for ordering within section
        - original_filename: str

    Returns dict with assembly statistics.
    """
    writer = PdfWriter()
    total_pages = 0
    section_pages = {}
    document_manifest = []
    errors = []

    # Determine which sections to include
    section_order = list(settings.SECTION_ORDER)
    if not has_reliance_letter:
        section_order = [s for s in section_order if s != "RELIANCE_LETTER"]

    # Group documents by section
    docs_by_section: dict[str, list[dict]] = {s: [] for s in section_order}
    docs_by_section["UNCLASSIFIED"] = []

    for doc in documents:
        cat = doc["category"]
        if cat in docs_by_section:
            docs_by_section[cat].append(doc)
        else:
            docs_by_section["UNCLASSIFIED"].append(doc)

    # Sort within each section
    def _sort_key(doc, cat):
        """Generate sort key for a document within its section."""
        filename = doc.get("original_filename", "").lower()
        sort_order = doc.get("sort_order", 0)

        if cat == "APPENDIX_D":
            subcat_order = {s: i for i, s in enumerate(settings.APPENDIX_D_ORDER)}
            return (subcat_order.get(doc.get("subcategory", ""), 99), sort_order, filename)

        if cat == "REPORTS_AFTER_E":
            # Group by source type, then filename
            group = 99
            path = doc.get("original_path", "").lower()
            if re.search(r"bla-", filename) or "bla-" in path: group = 0
            elif re.search(r"ec_attachments", filename) or "ec_attachments" in path: group = 1
            elif re.search(r"smeh", filename) or "smeh" in path: group = 2
            elif re.search(r"geotracker", filename) or "geotracker" in path: group = 3
            return (sort_order, group, filename)

        if cat == "APPENDIX_B":
            # Natural sort by filename (so DSCN0322 < DSCN1595)
            return (sort_order, filename)

        # All other sections: sort_order then filename
        return (sort_order, filename)

    for cat, docs in docs_by_section.items():
        docs.sort(key=lambda d, c=cat: _sort_key(d, c))

    total_docs = sum(len(docs) for docs in docs_by_section.values())
    processed = 0

    for section_name in section_order:
        docs = docs_by_section.get(section_name, [])
        if not docs:
            continue

        # Add documents in order
        section_page_start = total_pages
        for doc in docs:
            pdf_path = Path(doc["pdf_path"])
            if not pdf_path.exists():
                errors.append(f"File not found: {doc['original_filename']}")
                continue

            doc_start_page = total_pages
            try:
                reader = PdfReader(str(pdf_path))
                # Strip trailing blank pages from converted DOCX files
                orig_name = doc.get("original_filename", "").lower()
                if orig_name.endswith((".docx", ".doc")):
                    page_indices = _strip_trailing_blanks(reader)
                else:
                    page_indices = list(range(len(reader.pages)))
                for pidx in page_indices:
                    writer.add_page(reader.pages[pidx])
                    total_pages += 1

                document_manifest.append({
                    "doc_id": doc.get("doc_id"),
                    "filename": doc["original_filename"],
                    "category": doc["category"],
                    "subcategory": doc.get("subcategory"),
                    "start_page": doc_start_page + 1,
                    "end_page": total_pages,
                    "page_count": total_pages - doc_start_page,
                })

                processed += 1
                if progress_callback:
                    progress_callback(
                        processed / total_docs,
                        f"Adding: {doc['original_filename']}"
                    )

            except Exception as e:
                errors.append(f"Error reading {doc['original_filename']}: {str(e)}")
                logger.error(f"Error adding {doc['original_filename']} to report: {e}")

        section_pages[section_name] = total_pages - section_page_start

    # Write the assembled PDF
    with open(output_path, "wb") as f:
        writer.write(f)

    # Verify output integrity
    try:
        verify_reader = PdfReader(str(output_path))
        actual_pages = len(verify_reader.pages)
        if actual_pages != total_pages:
            logger.error(f"Page count mismatch: expected {total_pages}, got {actual_pages}")
            errors.append(f"Page count mismatch: expected {total_pages}, wrote {actual_pages}")
    except Exception as e:
        logger.error(f"Could not verify assembled PDF: {e}")
        errors.append(f"Output PDF verification failed: {str(e)}")

    file_size = output_path.stat().st_size
    expected_pages = sum(d.get("page_count", 0) or 0 for d in documents)

    return {
        "total_pages": total_pages,
        "expected_pages": expected_pages,
        "total_documents": processed,
        "file_size": file_size,
        "section_pages": section_pages,
        "document_manifest": document_manifest,
        "errors": errors,
        "output_path": str(output_path),
    }

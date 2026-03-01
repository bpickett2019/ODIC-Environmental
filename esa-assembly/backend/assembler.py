"""Report assembler — maps classified docs to ESA template structure."""

import logging
from typing import Dict, List, Optional

logger = logging.getLogger("esa.assembler")

# ESA Template structure matching the frontend UI sections exactly.
# Order matters — this is the final report order.
TEMPLATE_SECTIONS = [
    {"key": "reliance", "title": "Reliance Letter", "is_appendix": False, "required": False,
     "doc_types": ["reliance_letter"]},
    {"key": "eo", "title": "E&O Insurance", "is_appendix": False, "required": True,
     "doc_types": ["eo_insurance"]},
    {"key": "cover", "title": "Cover Page", "is_appendix": False, "required": True,
     "doc_types": ["cover_page"]},
    {"key": "writeup", "title": "Write-Up", "is_appendix": False, "required": True,
     "doc_types": ["write_up", "executive_summary", "site_description"]},
    {"key": "appendix_a", "title": "APPENDIX A \u2013 PROPERTY LOCATION MAP & PLOT PLAN",
     "is_appendix": True, "required": True,
     "doc_types": ["site_map", "plot_plan", "topographic_map"]},
    {"key": "appendix_b", "title": "APPENDIX B \u2013 PROPERTY & VICINITY PHOTOGRAPHS",
     "is_appendix": True, "required": True,
     "doc_types": ["site_photograph", "site_photo"]},
    {"key": "appendix_c", "title": "APPENDIX C \u2013 DATABASE REPORT",
     "is_appendix": True, "required": True,
     "doc_types": ["database_report", "edr_report"]},
    {"key": "appendix_d", "title": "APPENDIX D \u2013 HISTORICAL RECORDS RESEARCH",
     "is_appendix": True, "required": True,
     "doc_types": ["sanborn_map", "aerial_photograph", "city_directory", "fire_insurance_map"],
     "sort_order": ["sanborn_map", "fire_insurance_map", "aerial_photograph", "topographic_map", "city_directory"]},
    {"key": "appendix_e", "title": "APPENDIX E \u2013 PUBLIC AGENCY RECORDS / OTHER RELEVANT DOCUMENTS",
     "is_appendix": True, "required": True,
     "doc_types": ["property_profile", "public_record", "regulatory_correspondence",
                   "title_record", "tax_record", "building_permit", "lab_results",
                   "client_correspondence"]},
    # Reference reports go AFTER Appendix E, BEFORE Appendix F — CRITICAL RULE
    {"key": "reference", "title": "REFERENCE REPORTS", "is_appendix": True, "required": False,
     "doc_types": ["reference_report", "prior_environmental_report"]},
    {"key": "appendix_f", "title": "APPENDIX F \u2013 QUALIFICATIONS OF ENVIRONMENTAL PROFESSIONAL",
     "is_appendix": True, "required": True,
     "doc_types": ["qualifications"]},
]


def detect_reliance_letter(documents: List[Dict]) -> Dict:
    """Check if any document is a reliance letter."""
    for doc in documents:
        cls = doc.get("classification", {})
        if cls.get("doc_type") == "reliance_letter":
            return {
                "has_reliance_letter": True,
                "template": "A",
                "reasoning": (
                    f"Reliance letter detected: '{doc.get('original_filename', '')}'. "
                    "Using Template A (with reliance authorization)."
                ),
                "doc_id": doc["id"],
            }
    return {
        "has_reliance_letter": False,
        "template": "B",
        "reasoning": (
            "No reliance letter found among uploaded documents. "
            "Using Template B (without reliance authorization)."
        ),
        "doc_id": None,
    }


def create_assembly(project: dict) -> dict:
    """Create assembly mapping from classified documents.

    CRITICAL RULES:
    1. Appendix D order: Sanborn > Aerials > Topos > City Directories
    2. Reference reports (non-ODIC) go AFTER Appendix E, BEFORE Appendix F
    3. Template A/B auto-detection based on reliance letter
    """
    documents = project.get("documents", [])
    template_info = detect_reliance_letter(documents)

    sections = []
    reasoning_log = []

    for tmpl in TEMPLATE_SECTIONS:
        section = {
            "key": tmpl["key"],
            "title": tmpl["title"],
            "is_appendix": tmpl["is_appendix"],
            "required": tmpl.get("required", True),
            "document_ids": [],
            "documents": [],
        }

        matching = []
        for doc in documents:
            cls = doc.get("classification", {})
            doc_type = cls.get("doc_type", "other")
            is_ref = cls.get("is_reference_report", False)

            # Reference reports only go to the reference section
            if is_ref and tmpl["key"] == "reference":
                matching.append(doc)
            elif is_ref:
                continue
            elif doc_type in tmpl["doc_types"]:
                matching.append(doc)

        # Enforce Appendix D sort order: Sanborn > fire insurance > aerials > topos > city dirs
        if tmpl["key"] == "appendix_d" and "sort_order" in tmpl:
            order = tmpl["sort_order"]

            def sort_key(d):
                dt = d.get("classification", {}).get("doc_type", "other")
                return order.index(dt) if dt in order else len(order)

            matching.sort(key=sort_key)
            if matching:
                reasoning_log.append({
                    "section": tmpl["title"],
                    "action": (
                        "Sorted historical sources: Sanborn maps \u2192 Fire insurance maps "
                        "\u2192 Aerial photographs \u2192 Topographic maps \u2192 City directories"
                    ),
                    "doc_count": len(matching),
                })

        for doc in matching:
            cls = doc.get("classification", {})
            section["document_ids"].append(doc["id"])
            section["documents"].append({
                "id": doc["id"],
                "name": doc.get("original_filename", ""),
                "filename": doc.get("original_filename", ""),
                "doc_type": cls.get("doc_type", "unknown"),
                "classification": cls.get("doc_type", "unknown"),
                "confidence": cls.get("confidence", 0),
                "reasoning": cls.get("reasoning", ""),
                "pages": doc.get("page_count", 0),
                "page_count": doc.get("page_count", 0),
                "is_reference_report": cls.get("is_reference_report", False),
                "author_firm": cls.get("author_firm", "unknown"),
                "section": tmpl["key"],
                "flagged": cls.get("confidence", 100) < 80,
            })

            reasoning_log.append({
                "section": tmpl["title"],
                "doc_id": doc["id"],
                "filename": doc.get("original_filename", ""),
                "reasoning": (
                    f"Placed '{doc.get('original_filename', '')}' in "
                    f"{tmpl['title']} because classified as "
                    f"'{cls.get('doc_type', 'unknown')}' "
                    f"({cls.get('confidence', 0)}% confidence)"
                ),
            })

        sections.append(section)

    # Find unplaced docs
    placed_ids = set()
    for s in sections:
        placed_ids.update(s["document_ids"])

    unplaced = []
    for doc in documents:
        if doc["id"] not in placed_ids:
            cls = doc.get("classification", {})
            unplaced.append({
                "id": doc["id"],
                "name": doc.get("original_filename", ""),
                "filename": doc.get("original_filename", ""),
                "doc_type": cls.get("doc_type", "unknown"),
                "classification": cls.get("doc_type", "unknown"),
                "confidence": cls.get("confidence", 0),
                "reasoning": "Could not auto-place this document. Manual placement required.",
                "pages": doc.get("page_count", 0),
                "section": "__unplaced",
                "flagged": True,
            })

    # Build flags/alerts
    flags = []
    for doc in documents:
        cls = doc.get("classification", {})
        if cls.get("confidence", 100) < 80:
            flags.append({
                "type": "warning",
                "message": (
                    f"Low confidence: {doc.get('original_filename', '')} "
                    f"classified as {cls.get('doc_type', 'unknown')} "
                    f"({cls.get('confidence', 0)}%) \u2014 please verify"
                ),
            })
        if cls.get("is_reference_report"):
            flags.append({
                "type": "info",
                "message": (
                    f"Reference report detected: {cls.get('author_firm', 'unknown')} "
                    f"report placed after Appendix E"
                ),
            })

    if template_info["has_reliance_letter"]:
        flags.append({
            "type": "success",
            "message": "Template: With Reliance Letter \u2014 reliance letter detected in upload",
        })
    else:
        flags.append({
            "type": "info",
            "message": "Template: Without Reliance Letter \u2014 no reliance letter found",
        })

    return {
        "template": template_info,
        "sections": sections,
        "unplaced": unplaced,
        "reasoning": reasoning_log,
        "flags": flags,
    }

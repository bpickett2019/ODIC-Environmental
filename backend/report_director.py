"""Report Director — AI reviews the full manifest against the north star."""

from __future__ import annotations

import json
import logging
import re
from collections import defaultdict

import httpx

from config import settings
from north_star import NORTH_STAR_MANIFEST, TYPICAL_SECTION_RANGES

logger = logging.getLogger(__name__)

DIRECTOR_PROMPT = """You are reviewing an ESA report manifest before assembly. Your job is to compare it against a reference of what a correctly assembled report looks like, and recommend which documents to exclude.

""" + NORTH_STAR_MANIFEST + """

Now review this manifest:

This report has {total_docs} documents totaling {total_pages} pages.

{manifest}

COMPARE each section to the north star reference above. For each section:
1. Is the page count within the typical range?
2. Are there documents that don't belong in this section?
3. For REPORTS_AFTER_E: if over 500 pages, recommend keeping only the 5-10
   most important documents (initial investigation, most recent report,
   closure letter) and excluding all routine quarterly monitoring reports.

Return ONLY this JSON:
{{
  "health": "good" if total is 1000-4000 pages | "needs_attention" if outside range | "critical" if Cover/Write-Up is missing or empty,
  "estimated_pages_after_curation": <number>,
  "section_flags": [
    {{"section": "NAME", "issue": "description", "severity": "info|warning|error"}}
  ],
  "exclude_recommendations": [
    {{"doc_id": <id>, "filename": "name", "reason": "Routine quarterly monitoring report — not needed for Phase I ESA"}}
  ],
  "reclassify_recommendations": [
    {{"doc_id": <id>, "filename": "name", "current": "CURRENT", "suggested": "CORRECT", "reason": "why"}}
  ]
}}"""


async def run_report_director(report_id: int, db) -> dict:
    """Review the full manifest and return curation + reclassification recommendations."""
    from database import Document

    if settings.AI_BACKEND == "none":
        return {"health": "unknown", "skipped": True}

    try:
        docs = db.query(Document).filter(
            Document.report_id == report_id,
            Document.is_included == True,
        ).order_by(Document.category, Document.id).all()

        if not docs:
            return {"health": "critical", "section_flags": [
                {"section": "ALL", "issue": "No documents", "severity": "error"}
            ], "exclude_recommendations": [], "reclassify_recommendations": []}

        total_pages = sum(d.page_count or 0 for d in docs)
        by_section = defaultdict(list)
        for doc in docs:
            by_section[doc.category].append(doc)

        # Build manifest showing all docs (summarize large sections)
        lines = []
        for section in settings.SECTION_ORDER + ["UNCLASSIFIED"]:
            section_docs = by_section.get(section, [])
            if not section_docs:
                lines.append(f"\n[{section}] — EMPTY")
                continue
            sp = sum(d.page_count or 0 for d in section_docs)
            lines.append(f"\n[{section}] — {len(section_docs)} docs, {sp} pages:")

            show_count = 15 if section == "REPORTS_AFTER_E" else 10
            for doc in section_docs[:show_count]:
                lines.append(f"  id={doc.id} | {doc.original_filename} | {doc.page_count or '?'}p")
            if len(section_docs) > show_count:
                r = len(section_docs) - show_count
                rp = sum(d.page_count or 0 for d in section_docs[show_count:])
                lines.append(f"  ... {r} more ({rp}p)")

        manifest = "\n".join(lines)
        prompt = DIRECTOR_PROMPT.replace("{total_docs}", str(len(docs)))
        prompt = prompt.replace("{total_pages}", str(total_pages))
        prompt = prompt.replace("{manifest}", manifest)

        async with httpx.AsyncClient(timeout=120.0) as client:
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

        raw = data["response"].strip()
        if raw.startswith("```"):
            raw = re.sub(r"```(?:json)?\s*", "", raw)
            raw = raw.rstrip("`").strip()

        result = json.loads(raw)

        # Deterministic sanity checks ON TOP of AI recommendations
        # These catch things the AI might miss
        for section, ranges in TYPICAL_SECTION_RANGES.items():
            section_docs = by_section.get(section, [])
            section_pages = sum(d.page_count or 0 for d in section_docs)

            if section_pages == 0 and ranges["min_docs"] > 0:
                result.setdefault("section_flags", []).append({
                    "section": section,
                    "issue": f"{section} is empty — expected {ranges['min_pages']}-{ranges['max_pages']} pages",
                    "severity": "error" if section == "COVER_WRITEUP" else "warning"
                })
            elif section_pages > ranges["max_pages"] * 2:
                result.setdefault("section_flags", []).append({
                    "section": section,
                    "issue": f"{section} has {section_pages} pages (typical max: {ranges['max_pages']})",
                    "severity": "warning"
                })

        # Flag recommendations on documents (don't auto-exclude)
        doc_map = {doc.id: doc for doc in docs}
        flagged = 0

        for rec in result.get("exclude_recommendations", []):
            doc_id = rec.get("doc_id")
            if doc_id and doc_id in doc_map:
                doc = doc_map[doc_id]
                doc.reasoning = (doc.reasoning or "") + f" [DIRECTOR: recommend exclude — {rec.get('reason', '')}]"
                flagged += 1

        for rec in result.get("reclassify_recommendations", []):
            doc_id = rec.get("doc_id")
            if doc_id and doc_id in doc_map:
                doc = doc_map[doc_id]
                doc.reasoning = (doc.reasoning or "") + f" [DIRECTOR: suggest {rec.get('suggested', '?')} — {rec.get('reason', '')}]"
                flagged += 1

        if flagged > 0:
            db.commit()

        logger.info(f"Director report {report_id}: health={result.get('health')}, flagged={flagged}")

        return {
            "health": result.get("health", "unknown"),
            "estimated_pages": result.get("estimated_pages_after_curation"),
            "section_flags": result.get("section_flags", []),
            "exclude_count": len(result.get("exclude_recommendations", [])),
            "reclassify_count": len(result.get("reclassify_recommendations", [])),
            "exclude_recommendations": result.get("exclude_recommendations", []),
            "reclassify_recommendations": result.get("reclassify_recommendations", []),
            "flagged": flagged,
            "skipped": False,
        }

    except Exception as e:
        logger.warning(f"Director failed for report {report_id}: {e}")
        return {"health": "unknown", "skipped": True, "error": str(e)}

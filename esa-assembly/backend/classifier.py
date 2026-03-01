"""Document classifier — LLM-based with rule-based fallback."""

import json
import logging
import re
from typing import Optional

from llm_router import LLMRouter

logger = logging.getLogger("esa.classifier")

DOCUMENT_TYPES = [
    "reliance_letter",
    "eo_insurance",
    "cover_page",
    "write_up",
    "executive_summary",
    "site_description",
    "site_map",
    "plot_plan",
    "site_photograph",
    "site_photo",
    "database_report",
    "edr_report",
    "sanborn_map",
    "aerial_photograph",
    "topographic_map",
    "city_directory",
    "fire_insurance_map",
    "property_profile",
    "public_record",
    "regulatory_correspondence",
    "title_record",
    "tax_record",
    "building_permit",
    "lab_results",
    "client_correspondence",
    "reference_report",
    "prior_environmental_report",
    "qualifications",
    "other",
]

CLASSIFICATION_PROMPT = """You are an Environmental Site Assessment (ESA) document classifier for ODIC Environmental.

Given the filename and text content of a document, classify it into one of these types:
{types}

SECTION MAPPING (so you understand where each type goes in the final report):
- reliance_letter: Reliance Letter section
- eo_insurance: E&O Insurance certificate
- cover_page: Cover Page
- write_up / executive_summary / site_description: Main report narrative (Write-Up)
- site_map / plot_plan: Appendix A — Property Location Map & Plot Plan
- site_photograph / site_photo: Appendix B — Property & Vicinity Photographs
- database_report / edr_report: Appendix C — Database Report (EDR)
- sanborn_map / aerial_photograph / topographic_map / city_directory / fire_insurance_map: Appendix D — Historical Records Research
- property_profile / public_record / regulatory_correspondence / title_record / tax_record / building_permit / lab_results: Appendix E — Public Agency Records
- reference_report / prior_environmental_report: Reference Reports (non-ODIC authored)
- qualifications: Appendix F — Qualifications of Environmental Professional

CRITICAL AUTHORSHIP CHECK:
You MUST determine if the document was authored by ODIC Environmental or by a DIFFERENT firm.
- Look for company names, letterheads, project numbers from other firms
- A Phase I ESA or environmental report from another company = "reference_report" (NOT write_up)
- Reference reports are placed in a special section, not in the main body
- Common non-ODIC firms: Terracon, AECOM, Arcadis, Tetra Tech, GeoTech, WSP, Kleinfelder, etc.

Respond with ONLY valid JSON:
{{
    "doc_type": "<one of the types listed above>",
    "confidence": <0-100>,
    "reasoning": "<1-2 sentence explanation>",
    "is_reference_report": <true if authored by a firm OTHER than ODIC, false otherwise>,
    "author_firm": "<name of authoring firm if detected, or 'ODIC' or 'unknown'>"
}}"""

# Rule-based keyword patterns for fallback
KEYWORD_PATTERNS = {
    "reliance_letter": ["reliance letter", "reliance", "third party", "authorization to rely"],
    "eo_insurance": ["e&o", "errors and omissions", "liability insurance", "certificate of insurance",
                     "professional liability"],
    "cover_page": ["cover page", "cover sheet", "title page", "phase i environmental"],
    "write_up": ["executive summary", "site description", "records review", "findings",
                 "conclusions", "recommendations", "introduction", "purpose and scope"],
    "site_map": ["site location map", "location map", "vicinity map"],
    "plot_plan": ["plot plan", "site plan", "building footprint"],
    "site_photograph": ["site photo", "photograph", "photo log", "site visit"],
    "database_report": ["edr", "environmental data resources", "radius map", "database report",
                        "database search"],
    "sanborn_map": ["sanborn", "fire insurance map", "sanborn map"],
    "aerial_photograph": ["aerial", "air photo", "flight", "aerial photograph"],
    "topographic_map": ["topographic", "topo map", "usgs", "quadrangle", "contour"],
    "city_directory": ["city directory", "polk", "haines", "criss-cross", "directory listing"],
    "property_profile": ["property profile", "ownership history", "chain of title"],
    "public_record": ["building permit", "fire department", "inspection", "aqmd", "rwqcb",
                      "county record", "public record", "agency record"],
    "regulatory_correspondence": ["epa", "regulatory", "correspondence", "npdes", "rcra",
                                  "agency letter"],
    "title_record": ["title", "deed", "title search"],
    "tax_record": ["tax", "assessor", "parcel", "tax map"],
    "building_permit": ["building permit", "permit", "construction permit"],
    "lab_results": ["laboratory", "lab results", "analytical", "sample results"],
    "qualifications": ["qualifications", "resume", "curriculum vitae", "credentials",
                       "environmental professional"],
    "prior_environmental_report": ["phase i", "phase ii", "environmental site assessment",
                                   "esa report"],
    "fire_insurance_map": ["fire insurance"],
    "client_correspondence": ["dear", "re:", "letter", "memo"],
}

# Non-ODIC firms — if found, likely a reference report
NON_ODIC_FIRMS = [
    "terracon", "aecom", "arcadis", "golder", "tetra tech", "wsp",
    "ehs support", "partner engineering", "universal engineering",
    "kleinfelder", "geosyntec", "brown and caldwell", "ramboll",
    "stantec", "wood environment", "environmental resources management",
    "erm", "langan", "amec", "haley aldrich", "geotech",
    "ninyo & moore", "leighton", "converse", "scs engineers",
    "phase one", "vista environmental", "rey engineers",
]


def rule_based_classify(text: str, filename: str) -> dict:
    """Fallback classifier using keyword matching."""
    combined = (filename + " " + text[:5000]).lower()

    best_type = "other"
    best_score = 0

    for doc_type, keywords in KEYWORD_PATTERNS.items():
        score = sum(1 for kw in keywords if kw in combined)
        if score > best_score:
            best_score = score
            best_type = doc_type

    confidence = min(30 + best_score * 20, 75)

    # Check authorship
    is_reference = False
    author_firm = "unknown"
    for firm in NON_ODIC_FIRMS:
        if firm in combined:
            is_reference = True
            author_firm = firm.title()
            break

    if "odic" in combined:
        author_firm = "ODIC"
        is_reference = False

    # If it's a prior ESA from another firm, classify as reference_report
    if is_reference and best_type in ("prior_environmental_report", "write_up",
                                       "executive_summary"):
        best_type = "reference_report"

    reasoning = f"Rule-based: matched '{best_type}' keywords in filename/content"
    if is_reference:
        reasoning += f". Detected non-ODIC authorship: {author_firm}"

    return {
        "doc_type": best_type,
        "confidence": confidence,
        "reasoning": reasoning,
        "is_reference_report": is_reference,
        "author_firm": author_firm,
        "method": "rule_based",
    }


async def classify_document(
    router: LLMRouter,
    text: str,
    filename: str,
    project_name: str = "",
) -> dict:
    """Classify a document using LLM with rule-based fallback."""

    if router.available:
        prompt = (
            f"Filename: {filename}\n"
            f"Project: {project_name}\n\n"
            f"Document text (first 8000 chars):\n{text[:8000]}"
        )
        system = CLASSIFICATION_PROMPT.format(types=", ".join(DOCUMENT_TYPES))

        response = await router.complete(
            system, prompt, temperature=0.2, max_tokens=500, task_type="classify"
        )

        if response:
            try:
                json_match = re.search(r'\{[^{}]*\}', response, re.DOTALL)
                if json_match:
                    result = json.loads(json_match.group())
                    result["method"] = "llm"
                    if result.get("doc_type") not in DOCUMENT_TYPES:
                        result["doc_type"] = "other"
                    return result
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"LLM response parse failed: {e}")

    return rule_based_classify(text, filename)

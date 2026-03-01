"""
AI Verification Module

Provides intelligent verification of ESA reports:
1. Completeness checking - verifies all required sections present
2. Content summarization - generates summaries of each section
3. Confidence scoring - determines if human review needed
4. Auto-approval logic - skips human review when confidence high
"""

import logging
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, field
from enum import Enum

from utils.llm import get_reasoning_llm

logger = logging.getLogger(__name__)

# Auto-approval threshold - skip human review above this
AUTO_APPROVE_THRESHOLD = 0.95


class VerificationStatus(str, Enum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    MISSING = "missing"
    NEEDS_REVIEW = "needs_review"


@dataclass
class SectionVerification:
    """Verification result for a single section."""
    section_id: str
    section_name: str
    status: VerificationStatus
    found: bool
    required: bool
    confidence: float
    content_summary: str = ""
    page_range: Optional[Tuple[int, int]] = None
    issues: List[str] = field(default_factory=list)


@dataclass
class VerificationReport:
    """Complete verification report for an ESA document."""
    project_id: str
    report_type: str
    overall_status: VerificationStatus
    overall_confidence: float
    auto_approved: bool
    total_sections: int
    sections_found: int
    sections_missing: int
    section_verifications: List[SectionVerification]
    executive_summary: str
    recommendations: List[str]
    flags: List[str]


# Phase I ESA required sections per ASTM E1527-21
PHASE1_REQUIRED_SECTIONS = {
    "executive_summary": {"name": "Executive Summary", "required": True, "keywords": ["summary", "executive", "overview", "findings"]},
    "introduction": {"name": "1.0 Introduction", "required": True, "keywords": ["introduction", "purpose", "scope", "limitations"]},
    "site_description": {"name": "2.0 Site Description", "required": True, "keywords": ["site description", "location", "property", "address", "acreage"]},
    "user_provided_info": {"name": "3.0 User Provided Information", "required": True, "keywords": ["user provided", "owner", "questionnaire"]},
    "records_review": {"name": "4.0 Records Review", "required": True, "keywords": ["records review", "regulatory", "database", "edr"]},
    "historical_review": {"name": "5.0 Historical Review", "required": True, "keywords": ["historical", "sanborn", "aerial", "topographic", "city directory"]},
    "site_reconnaissance": {"name": "6.0 Site Reconnaissance", "required": True, "keywords": ["reconnaissance", "site visit", "inspection", "observation"]},
    "interviews": {"name": "7.0 Interviews", "required": False, "keywords": ["interview", "discussion", "contact"]},
    "findings": {"name": "8.0 Findings", "required": True, "keywords": ["findings", "recognized environmental conditions", "rec"]},
    "conclusions": {"name": "9.0 Conclusions", "required": True, "keywords": ["conclusion", "opinion"]},
    "recommendations": {"name": "10.0 Recommendations", "required": False, "keywords": ["recommendation", "further action"]},
    "qualifications": {"name": "11.0 Qualifications", "required": True, "keywords": ["qualification", "environmental professional", "credentials"]},
}

PHASE1_REQUIRED_APPENDICES = {
    "appendix_a": {"name": "Appendix A - Site Plans/Maps", "required": True, "keywords": ["site plan", "map", "figure", "location"]},
    "appendix_b": {"name": "Appendix B - Site Photographs", "required": True, "keywords": ["photograph", "photo", "image"]},
    "appendix_c": {"name": "Appendix C - Historical Sources", "required": True, "keywords": ["historical", "sanborn", "aerial", "topographic"]},
    "appendix_d": {"name": "Appendix D - Regulatory Records", "required": False, "keywords": ["regulatory", "correspondence", "agency"]},
    "appendix_e": {"name": "Appendix E - EDR Report", "required": True, "keywords": ["edr", "environmental data", "database report"]},
    "appendix_f": {"name": "Appendix F - Qualifications", "required": True, "keywords": ["qualification", "resume", "credentials", "certification"]},
}


async def verify_document_content(
    text_content: str,
    section_id: str,
    section_config: Dict[str, Any]
) -> SectionVerification:
    """
    Use AI to verify a section's content and generate summary.
    """
    llm = get_reasoning_llm()

    keywords = section_config.get("keywords", [])
    section_name = section_config.get("name", section_id)
    required = section_config.get("required", False)

    # Check for keyword presence first (fast check)
    keyword_matches = sum(1 for kw in keywords if kw.lower() in text_content.lower())
    keyword_confidence = keyword_matches / len(keywords) if keywords else 0.5

    if not text_content or len(text_content.strip()) < 50:
        return SectionVerification(
            section_id=section_id,
            section_name=section_name,
            status=VerificationStatus.MISSING,
            found=False,
            required=required,
            confidence=0.0,
            content_summary="Section not found or empty",
            issues=["Section content is missing or too short"]
        )

    # Use AI to analyze content and generate summary
    try:
        prompt = f"""Analyze this section from an Environmental Site Assessment (ESA) report.

Section: {section_name}
Expected content keywords: {', '.join(keywords)}

Content to analyze:
{text_content[:3000]}  # Limit to first 3000 chars for efficiency

Provide a JSON response with:
1. "found": true/false - Is this section present and substantive?
2. "confidence": 0.0-1.0 - How confident are you this is the correct section?
3. "summary": Brief 2-3 sentence summary of what's in this section
4. "complete": true/false - Does this section appear complete?
5. "issues": List of any concerns or missing elements

Respond only with valid JSON."""

        response = await llm.ainvoke(prompt)

        # Parse AI response
        import json
        try:
            # Extract JSON from response
            response_text = response.content if hasattr(response, 'content') else str(response)
            # Try to find JSON in the response
            start = response_text.find('{')
            end = response_text.rfind('}') + 1
            if start >= 0 and end > start:
                result = json.loads(response_text[start:end])
            else:
                raise ValueError("No JSON found")

            ai_confidence = float(result.get("confidence", 0.5))
            # Combine keyword and AI confidence
            combined_confidence = (keyword_confidence * 0.3) + (ai_confidence * 0.7)

            status = VerificationStatus.COMPLETE if result.get("complete", False) else VerificationStatus.PARTIAL
            if not result.get("found", False):
                status = VerificationStatus.MISSING
            elif combined_confidence < AUTO_APPROVE_THRESHOLD:
                status = VerificationStatus.NEEDS_REVIEW

            return SectionVerification(
                section_id=section_id,
                section_name=section_name,
                status=status,
                found=result.get("found", False),
                required=required,
                confidence=combined_confidence,
                content_summary=result.get("summary", ""),
                issues=result.get("issues", [])
            )
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning(f"Failed to parse AI response for {section_id}: {e}")

    except Exception as e:
        logger.error(f"AI verification failed for {section_id}: {e}")

    # Fallback to keyword-based verification
    found = keyword_confidence > 0.3
    return SectionVerification(
        section_id=section_id,
        section_name=section_name,
        status=VerificationStatus.COMPLETE if found else VerificationStatus.MISSING,
        found=found,
        required=required,
        confidence=keyword_confidence,
        content_summary="Verified by keyword matching (AI unavailable)",
        issues=[] if found else ["Section may be missing - manual review recommended"]
    )


async def generate_executive_summary(
    section_verifications: List[SectionVerification],
    project_address: str
) -> str:
    """
    Generate an AI summary of the verification results.
    """
    llm = get_reasoning_llm()

    sections_found = [s for s in section_verifications if s.found]
    sections_missing = [s for s in section_verifications if not s.found and s.required]

    summaries = "\n".join([
        f"- {s.section_name}: {s.content_summary}"
        for s in sections_found if s.content_summary
    ])

    try:
        prompt = f"""Generate a brief executive summary for an ESA report verification.

Property Address: {project_address}

Sections Found ({len(sections_found)}):
{summaries}

Required Sections Missing ({len(sections_missing)}):
{', '.join([s.section_name for s in sections_missing]) or 'None'}

Write a 3-4 sentence professional summary of what this ESA report contains and its completeness status."""

        response = await llm.ainvoke(prompt)
        return response.content if hasattr(response, 'content') else str(response)

    except Exception as e:
        logger.error(f"Failed to generate executive summary: {e}")
        return f"ESA report for {project_address} contains {len(sections_found)} sections. {len(sections_missing)} required sections may be missing."


async def verify_esa_report(
    extracted_sections: Dict[str, str],
    project_id: str,
    project_address: str,
    report_type: str = "phase_1"
) -> VerificationReport:
    """
    Perform full AI verification of an ESA report.

    Args:
        extracted_sections: Dict mapping section_id to extracted text content
        project_id: Project identifier
        project_address: Site address
        report_type: "phase_1" or "phase_2"

    Returns:
        Complete VerificationReport with all findings
    """
    logger.info(f"Starting AI verification for project {project_id}")

    # Get required sections based on report type
    if report_type == "phase_1":
        required_sections = {**PHASE1_REQUIRED_SECTIONS, **PHASE1_REQUIRED_APPENDICES}
    else:
        # Phase 2 would have additional sections
        required_sections = {**PHASE1_REQUIRED_SECTIONS, **PHASE1_REQUIRED_APPENDICES}

    section_verifications = []

    # Verify each section
    for section_id, section_config in required_sections.items():
        content = extracted_sections.get(section_id, "")
        verification = await verify_document_content(content, section_id, section_config)
        section_verifications.append(verification)

    # Calculate overall metrics
    total_sections = len(section_verifications)
    sections_found = sum(1 for s in section_verifications if s.found)
    sections_missing = sum(1 for s in section_verifications if not s.found and s.required)

    # Calculate overall confidence
    confidences = [s.confidence for s in section_verifications if s.required]
    overall_confidence = sum(confidences) / len(confidences) if confidences else 0.0

    # Determine overall status
    if sections_missing == 0 and overall_confidence >= AUTO_APPROVE_THRESHOLD:
        overall_status = VerificationStatus.COMPLETE
        auto_approved = True
    elif sections_missing == 0:
        overall_status = VerificationStatus.NEEDS_REVIEW
        auto_approved = False
    elif sections_missing <= 2:
        overall_status = VerificationStatus.PARTIAL
        auto_approved = False
    else:
        overall_status = VerificationStatus.MISSING
        auto_approved = False

    # Generate executive summary
    executive_summary = await generate_executive_summary(
        section_verifications,
        project_address
    )

    # Generate recommendations
    recommendations = []
    flags = []

    for s in section_verifications:
        if not s.found and s.required:
            recommendations.append(f"Add missing required section: {s.section_name}")
            flags.append(f"MISSING: {s.section_name}")
        elif s.status == VerificationStatus.NEEDS_REVIEW:
            recommendations.append(f"Review section for completeness: {s.section_name}")
        for issue in s.issues:
            if "missing" in issue.lower() or "incomplete" in issue.lower():
                flags.append(f"{s.section_name}: {issue}")

    if not recommendations:
        recommendations.append("Report appears complete - ready for final review")

    return VerificationReport(
        project_id=project_id,
        report_type=report_type,
        overall_status=overall_status,
        overall_confidence=overall_confidence,
        auto_approved=auto_approved,
        total_sections=total_sections,
        sections_found=sections_found,
        sections_missing=sections_missing,
        section_verifications=section_verifications,
        executive_summary=executive_summary,
        recommendations=recommendations,
        flags=flags
    )


def should_auto_approve(verification: VerificationReport) -> bool:
    """
    Determine if the report can be auto-approved without human review.
    """
    return (
        verification.auto_approved and
        verification.overall_confidence >= AUTO_APPROVE_THRESHOLD and
        verification.sections_missing == 0 and
        len(verification.flags) == 0
    )


def generate_verification_markdown(report: VerificationReport) -> str:
    """
    Generate a markdown report of the verification results.
    """
    status_emoji = {
        VerificationStatus.COMPLETE: "✅",
        VerificationStatus.PARTIAL: "⚠️",
        VerificationStatus.MISSING: "❌",
        VerificationStatus.NEEDS_REVIEW: "👀"
    }

    lines = [
        f"# ESA Report Verification",
        f"**Project ID:** {report.project_id}",
        f"**Report Type:** {report.report_type.replace('_', ' ').title()}",
        f"**Overall Status:** {status_emoji.get(report.overall_status, '?')} {report.overall_status.value.title()}",
        f"**Confidence Score:** {report.overall_confidence:.1%}",
        f"**Auto-Approved:** {'Yes ✅' if report.auto_approved else 'No - Human Review Required'}",
        "",
        "## Executive Summary",
        report.executive_summary,
        "",
        f"## Section Checklist ({report.sections_found}/{report.total_sections} found)",
        ""
    ]

    # Main sections
    lines.append("### Main Report Sections")
    for s in report.section_verifications:
        if not s.section_id.startswith("appendix"):
            emoji = status_emoji.get(s.status, "?")
            req = "*(required)*" if s.required else "*(optional)*"
            lines.append(f"- {emoji} **{s.section_name}** {req} - {s.confidence:.0%} confidence")
            if s.content_summary:
                lines.append(f"  - {s.content_summary}")

    # Appendices
    lines.append("")
    lines.append("### Appendices")
    for s in report.section_verifications:
        if s.section_id.startswith("appendix"):
            emoji = status_emoji.get(s.status, "?")
            req = "*(required)*" if s.required else "*(optional)*"
            lines.append(f"- {emoji} **{s.section_name}** {req} - {s.confidence:.0%} confidence")
            if s.content_summary:
                lines.append(f"  - {s.content_summary}")

    # Flags
    if report.flags:
        lines.extend(["", "## ⚠️ Flags Requiring Attention", ""])
        for flag in report.flags:
            lines.append(f"- {flag}")

    # Recommendations
    lines.extend(["", "## Recommendations", ""])
    for rec in report.recommendations:
        lines.append(f"- {rec}")

    return "\n".join(lines)

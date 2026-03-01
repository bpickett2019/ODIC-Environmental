"""
VERIFY Node

AI-powered verification that:
1. Checks completeness of all required sections
2. Generates content summaries for each section
3. Produces a verification report
4. Determines if human review is needed or auto-approval is safe
"""

import logging
from typing import Dict, Any
from datetime import datetime

from state import (
    ReportState,
    PipelineStage,
    log_action,
    create_decision,
    RiskLevel,
)
from utils.ai_verifier import (
    verify_esa_report,
    should_auto_approve,
    generate_verification_markdown,
    VerificationReport,
    VerificationStatus,
)
from utils.document_processor import extract_text_from_pdf

logger = logging.getLogger(__name__)


async def verify_node(state: ReportState) -> Dict[str, Any]:
    """
    VERIFY node - AI verification of the assembled report.

    This node:
    1. Extracts text from each classified document
    2. Runs AI verification on each section
    3. Generates a completeness report with summaries
    4. Determines if auto-approval is safe or human review needed

    If overall confidence >= 95% and no missing required sections,
    the report is auto-approved and skips human review steps.
    """
    logger.info(f"VERIFY: Starting AI verification for project {state['project_id']}")

    project_id = state["project_id"]
    project_address = state.get("project_address", "Unknown Address")
    report_type = state.get("report_type", "phase_1")

    classified_docs = state.get("classified_documents", [])
    if not classified_docs:
        logger.error("VERIFY: No classified documents to verify")
        return {
            "current_stage": PipelineStage.QC,
            "verification_complete": False,
            "errors": ["No classified documents available for verification"],
            "audit_log": [log_action("verify", "error", "No classified documents")],
        }

    # Extract text from each document and organize by section
    extracted_sections = {}

    for doc in classified_docs:
        try:
            # Get the classification
            classification = doc.classification
            if not classification:
                continue

            section_id = classification.section
            file_path = doc.file.file_path

            # Extract text
            text = extract_text_from_pdf(file_path)
            if text:
                if section_id in extracted_sections:
                    extracted_sections[section_id] += "\n\n" + text
                else:
                    extracted_sections[section_id] = text

        except Exception as e:
            logger.warning(f"Failed to extract text from {doc.file.filename}: {e}")

    # Run AI verification
    try:
        verification_report = await verify_esa_report(
            extracted_sections=extracted_sections,
            project_id=project_id,
            project_address=project_address,
            report_type=report_type
        )

        # Generate markdown report
        markdown_report = generate_verification_markdown(verification_report)

        # Determine if auto-approval is appropriate
        auto_approve = should_auto_approve(verification_report)

        logger.info(
            f"VERIFY: Completed - Status: {verification_report.overall_status.value}, "
            f"Confidence: {verification_report.overall_confidence:.1%}, "
            f"Auto-approved: {auto_approve}"
        )

        # Create AI decisions for tracking
        decisions = []

        # Overall verification decision
        overall_risk = RiskLevel.HIGH if verification_report.sections_missing > 0 else (
            RiskLevel.MEDIUM if verification_report.overall_confidence < 0.95 else RiskLevel.LOW
        )
        decisions.append(create_decision(
            stage="verify",
            action=f"Report verification: {verification_report.overall_status.value}",
            confidence=verification_report.overall_confidence,
            risk_level=overall_risk,
            reasoning=verification_report.executive_summary,
            details={
                "sections_found": verification_report.sections_found,
                "sections_missing": verification_report.sections_missing,
                "total_sections": verification_report.total_sections,
            }
        ))

        # Per-section decisions
        for s in verification_report.section_verifications:
            section_risk = RiskLevel.HIGH if (s.required and not s.found) else (
                RiskLevel.MEDIUM if s.confidence < 0.90 else RiskLevel.LOW
            )
            decisions.append(create_decision(
                stage="verify",
                action=f"Section '{s.section_name}': {'found' if s.found else 'missing'}",
                confidence=s.confidence,
                risk_level=section_risk,
                reasoning=s.content_summary or (f"Issues: {', '.join(s.issues)}" if s.issues else ""),
                details={
                    "section_id": s.section_id,
                    "required": s.required,
                    "status": s.status.value,
                }
            ))

        # Build result
        result = {
            "current_stage": PipelineStage.QC,
            "verification_complete": True,
            "verification_report": {
                "overall_status": verification_report.overall_status.value,
                "overall_confidence": verification_report.overall_confidence,
                "auto_approved": auto_approve,
                "sections_found": verification_report.sections_found,
                "sections_missing": verification_report.sections_missing,
                "total_sections": verification_report.total_sections,
                "executive_summary": verification_report.executive_summary,
                "recommendations": verification_report.recommendations,
                "flags": verification_report.flags,
                "section_details": [
                    {
                        "section_id": s.section_id,
                        "section_name": s.section_name,
                        "status": s.status.value,
                        "found": s.found,
                        "required": s.required,
                        "confidence": s.confidence,
                        "summary": s.content_summary,
                        "issues": s.issues,
                    }
                    for s in verification_report.section_verifications
                ],
                "markdown_report": markdown_report,
            },
            "decisions": decisions,
            "audit_log": [log_action(
                "verify",
                "success",
                f"AI verification complete: {verification_report.overall_status.value} "
                f"({verification_report.overall_confidence:.1%} confidence)"
            )],
        }

        # If auto-approved, skip human review flags
        if auto_approve:
            result["classification_complete"] = True
            result["structure_complete"] = True
            result["appendix_order_confirmed"] = True
            result["awaiting_human_input"] = False
            result["human_input_type"] = None
            logger.info("VERIFY: Auto-approved - skipping human review steps")
        else:
            # Flag for human review if needed
            if verification_report.sections_missing > 0:
                result["awaiting_human_input"] = True
                result["human_input_type"] = "verification_review"
                result["human_input_data"] = {
                    "type": "verification_review",
                    "report": verification_report.__dict__,
                    "markdown": markdown_report,
                    "missing_sections": [
                        s.section_name
                        for s in verification_report.section_verifications
                        if not s.found and s.required
                    ],
                }

        return result

    except Exception as e:
        logger.error(f"VERIFY: AI verification failed: {e}")
        return {
            "current_stage": PipelineStage.QC,
            "verification_complete": False,
            "errors": [f"AI verification failed: {str(e)}"],
            "audit_log": [log_action("verify", "error", str(e))],
            # Don't block the pipeline - continue to QC
            "classification_complete": True,
            "structure_complete": True,
        }


def apply_verification_overrides(state: ReportState, overrides: Dict[str, Any]) -> Dict[str, Any]:
    """
    Apply human overrides to verification results.

    Called when human reviews the verification report and makes changes.
    """
    logger.info("Applying human verification overrides")

    result = {
        "verification_overrides": overrides,
        "awaiting_human_input": False,
        "human_input_type": None,
        "human_input_data": {},
    }

    # If human approves despite issues
    if overrides.get("approve_anyway", False):
        result["classification_complete"] = True
        result["structure_complete"] = True
        result["appendix_order_confirmed"] = True

    # If human marks sections as present that AI missed
    if "section_overrides" in overrides:
        verification_report = state.get("verification_report", {})
        for section_id, override in overrides["section_overrides"].items():
            # Update the verification report with human corrections
            pass

    result["audit_log"] = [log_action(
        "verify",
        "human_override",
        f"Human reviewed verification report: {overrides}"
    )]

    return result

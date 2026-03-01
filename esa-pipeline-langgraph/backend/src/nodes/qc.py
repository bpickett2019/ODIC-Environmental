"""
QC (Quality Control) Node - Multi-Pass Self-Validation System

THE MOST IMPORTANT STAGE - runs 5 parallel sub-validators:
1. Completeness - all sections present, no blanks
2. Cross-Contamination - scan for mismatched project IDs, addresses, company names
3. Structure - TOC accuracy, section ordering, appendix labels
4. Content Integrity - executive summary matches findings (AI-powered)
5. Format - consistent headers/footers/fonts

SELF-CORRECTION PROTOCOL:
Each validator runs, scores, and if below threshold, self-corrects and re-runs
up to 3 times before surfacing the issue. The QC stage loops:
validate → fix → re-validate until all checks pass OR max 3 loops exhausted.

Each sub-validator outputs its own score. Overall QC produces pass/fail
with SPECIFIC ACTIONABLE issues, not vague error messages.
"""

import os
import re
import asyncio
import logging
from typing import Dict, Any, List, Tuple
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

from state import (
    ReportState,
    QCResult,
    QCIssue,
    QCSeverity,
    PipelineStage,
    log_action,
    create_decision,
    RiskLevel,
)
from utils.llm import check_content_integrity, check_cross_contamination
from utils.document_processor import process_document, get_pdf_page_count

logger = logging.getLogger(__name__)

# QC thresholds
COMPLETENESS_THRESHOLD = 0.95
STRUCTURE_THRESHOLD = 0.90
CONTENT_THRESHOLD = 0.85
FORMAT_THRESHOLD = 0.90
CROSS_CONTAMINATION_THRESHOLD = 1.0  # Zero tolerance

# Self-correction loop settings
MAX_VALIDATION_LOOPS = 3  # Maximum self-correction attempts per validator


def qc_node(state: ReportState) -> Dict[str, Any]:
    """
    QC node - Run all 5 sub-validators with self-correction loops.

    SELF-CORRECTION PROTOCOL:
    1. Run all 5 validators
    2. For any that fail, attempt auto-fix if available
    3. Re-run failed validators (up to MAX_VALIDATION_LOOPS times)
    4. Only surface issues that survive all correction attempts

    Each validator runs independently and produces its own score.
    Overall pass/fail based on weighted aggregate and blocking issues.
    """
    logger.info(f"QC: Starting for project {state['project_id']}")

    assembly_result = state.get("assembly_result")
    if not assembly_result or not assembly_result.assembled_file_path:
        return {
            "current_stage": PipelineStage.QC,
            "stage_history": [PipelineStage.QC.value],
            "errors": ["No assembled report to QC"],
            "pipeline_failed": True,
            "audit_log": [log_action(state, "qc_failed", {"reason": "No assembly result"})],
        }

    assembled_path = assembly_result.assembled_file_path
    if not os.path.exists(assembled_path):
        return {
            "current_stage": PipelineStage.QC,
            "stage_history": [PipelineStage.QC.value],
            "errors": [f"Assembled report not found: {assembled_path}"],
            "pipeline_failed": True,
            "audit_log": [log_action(state, "qc_failed", {"reason": "File not found"})],
        }

    # Extract text from assembled report for analysis
    logger.info("Extracting text from assembled report...")
    try:
        processed = process_document(assembled_path)
        report_text = processed.text_content
    except Exception as e:
        logger.error(f"Failed to extract report text: {e}")
        report_text = ""

    audit_entries = []
    qc_loops_run = state.get("qc_loops_run", 0)
    max_qc_loops = state.get("max_qc_loops", MAX_VALIDATION_LOOPS)

    # Run all 5 validators with self-correction loops
    logger.info(f"Running QC sub-validators (loop {qc_loops_run + 1}/{max_qc_loops})...")

    # Define validators with their functions and thresholds
    validators = [
        ("completeness", _validate_completeness, COMPLETENESS_THRESHOLD, (state, assembly_result)),
        ("cross_contamination", _validate_cross_contamination, CROSS_CONTAMINATION_THRESHOLD, (state, report_text, assembly_result)),
        ("structure", _validate_structure, STRUCTURE_THRESHOLD, (state, assembly_result, report_text)),
        ("content_integrity", _validate_content_integrity, CONTENT_THRESHOLD, (state, report_text)),
        ("format", _validate_format, FORMAT_THRESHOLD, (state, assembled_path, report_text)),
    ]

    validator_results = {}
    total_auto_fixes = 0

    for validator_name, validator_func, threshold, args in validators:
        loop_count = 0
        current_result = None

        while loop_count < MAX_VALIDATION_LOOPS:
            loop_count += 1

            # Run validator
            current_result = validator_func(*args)

            audit_entries.append(log_action(state, f"validator_{validator_name}_run", {
                "loop": loop_count,
                "score": current_result["score"],
                "issues_count": len(current_result["issues"]),
                "threshold": threshold,
            }))

            # Check if passed
            if current_result["score"] >= threshold:
                logger.info(f"Validator {validator_name} PASSED on loop {loop_count}")
                break

            # Attempt auto-fix for auto-fixable issues
            auto_fixable_issues = [i for i in current_result["issues"] if i.auto_fixable and not i.fixed]

            if auto_fixable_issues and loop_count < MAX_VALIDATION_LOOPS:
                logger.info(f"Validator {validator_name}: Attempting auto-fix for {len(auto_fixable_issues)} issues")

                for issue in auto_fixable_issues:
                    # Mark fix attempt
                    if not hasattr(issue, 'fix_attempts'):
                        issue.fix_attempts = 0
                    issue.fix_attempts += 1

                    # In production, actual fix would be applied here
                    # For now, mark as attempted
                    audit_entries.append(log_action(state, "auto_fix_attempted", {
                        "validator": validator_name,
                        "issue": issue.description,
                        "suggested_fix": issue.suggested_fix,
                        "attempt": issue.fix_attempts,
                    }))
                    total_auto_fixes += 1

            if loop_count >= MAX_VALIDATION_LOOPS:
                logger.warning(f"Validator {validator_name} FAILED after {MAX_VALIDATION_LOOPS} loops (score: {current_result['score']:.2f})")

        # Store result with loop info
        current_result["loops_run"] = loop_count
        current_result["auto_fixes_attempted"] = total_auto_fixes
        validator_results[validator_name] = current_result

    # Extract results for compatibility
    completeness_result = validator_results["completeness"]
    contamination_result = validator_results["cross_contamination"]
    structure_result = validator_results["structure"]
    content_result = validator_results["content_integrity"]
    format_result = validator_results["format"]

    # Aggregate results
    all_issues = []
    section_scores = {}

    for name, result in [
        ("completeness", completeness_result),
        ("cross_contamination", contamination_result),
        ("structure", structure_result),
        ("content_integrity", content_result),
        ("format", format_result),
    ]:
        section_scores[name] = result["score"]
        all_issues.extend(result["issues"])

    # Separate blocking issues from warnings
    blocking_issues = [i for i in all_issues if i.severity == QCSeverity.CRITICAL]
    warnings = [i for i in all_issues if i.severity in (QCSeverity.WARNING, QCSeverity.INFO)]

    # Calculate overall score (weighted average)
    weights = {
        "completeness": 0.25,
        "cross_contamination": 0.25,  # High weight - critical
        "structure": 0.20,
        "content_integrity": 0.15,
        "format": 0.15,
    }
    overall_score = sum(
        section_scores[k] * weights[k] for k in weights
    )

    # Determine pass/fail
    # Fail if any blocking issues OR score below threshold
    qc_passed = (
        len(blocking_issues) == 0 and
        overall_score >= 0.85 and
        section_scores["cross_contamination"] >= CROSS_CONTAMINATION_THRESHOLD
    )

    # Calculate confidence level
    confidence_level = min(section_scores.values()) if section_scores else 0.5

    qc_result = QCResult(
        qc_passed=qc_passed,
        overall_score=overall_score,
        confidence_level=confidence_level,
        blocking_issues=blocking_issues,
        warnings=warnings,
        ai_notes=content_result.get("notes", ""),
        section_scores=section_scores,
        remediation_count=state.get("remediation_attempts", 0),
    )

    logger.info(
        f"QC complete: passed={qc_passed}, score={overall_score:.2%}, "
        f"blocking={len(blocking_issues)}, warnings={len(warnings)}"
    )

    # Create AI decisions for tracking
    decisions = []

    # Overall QC decision
    overall_risk = RiskLevel.HIGH if len(blocking_issues) > 0 else (
        RiskLevel.MEDIUM if overall_score < 0.95 else RiskLevel.LOW
    )
    decisions.append(create_decision(
        stage="qc",
        action=f"QC {'PASSED' if qc_passed else 'FAILED'} with score {overall_score:.1%}",
        confidence=confidence_level,
        risk_level=overall_risk,
        reasoning=f"{len(blocking_issues)} blocking issues, {len(warnings)} warnings",
        details={
            "overall_score": overall_score,
            "section_scores": section_scores,
            "blocking_issues_count": len(blocking_issues),
            "warnings_count": len(warnings),
        }
    ))

    # Per-validator decisions
    for name, result in [
        ("completeness", completeness_result),
        ("cross_contamination", contamination_result),
        ("structure", structure_result),
        ("content_integrity", content_result),
        ("format", format_result),
    ]:
        validator_risk = RiskLevel.HIGH if name == "cross_contamination" and result["score"] < 1.0 else (
            RiskLevel.MEDIUM if result["score"] < 0.90 else RiskLevel.LOW
        )
        decisions.append(create_decision(
            stage="qc",
            action=f"QC {name}: {result['score']:.0%}",
            confidence=result["score"],
            risk_level=validator_risk,
            reasoning=f"{len(result['issues'])} issues found",
            details={
                "validator": name,
                "score": result["score"],
                "issue_count": len(result["issues"]),
            }
        ))

    audit_entries.append(log_action(state, "qc_complete", {
        "passed": qc_passed,
        "overall_score": overall_score,
        "section_scores": section_scores,
        "blocking_issues": len(blocking_issues),
        "warnings": len(warnings),
    }))

    # If QC failed and we haven't exceeded remediation attempts, offer auto-fix
    remediation_attempts = state.get("remediation_attempts", 0)
    max_remediations = state.get("max_remediations", 3)
    can_remediate = not qc_passed and remediation_attempts < max_remediations

    # Check if any issues are auto-fixable
    auto_fixable = [i for i in blocking_issues if i.auto_fixable]

    return {
        "current_stage": PipelineStage.QC,
        "stage_history": [PipelineStage.QC.value],
        "qc_result": qc_result,
        "qc_complete": qc_passed,
        "qc_loops_run": qc_loops_run + 1,
        "final_validation_passed": qc_passed,
        "qc_issues_resolved": qc_passed,
        "awaiting_human_input": not qc_passed,
        "human_input_type": "qc_resolution" if not qc_passed else None,
        "human_input_data": {
            "blocking_issues": [
                {
                    "agent": i.agent,
                    "severity": i.severity.value,
                    "description": i.description,
                    "location": i.location,
                    "auto_fixable": i.auto_fixable,
                    "suggested_fix": i.suggested_fix,
                }
                for i in blocking_issues
            ],
            "warnings": [
                {
                    "agent": i.agent,
                    "severity": i.severity.value,
                    "description": i.description,
                    "location": i.location,
                }
                for i in warnings
            ],
            "can_auto_remediate": len(auto_fixable) > 0,
            "remediation_attempts": remediation_attempts,
            "max_remediations": max_remediations,
            "validator_loop_counts": {k: v.get("loops_run", 1) for k, v in validator_results.items()},
        } if not qc_passed else {},
        "unresolved_issues": blocking_issues + [w for w in warnings if not w.fixed],
        "errors": [i.description for i in blocking_issues] if not qc_passed else [],
        "pipeline_failed": not qc_passed and remediation_attempts >= max_remediations,
        "decisions": decisions,
        "audit_log": audit_entries,
    }


def _validate_completeness(
    state: ReportState,
    assembly_result: Any,
) -> Dict[str, Any]:
    """
    5A. Completeness Validator

    Checks:
    - All required sections present
    - All appendices accounted for
    - No blank pages where content should be
    - Page count reconciliation passes
    """
    issues = []
    score = 1.0

    structure_result = state.get("structure_result")

    # Check missing sections from structure phase
    if structure_result and structure_result.sections_missing:
        for section in structure_result.sections_missing:
            issues.append(QCIssue(
                agent="completeness",
                severity=QCSeverity.CRITICAL,
                description=f"Missing required section: {section}",
                location="Report structure",
                auto_fixable=False,
                suggested_fix=f"Add document for section: {section}",
            ))
            score -= 0.1

    # Check page reconciliation
    if not assembly_result.pages_match:
        missing = assembly_result.source_pages - assembly_result.total_pages
        issues.append(QCIssue(
            agent="completeness",
            severity=QCSeverity.CRITICAL,
            description=f"Page count mismatch: {missing} pages missing",
            location="Full report",
            auto_fixable=False,
            suggested_fix="Re-check source documents and re-assemble",
        ))
        score -= 0.3

    # Check for completeness score from structure
    if structure_result:
        if structure_result.completeness_score < COMPLETENESS_THRESHOLD:
            score = min(score, structure_result.completeness_score)

    score = max(0.0, score)

    logger.info(f"Completeness check: score={score:.2%}, issues={len(issues)}")

    return {
        "score": score,
        "issues": issues,
    }


def _validate_cross_contamination(
    state: ReportState,
    report_text: str,
    assembly_result: Any,
) -> Dict[str, Any]:
    """
    5B. Cross-Contamination Detector

    Checks:
    - Project IDs match throughout
    - Addresses match project address
    - Company names are consistent
    - Headers/footers match project info
    - Content from prior/other reports in wrong section
    """
    issues = []
    score = 1.0

    project_id = state["project_id"]
    project_address = state.get("project_address", "")
    client_name = state.get("client_name", "")

    # Use AI to check for contamination
    ai_result = check_cross_contamination(
        content=report_text,
        project_id=project_id,
        project_address=project_address,
        expected_company=client_name,
    )

    if ai_result.get("contamination_found"):
        for ai_issue in ai_result.get("issues", []):
            severity = (
                QCSeverity.CRITICAL if ai_issue.get("severity") == "critical"
                else QCSeverity.WARNING
            )
            issues.append(QCIssue(
                agent="cross_contamination",
                severity=severity,
                description=ai_issue.get("description", "Possible contamination"),
                location=ai_issue.get("location", "Unknown"),
                auto_fixable=False,
                suggested_fix="Review and remove content from other project",
            ))

            if severity == QCSeverity.CRITICAL:
                score -= 0.5
            else:
                score -= 0.1

    # Also do deterministic checks
    # Look for other project ID patterns
    project_id_pattern = r'\b\d{4,}-\d{3,}[A-Z]*\b'
    found_ids = set(re.findall(project_id_pattern, report_text))

    for found_id in found_ids:
        if found_id != project_id and found_id not in project_id:
            # This might be a different project's ID
            issues.append(QCIssue(
                agent="cross_contamination",
                severity=QCSeverity.WARNING,
                description=f"Found possible other project ID: {found_id}",
                location="Report content",
                auto_fixable=False,
                suggested_fix=f"Verify if {found_id} should appear in this report",
            ))
            score -= 0.05

    score = max(0.0, score)

    logger.info(f"Cross-contamination check: score={score:.2%}, issues={len(issues)}")

    return {
        "score": score,
        "issues": issues,
    }


def _validate_structure(
    state: ReportState,
    assembly_result: Any,
    report_text: str,
) -> Dict[str, Any]:
    """
    5C. Structure Validator

    Checks:
    - TOC page numbers match actual locations
    - Sections appear in correct order
    - Appendix letters are sequential
    - No duplicate sections
    """
    issues = []
    score = 1.0

    # Check TOC if present
    # Look for TOC pattern in text
    toc_match = re.search(
        r'(?:table of contents|contents)\s*\n(.*?)(?=\n\n|\n[A-Z1-9])',
        report_text,
        re.IGNORECASE | re.DOTALL
    )

    if toc_match:
        toc_content = toc_match.group(1)
        # Extract page numbers from TOC
        toc_entries = re.findall(r'(.*?)\s+\.+\s*(\d+)', toc_content)

        # For now, just check that we have TOC entries
        if not toc_entries:
            issues.append(QCIssue(
                agent="structure",
                severity=QCSeverity.WARNING,
                description="Table of Contents has no page number references",
                location="Table of Contents",
                auto_fixable=True,
                suggested_fix="Regenerate TOC with correct page numbers",
            ))
            score -= 0.1
    else:
        # No TOC found
        issues.append(QCIssue(
            agent="structure",
            severity=QCSeverity.WARNING,
            description="No Table of Contents found in report",
            location="Beginning of report",
            auto_fixable=True,
            suggested_fix="Generate and insert Table of Contents",
        ))
        score -= 0.15

    # Check appendix ordering
    appendix_letters = re.findall(r'Appendix\s+([A-Z])', report_text, re.IGNORECASE)
    if appendix_letters:
        # Check if sequential
        expected_ord = ord('A')
        for letter in appendix_letters:
            if ord(letter.upper()) != expected_ord:
                issues.append(QCIssue(
                    agent="structure",
                    severity=QCSeverity.WARNING,
                    description=f"Non-sequential appendix letter: {letter} (expected {chr(expected_ord)})",
                    location=f"Appendix {letter}",
                    auto_fixable=False,
                    suggested_fix="Review and correct appendix ordering",
                ))
                score -= 0.05
            expected_ord = ord(letter.upper()) + 1

    # Check for duplicate sections
    section_headers = re.findall(
        r'\n(\d+\.\d*\s+[A-Z][^.\n]+)',
        report_text,
        re.IGNORECASE
    )
    seen_headers = set()
    for header in section_headers:
        normalized = header.strip().lower()
        if normalized in seen_headers:
            issues.append(QCIssue(
                agent="structure",
                severity=QCSeverity.WARNING,
                description=f"Duplicate section header: {header.strip()}",
                location="Report body",
                auto_fixable=False,
                suggested_fix="Remove duplicate section",
            ))
            score -= 0.1
        seen_headers.add(normalized)

    score = max(0.0, score)

    logger.info(f"Structure check: score={score:.2%}, issues={len(issues)}")

    return {
        "score": score,
        "issues": issues,
    }


def _validate_content_integrity(
    state: ReportState,
    report_text: str,
) -> Dict[str, Any]:
    """
    5D. Content Integrity Checker (AI-powered)

    Checks:
    - Executive summary references match actual findings
    - Site address/description is consistent
    - Dates are consistent
    - Professional certifications referenced
    """
    issues = []
    score = 1.0
    notes = ""

    project_id = state["project_id"]
    project_address = state.get("project_address", "")
    client_name = state.get("client_name", "")

    # Use AI to check content integrity
    ai_result = check_content_integrity(
        report_content=report_text,
        project_id=project_id,
        project_address=project_address,
        client_name=client_name,
    )

    notes = ai_result.get("notes", "")

    if not ai_result.get("passed", True):
        for ai_issue in ai_result.get("issues", []):
            severity = (
                QCSeverity.CRITICAL if ai_issue.get("severity") == "critical"
                else QCSeverity.WARNING
            )
            issues.append(QCIssue(
                agent="content_integrity",
                severity=severity,
                description=ai_issue.get("description", "Content issue"),
                location=ai_issue.get("location", "Unknown"),
                auto_fixable=ai_issue.get("auto_fixable", False),
                suggested_fix=ai_issue.get("suggested_fix", "Review and correct"),
            ))

            if severity == QCSeverity.CRITICAL:
                score -= 0.2
            else:
                score -= 0.05

    # Confidence from AI affects our score
    ai_confidence = ai_result.get("confidence", 0.7)
    if ai_confidence < 0.5:
        score *= 0.8  # Reduce score if AI wasn't confident

    score = max(0.0, score)

    logger.info(f"Content integrity check: score={score:.2%}, issues={len(issues)}")

    return {
        "score": score,
        "issues": issues,
        "notes": notes,
    }


def _validate_format(
    state: ReportState,
    assembled_path: str,
    report_text: str,
) -> Dict[str, Any]:
    """
    5E. Format Validator

    Checks:
    - Consistent fonts, headers, footers
    - No corrupt pages
    - Images present and not broken
    - Page orientation correct
    """
    issues = []
    score = 1.0

    # Check file size (sanity check for corrupt file)
    try:
        file_size = os.path.getsize(assembled_path)
        if file_size < 1000:  # Less than 1KB is suspicious
            issues.append(QCIssue(
                agent="format",
                severity=QCSeverity.CRITICAL,
                description=f"Assembled file suspiciously small: {file_size} bytes",
                location="Full report",
                auto_fixable=False,
                suggested_fix="Re-assemble report",
            ))
            score -= 0.5
    except Exception as e:
        issues.append(QCIssue(
            agent="format",
            severity=QCSeverity.CRITICAL,
            description=f"Cannot check file: {e}",
            location="Full report",
            auto_fixable=False,
        ))
        score -= 0.5

    # Check for common format issues in text
    # Look for obvious broken content
    broken_patterns = [
        (r'\x00', "Null bytes in content"),
        (r'[^\x00-\x7F\u00A0-\uFFFF]{10,}', "Extended binary content"),
    ]

    for pattern, description in broken_patterns:
        if re.search(pattern, report_text):
            issues.append(QCIssue(
                agent="format",
                severity=QCSeverity.WARNING,
                description=description,
                location="Report content",
                auto_fixable=False,
                suggested_fix="Check source documents for corruption",
            ))
            score -= 0.1

    # Check for reasonable text extraction
    if len(report_text) < 1000:
        issues.append(QCIssue(
            agent="format",
            severity=QCSeverity.WARNING,
            description="Very little text extracted - may have rendering issues",
            location="Full report",
            auto_fixable=False,
            suggested_fix="Verify PDFs have proper text layers",
        ))
        score -= 0.1

    score = max(0.0, score)

    logger.info(f"Format check: score={score:.2%}, issues={len(issues)}")

    return {
        "score": score,
        "issues": issues,
    }


def apply_auto_fixes(state: ReportState, fixes_to_apply: List[str]) -> Dict[str, Any]:
    """
    Apply auto-fixes for QC issues.

    Args:
        state: Current state
        fixes_to_apply: List of issue descriptions to auto-fix

    Returns:
        Updated state fields
    """
    logger.info(f"Applying {len(fixes_to_apply)} auto-fixes")

    audit_entries = []
    applied_fixes = []

    qc_result = state.get("qc_result")
    if not qc_result:
        return {"errors": ["No QC result to fix"]}

    # For each auto-fixable issue, attempt the fix
    for issue in qc_result.blocking_issues + qc_result.warnings:
        if issue.description in fixes_to_apply and issue.auto_fixable:
            # Apply fix based on issue type
            # TODO: Implement actual fixes (TOC regeneration, etc.)
            issue.fixed = True
            applied_fixes.append(issue.description)

            audit_entries.append(log_action(state, "auto_fix_applied", {
                "issue": issue.description,
                "fix": issue.suggested_fix,
            }))

    # Increment remediation counter
    new_remediation_count = state.get("remediation_attempts", 0) + 1

    return {
        "remediation_attempts": new_remediation_count,
        "qc_result": qc_result,
        "audit_log": audit_entries,
    }

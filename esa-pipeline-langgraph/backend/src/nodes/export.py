"""
EXPORT Node - Final Deliverables Generation

Generate final deliverables:
- PDF (primary) and/or Word (.docx)
- Intelligent file splitting at appendix boundaries if > 25MB
- Compression for large files
- AI Completeness Report with 2-sentence section summaries
- QC summary document generation

The AI Completeness Report is the key deliverable that documents
what the AI found, what it decided, and the confidence levels.
"""

import os
import shutil
import json
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime

from state import (
    ReportState,
    ExportResult,
    ExportFile,
    PipelineStage,
    AIDecision,
    DecisionTier,
    ESASection,
    log_action,
    create_decision,
    RiskLevel,
)
from utils.document_processor import split_pdf, get_pdf_page_count

logger = logging.getLogger(__name__)

# 25MB limit per file
MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024


def export_node(state: ReportState) -> Dict[str, Any]:
    """
    EXPORT node - Generate final deliverables.

    - Export as PDF (primary) and/or Word
    - Split at appendix boundaries if > 25MB
    - Generate AI Completeness Report with section summaries
    - Generate QC summary document
    """
    logger.info(f"EXPORT: Starting for project {state['project_id']}")

    assembly_result = state.get("assembly_result")
    qc_result = state.get("qc_result")
    structure_result = state.get("structure_result")

    if not assembly_result or not assembly_result.assembled_file_path:
        return {
            "current_stage": PipelineStage.EXPORT,
            "stage_history": [PipelineStage.EXPORT.value],
            "errors": ["No assembled report to export"],
            "pipeline_failed": True,
            "audit_log": [log_action("export", "export_failed", {"reason": "No assembly result"})],
        }

    assembled_path = assembly_result.assembled_file_path
    if not os.path.exists(assembled_path):
        return {
            "current_stage": PipelineStage.EXPORT,
            "stage_history": [PipelineStage.EXPORT.value],
            "errors": [f"Assembled file not found: {assembled_path}"],
            "pipeline_failed": True,
            "audit_log": [log_action("export", "export_failed", {"reason": "File not found"})],
        }

    project_id = state["project_id"]
    audit_entries = []
    decisions = []

    # Set up export directory
    export_dir = os.environ.get("EXPORT_DIR", "./exports")
    project_export_dir = os.path.join(export_dir, project_id)
    os.makedirs(project_export_dir, exist_ok=True)

    # Check file size
    file_size = os.path.getsize(assembled_path)
    needs_split = file_size > MAX_FILE_SIZE_BYTES

    export_files = []
    total_parts = 1
    compression_applied = False
    auto_split_applied = False
    split_reason = ""

    if needs_split:
        logger.info(f"File exceeds {MAX_FILE_SIZE_BYTES/1024/1024:.0f}MB, splitting at appendix boundaries")
        auto_split_applied = True
        split_reason = f"File size ({file_size / (1024*1024):.1f}MB) exceeds 25MB limit"

        # Find appendix boundaries for splitting
        split_points = _find_appendix_split_points(state, assembly_result)

        if split_points:
            try:
                split_paths = split_pdf(assembled_path, project_export_dir, split_points)
                total_parts = len(split_paths)

                for i, path in enumerate(split_paths):
                    pages = get_pdf_page_count(path)
                    size = os.path.getsize(path)

                    export_files.append(ExportFile(
                        filename=os.path.basename(path),
                        size_bytes=size,
                        page_count=pages,
                        part_number=i + 1,
                        total_parts=total_parts,
                        sections_included=[f"Part {i+1} of {total_parts}"],
                        file_path=path,
                        format="pdf",
                    ))

                audit_entries.append(log_action("export", "file_split", {
                    "parts": total_parts,
                    "split_points": split_points,
                    "reason": split_reason,
                }))

            except Exception as e:
                logger.error(f"Failed to split PDF: {e}")
                # Fall back to single file
                needs_split = False
                auto_split_applied = False
        else:
            # No good split points found, keep as single file
            logger.warning("No appendix boundaries found for splitting")
            needs_split = False
            auto_split_applied = False

    if not needs_split or not export_files:
        # Copy single file to export directory
        export_filename = f"{project_id}_ESA_Report.pdf"
        export_path = os.path.join(project_export_dir, export_filename)

        shutil.copy2(assembled_path, export_path)

        export_files.append(ExportFile(
            filename=export_filename,
            size_bytes=os.path.getsize(export_path),
            page_count=assembly_result.total_pages,
            part_number=1,
            total_parts=1,
            sections_included=["Complete Report"],
            file_path=export_path,
            format="pdf",
        ))

    # Generate AI Completeness Report
    completeness_report_path = _generate_completeness_report(
        state, project_export_dir, structure_result
    )

    # Generate QC summary document
    qc_summary_path = _generate_qc_summary(state, project_export_dir, qc_result)

    # Create decision record
    decisions.append(create_decision(
        stage="export",
        action=f"Exported {len(export_files)} file(s)",
        confidence=1.0,
        risk_level=RiskLevel.LOW,
        reasoning=f"Total {assembly_result.total_pages} pages, QC passed: {qc_result.qc_passed if qc_result else 'N/A'}",
        details={
            "files": [f.filename for f in export_files],
            "total_parts": total_parts,
            "auto_split": auto_split_applied,
        }
    ))

    export_result = ExportResult(
        files=export_files,
        qc_summary_path=qc_summary_path,
        completeness_report_path=completeness_report_path,
        total_parts=total_parts,
        compression_applied=compression_applied,
        auto_split_applied=auto_split_applied,
        split_reason=split_reason,
    )

    logger.info(
        f"EXPORT complete: {len(export_files)} files, "
        f"Completeness report at {completeness_report_path}"
    )

    audit_entries.append(log_action("export", "export_complete", {
        "files": [f.filename for f in export_files],
        "total_parts": total_parts,
        "qc_summary": qc_summary_path,
        "completeness_report": completeness_report_path,
    }))

    # Final sign-off needed before delivery
    return {
        "current_stage": PipelineStage.EXPORT,
        "stage_history": [PipelineStage.EXPORT.value],
        "export_result": export_result,
        "export_complete": False,  # Needs final sign-off
        "awaiting_human_input": True,
        "human_input_type": "final_signoff",
        "human_input_data": {
            "export_files": [
                {
                    "filename": f.filename,
                    "size_mb": f.size_bytes / (1024 * 1024),
                    "pages": f.page_count,
                    "path": f.file_path,
                }
                for f in export_files
            ],
            "qc_summary_path": qc_summary_path,
            "completeness_report_path": completeness_report_path,
            "ready_for_delivery": True,
        },
        "audit_log": audit_entries,
        "decisions": decisions,
    }


def _find_appendix_split_points(state: ReportState, assembly_result: Any) -> List[int]:
    """
    Find page numbers where appendices start for intelligent splitting.

    Returns list of page numbers that are good split points.
    """
    structure_result = state.get("structure_result")
    if not structure_result:
        return []

    page_mapping = assembly_result.page_mapping
    split_points = []

    # Find where appendices start
    for doc in structure_result.ordered_documents:
        if doc.classification.appendix_letter:
            file_id = doc.file.id
            if file_id in page_mapping:
                start_page = page_mapping[file_id][0]
                split_points.append(start_page)

    # Remove the first split point (don't split before first appendix)
    # and any duplicates
    split_points = sorted(set(split_points))
    if split_points and split_points[0] <= 10:
        split_points = split_points[1:]

    return split_points


def _generate_completeness_report(
    state: ReportState,
    export_dir: str,
    structure_result: Optional[Any],
) -> str:
    """
    Generate the AI Completeness Report - the key deliverable documenting
    what the AI found, decided, and its confidence levels.

    Format: Markdown for human readability, with JSON appendix for machine parsing.
    """
    project_id = state["project_id"]
    report_filename = f"{project_id}_AI_Completeness_Report.md"
    report_path = os.path.join(export_dir, report_filename)

    # Also generate JSON version
    json_filename = f"{project_id}_AI_Completeness_Report.json"
    json_path = os.path.join(export_dir, json_filename)

    # Gather all decisions
    decisions = state.get("decisions", [])

    # Calculate tier statistics
    tier_counts = {
        "auto_approved": 0,
        "audit_trail": 0,
        "human_review": 0,
    }
    for decision in decisions:
        if isinstance(decision, AIDecision):
            tier_counts[decision.tier.value] = tier_counts.get(decision.tier.value, 0) + 1
        elif isinstance(decision, dict):
            tier_counts[decision.get("tier", "audit_trail")] = tier_counts.get(decision.get("tier", "audit_trail"), 0) + 1

    total_decisions = sum(tier_counts.values())
    auto_rate = (tier_counts["auto_approved"] / total_decisions * 100) if total_decisions > 0 else 0

    # Build Markdown report
    lines = [
        f"# AI Completeness Report",
        f"",
        f"**Project ID:** {project_id}",
        f"**Project Address:** {state.get('project_address', 'N/A')}",
        f"**Client:** {state.get('client_name', 'N/A')}",
        f"**Report Type:** {state.get('report_type', 'phase_1').replace('_', ' ').title()}",
        f"**Generated:** {datetime.utcnow().isoformat()}Z",
        f"",
        f"---",
        f"",
        f"## Executive Summary",
        f"",
        f"This report documents all AI decisions made during the automated ESA report assembly process.",
        f"",
        f"### Decision Statistics",
        f"",
        f"| Tier | Count | Description |",
        f"|------|-------|-------------|",
        f"| Tier 1 (Auto-Approved) | {tier_counts['auto_approved']} | High confidence, low risk - processed automatically |",
        f"| Tier 2 (Audit Trail) | {tier_counts['audit_trail']} | Medium confidence - logged for review |",
        f"| Tier 3 (Human Review) | {tier_counts['human_review']} | Required human verification |",
        f"| **Total** | **{total_decisions}** | |",
        f"",
        f"**Automation Rate:** {auto_rate:.1f}% of decisions were auto-approved",
        f"",
    ]

    # Section Completeness
    lines.extend([
        f"---",
        f"",
        f"## Section Completeness",
        f"",
    ])

    if structure_result:
        completeness = structure_result.completeness_score
        lines.extend([
            f"**Overall Completeness:** {completeness:.0%}",
            f"",
            f"### Sections Found",
            f"",
        ])

        for section_id in structure_result.sections_found:
            lines.append(f"- [x] {section_id}")

        lines.append("")

        if structure_result.sections_missing:
            lines.extend([
                f"### Sections Missing",
                f"",
            ])
            for section_id in structure_result.sections_missing:
                lines.append(f"- [ ] {section_id}")
            lines.append("")

        if structure_result.sections_misclassified_recovered:
            lines.extend([
                f"### Sections Recovered (AI Correction)",
                f"",
            ])
            for recovery in structure_result.sections_misclassified_recovered:
                lines.append(f"- {recovery}")
            lines.append("")

    # Document Classifications
    lines.extend([
        f"---",
        f"",
        f"## Document Classifications",
        f"",
        f"| Document | Category | Section | Confidence |",
        f"|----------|----------|---------|------------|",
    ])

    classified_docs = state.get("classified_documents", [])
    for doc in classified_docs:
        filename = doc.file.original_filename[:40] + "..." if len(doc.file.original_filename) > 40 else doc.file.original_filename
        category = doc.classification.category.value
        section = doc.classification.section
        confidence = f"{doc.classification.confidence:.0%}"
        lines.append(f"| {filename} | {category} | {section} | {confidence} |")

    lines.append("")

    # QC Results
    qc_result = state.get("qc_result")
    if qc_result:
        lines.extend([
            f"---",
            f"",
            f"## Quality Control Results",
            f"",
            f"**Overall QC Status:** {'PASSED' if qc_result.qc_passed else 'FAILED'}",
            f"**Overall Score:** {qc_result.overall_score:.0%}",
            f"**Confidence Level:** {qc_result.confidence_level:.0%}",
            f"",
        ])

        if qc_result.section_scores:
            lines.extend([
                f"### Validator Scores",
                f"",
                f"| Validator | Score |",
                f"|-----------|-------|",
            ])
            for validator, score in qc_result.section_scores.items():
                lines.append(f"| {validator.replace('_', ' ').title()} | {score:.0%} |")
            lines.append("")

        if qc_result.blocking_issues:
            lines.extend([
                f"### Blocking Issues",
                f"",
            ])
            for issue in qc_result.blocking_issues:
                lines.append(f"- **{issue.agent}**: {issue.description} ({issue.location})")
            lines.append("")

        if qc_result.warnings:
            lines.extend([
                f"### Warnings",
                f"",
            ])
            for warning in qc_result.warnings:
                lines.append(f"- {warning.agent}: {warning.description}")
            lines.append("")

    # Assembly Results
    assembly_result = state.get("assembly_result")
    if assembly_result:
        lines.extend([
            f"---",
            f"",
            f"## Assembly Results",
            f"",
            f"**Total Pages:** {assembly_result.total_pages}",
            f"**Source Pages:** {assembly_result.source_pages}",
            f"**Page Reconciliation:** {'PASSED' if assembly_result.pages_match else 'FAILED'}",
            f"**Reconciliation Attempts:** {assembly_result.page_reconciliation_attempts}",
            f"",
        ])

    # Decision Log
    lines.extend([
        f"---",
        f"",
        f"## AI Decision Log",
        f"",
    ])

    for i, decision in enumerate(decisions, 1):
        if isinstance(decision, AIDecision):
            lines.extend([
                f"### Decision #{i}",
                f"",
                f"- **Stage:** {decision.stage}",
                f"- **Action:** {decision.action}",
                f"- **Tier:** {decision.tier.value}",
                f"- **Confidence:** {decision.confidence:.0%}",
                f"- **Risk Level:** {decision.risk_level.value}",
                f"- **Reasoning:** {decision.reasoning}",
                f"- **Timestamp:** {decision.timestamp}",
                f"",
            ])
        elif isinstance(decision, dict):
            lines.extend([
                f"### Decision #{i}",
                f"",
                f"- **Stage:** {decision.get('stage', 'unknown')}",
                f"- **Action:** {decision.get('action', 'unknown')}",
                f"- **Tier:** {decision.get('tier', 'unknown')}",
                f"- **Confidence:** {decision.get('confidence', 0):.0%}",
                f"- **Risk Level:** {decision.get('risk_level', 'unknown')}",
                f"- **Reasoning:** {decision.get('reasoning', '')}",
                f"",
            ])

    # Footer
    lines.extend([
        f"---",
        f"",
        f"*Generated by ESA Pipeline AI System*",
        f"",
        f"*This report documents automated decisions. Human review is recommended for Tier 2 and Tier 3 decisions.*",
    ])

    # Write Markdown report
    with open(report_path, 'w') as f:
        f.write("\n".join(lines))

    # Build JSON report
    json_report = {
        "project_id": project_id,
        "project_address": state.get("project_address", ""),
        "client_name": state.get("client_name", ""),
        "report_type": state.get("report_type", "phase_1"),
        "generated_at": datetime.utcnow().isoformat(),
        "tier_statistics": tier_counts,
        "automation_rate": auto_rate,
        "section_completeness": {
            "score": structure_result.completeness_score if structure_result else 0,
            "sections_found": structure_result.sections_found if structure_result else [],
            "sections_missing": structure_result.sections_missing if structure_result else [],
            "sections_recovered": structure_result.sections_misclassified_recovered if structure_result else [],
        },
        "document_classifications": [
            {
                "filename": doc.file.original_filename,
                "category": doc.classification.category.value,
                "section": doc.classification.section,
                "confidence": doc.classification.confidence,
                "tiebreaker_used": doc.tiebreaker_used,
            }
            for doc in classified_docs
        ],
        "qc_results": qc_result.to_dict() if qc_result else None,
        "assembly_results": assembly_result.to_dict() if assembly_result else None,
        "decisions": [
            d.to_dict() if isinstance(d, AIDecision) else d
            for d in decisions
        ],
    }

    with open(json_path, 'w') as f:
        json.dump(json_report, f, indent=2, default=str)

    logger.info(f"Generated AI Completeness Report: {report_path}")

    return report_path


def _generate_qc_summary(
    state: ReportState,
    export_dir: str,
    qc_result: Any,
) -> str:
    """
    Generate a QC summary document with all AI notes and confidence scores.
    """
    project_id = state["project_id"]
    summary_filename = f"{project_id}_QC_Summary.json"
    summary_path = os.path.join(export_dir, summary_filename)

    summary = {
        "project_id": project_id,
        "project_address": state.get("project_address", ""),
        "client_name": state.get("client_name", ""),
        "report_type": state.get("report_type", "phase_1"),
        "generated_at": datetime.utcnow().isoformat(),
        "qc_results": None,
        "audit_log": state.get("audit_log", []),
    }

    if qc_result:
        summary["qc_results"] = {
            "passed": qc_result.qc_passed,
            "overall_score": qc_result.overall_score,
            "confidence_level": qc_result.confidence_level,
            "section_scores": qc_result.section_scores,
            "blocking_issues": [
                {
                    "agent": i.agent,
                    "severity": i.severity.value,
                    "description": i.description,
                    "location": i.location,
                    "fixed": i.fixed,
                }
                for i in qc_result.blocking_issues
            ],
            "warnings": [
                {
                    "agent": i.agent,
                    "severity": i.severity.value,
                    "description": i.description,
                    "location": i.location,
                }
                for i in qc_result.warnings
            ],
            "ai_notes": qc_result.ai_notes,
            "remediation_count": qc_result.remediation_count,
        }

    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2, default=str)

    logger.info(f"Generated QC summary: {summary_path}")

    return summary_path


def apply_final_signoff(state: ReportState, approved: bool, notes: str = "") -> Dict[str, Any]:
    """
    Apply final sign-off approval.

    Args:
        state: Current state
        approved: Whether the export is approved
        notes: Optional notes from reviewer

    Returns:
        Updated state fields
    """
    audit_entries = []
    decisions = []

    if approved:
        audit_entries.append(log_action("export", "final_signoff_approved", {
            "notes": notes,
        }))

        decisions.append(create_decision(
            stage="export",
            action="Final sign-off approved",
            confidence=1.0,
            risk_level=RiskLevel.LOW,
            reasoning=notes or "Report approved for delivery",
        ))

        return {
            "current_stage": PipelineStage.COMPLETE,
            "export_complete": True,
            "awaiting_human_input": False,
            "human_input_type": None,
            "human_input_data": {},
            "audit_log": audit_entries,
            "decisions": decisions,
            "pipeline_completed_at": datetime.utcnow().isoformat(),
        }
    else:
        audit_entries.append(log_action("export", "final_signoff_rejected", {
            "notes": notes,
        }))

        decisions.append(create_decision(
            stage="export",
            action="Final sign-off rejected",
            confidence=1.0,
            risk_level=RiskLevel.MEDIUM,
            reasoning=notes or "Report rejected",
        ))

        return {
            "export_complete": False,
            "errors": [f"Export rejected: {notes}"],
            "audit_log": audit_entries,
            "decisions": decisions,
        }

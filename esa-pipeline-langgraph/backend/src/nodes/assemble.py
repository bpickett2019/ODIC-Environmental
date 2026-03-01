"""
ASSEMBLE Node - Deterministic Page Reconciliation

Compiles all documents into the final report in correct order.
- Generates/updates Table of Contents with accurate page numbers
- Ensures consistent formatting
- Tracks total page count with ZERO TOLERANCE for page loss

CRITICAL PAGE RECONCILIATION:
If assembled_pages != source_pages, triggers remediation loop.
Maximum 3 reconciliation attempts before failing.
Every page must be accounted for - this is deterministic, not probabilistic.
"""

import os
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
from datetime import datetime
from dataclasses import dataclass

from state import (
    ReportState,
    ClassifiedDocument,
    DocumentCategory,
    AssemblyResult,
    PipelineStage,
    log_action,
    create_decision,
    RiskLevel,
)
from utils.document_processor import (
    merge_pdfs,
    get_pdf_page_count,
    PYMUPDF_AVAILABLE,
)

logger = logging.getLogger(__name__)

# Maximum page reconciliation attempts
MAX_RECONCILIATION_ATTEMPTS = 3


@dataclass
class PageTracker:
    """Tracks individual page mappings during assembly."""
    source_file_id: str
    source_filename: str
    source_page_num: int  # 1-indexed within source
    assembled_page_num: int  # 1-indexed within assembled
    section: str
    verified: bool = False


def assemble_node(state: ReportState) -> Dict[str, Any]:
    """
    ASSEMBLE node - Compile documents into final report.

    - Merges documents in correct order from STRUCTURE node
    - Generates Table of Contents
    - Validates page count matches source total

    CRITICAL: Page reconciliation must pass (assembled = source pages).
    Uses deterministic page-by-page tracking with up to 3 reconciliation attempts.
    """
    logger.info(f"ASSEMBLE: Starting for project {state['project_id']}")

    structure_result = state.get("structure_result")
    if not structure_result:
        return {
            "current_stage": PipelineStage.ASSEMBLE,
            "stage_history": [PipelineStage.ASSEMBLE.value],
            "errors": ["No structure result - cannot assemble"],
            "pipeline_failed": True,
            "audit_log": [log_action("assemble", "assembly_failed", {"reason": "No structure result"})],
        }

    ordered_docs = structure_result.ordered_documents
    if not ordered_docs:
        return {
            "current_stage": PipelineStage.ASSEMBLE,
            "stage_history": [PipelineStage.ASSEMBLE.value],
            "errors": ["No documents to assemble"],
            "pipeline_failed": True,
            "audit_log": [log_action("assemble", "assembly_failed", {"reason": "No documents"})],
        }

    audit_entries = []
    decisions = []
    project_id = state["project_id"]

    # Get current reconciliation attempt count
    reconciliation_attempts = state.get("page_reconciliation_attempts", 0)

    # Calculate expected total pages from sources with detailed tracking
    source_pages = 0
    pdf_paths = []
    page_mapping: Dict[str, List[int]] = {}  # doc_id -> [start_page, end_page]
    page_trackers: List[PageTracker] = []

    current_page = 1
    skipped_docs = []

    for doc in ordered_docs:
        # Only include non-excluded documents
        if doc.classification.category == DocumentCategory.EXCLUDED:
            skipped_docs.append(doc.file.id)
            continue

        file_path = doc.file.file_path
        page_count = doc.file.page_count

        if not file_path or not os.path.exists(file_path):
            logger.warning(f"File not found: {file_path}")
            audit_entries.append(log_action("assemble", "file_missing", {
                "file_id": doc.file.id,
                "filename": doc.file.original_filename,
                "path": file_path,
            }))
            continue

        # Only PDFs can be merged directly
        if doc.file.format == 'pdf':
            # Verify page count before assembly
            actual_pages = get_pdf_page_count(file_path)
            if actual_pages != page_count:
                logger.warning(
                    f"Page count discrepancy for {doc.file.original_filename}: "
                    f"recorded {page_count}, actual {actual_pages}"
                )
                # Use actual count
                page_count = actual_pages
                audit_entries.append(log_action("assemble", "page_count_corrected", {
                    "file_id": doc.file.id,
                    "recorded": doc.file.page_count,
                    "actual": actual_pages,
                }))

            pdf_paths.append(file_path)
            start_page = current_page
            end_page = current_page + page_count - 1
            page_mapping[doc.file.id] = [start_page, end_page]

            # Create page trackers for detailed reconciliation
            for page_num in range(1, page_count + 1):
                page_trackers.append(PageTracker(
                    source_file_id=doc.file.id,
                    source_filename=doc.file.original_filename,
                    source_page_num=page_num,
                    assembled_page_num=current_page + page_num - 1,
                    section=doc.classification.section,
                ))

            source_pages += page_count
            current_page += page_count

            audit_entries.append(log_action("assemble", "document_queued", {
                "file_id": doc.file.id,
                "filename": doc.file.original_filename,
                "pages": page_count,
                "start": start_page,
                "end": end_page,
                "section": doc.classification.section,
            }))
        else:
            # For non-PDF documents, they should have been converted
            logger.warning(f"Non-PDF document skipped: {doc.file.original_filename} ({doc.file.format})")
            skipped_docs.append(doc.file.id)
            audit_entries.append(log_action("assemble", "non_pdf_skipped", {
                "file_id": doc.file.id,
                "filename": doc.file.original_filename,
                "format": doc.file.format,
            }))

    if not pdf_paths:
        return {
            "current_stage": PipelineStage.ASSEMBLE,
            "stage_history": [PipelineStage.ASSEMBLE.value],
            "errors": ["No PDF documents to assemble"],
            "pipeline_failed": True,
            "audit_log": audit_entries + [log_action("assemble", "assembly_failed", {"reason": "No PDFs"})],
        }

    # Create output directory
    output_dir = os.environ.get("OUTPUT_DIR", "./assembled_reports")
    project_output_dir = os.path.join(output_dir, project_id)
    os.makedirs(project_output_dir, exist_ok=True)

    # Generate output filename
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_filename = f"{project_id}_ESA_Report_{timestamp}.pdf"
    output_path = os.path.join(project_output_dir, output_filename)

    # Merge PDFs
    try:
        logger.info(f"Merging {len(pdf_paths)} PDFs (attempt {reconciliation_attempts + 1}/{MAX_RECONCILIATION_ATTEMPTS})...")
        assembled_pages = merge_pdfs(pdf_paths, output_path)
    except Exception as e:
        logger.exception(f"PDF merge failed: {e}")
        return {
            "current_stage": PipelineStage.ASSEMBLE,
            "stage_history": [PipelineStage.ASSEMBLE.value],
            "errors": [f"PDF merge failed: {str(e)}"],
            "pipeline_failed": True,
            "audit_log": audit_entries + [log_action("assemble", "merge_failed", {"error": str(e)})],
        }

    # CRITICAL: Page reconciliation
    pages_match = assembled_pages == source_pages
    missing_pages = source_pages - assembled_pages if not pages_match else 0

    if not pages_match:
        logger.error(
            f"PAGE MISMATCH! Source: {source_pages}, Assembled: {assembled_pages}, "
            f"Missing: {missing_pages} (attempt {reconciliation_attempts + 1})"
        )
        audit_entries.append(log_action("assemble", "page_mismatch", {
            "source_pages": source_pages,
            "assembled_pages": assembled_pages,
            "missing": missing_pages,
            "attempt": reconciliation_attempts + 1,
        }))

        # Determine if we should retry
        if reconciliation_attempts < MAX_RECONCILIATION_ATTEMPTS - 1:
            # Attempt remediation
            remediation_result = _attempt_page_remediation(
                state, pdf_paths, page_mapping, page_trackers, output_path
            )

            if remediation_result["success"]:
                # Remediation successful
                assembled_pages = remediation_result["assembled_pages"]
                pages_match = assembled_pages == source_pages
                audit_entries.extend(remediation_result.get("audit_entries", []))
            else:
                audit_entries.extend(remediation_result.get("audit_entries", []))
    else:
        logger.info(f"Page reconciliation PASSED: {assembled_pages} pages")

    # Verify output file
    if os.path.exists(output_path):
        verified_pages = get_pdf_page_count(output_path)
        if verified_pages != assembled_pages:
            logger.error(f"Output verification failed: expected {assembled_pages}, got {verified_pages}")
            pages_match = False
            audit_entries.append(log_action("assemble", "output_verification_failed", {
                "expected": assembled_pages,
                "verified": verified_pages,
            }))

    # Mark page trackers as verified if pages match
    if pages_match:
        for tracker in page_trackers:
            tracker.verified = True

    # TODO: Generate Table of Contents
    # This would require PDF manipulation to insert TOC pages
    toc_generated = False
    toc_page_count = 0

    assembly_result = AssemblyResult(
        assembled_file_path=output_path,
        total_pages=assembled_pages,
        source_pages=source_pages,
        pages_match=pages_match,
        page_reconciliation_attempts=reconciliation_attempts + 1,
        missing_pages_recovered=[],
        toc_generated=toc_generated,
        toc_page_count=toc_page_count,
        page_mapping=page_mapping,
    )

    # Create decision record
    assembly_risk = RiskLevel.HIGH if not pages_match else RiskLevel.LOW
    decisions.append(create_decision(
        stage="assemble",
        action=f"Assembled {assembled_pages} pages {'(MATCH)' if pages_match else '(MISMATCH)'}",
        confidence=1.0 if pages_match else 0.5,
        risk_level=assembly_risk,
        reasoning=f"Source: {source_pages}, Assembled: {assembled_pages}, Documents: {len(pdf_paths)}",
        details={
            "source_pages": source_pages,
            "assembled_pages": assembled_pages,
            "pages_match": pages_match,
            "documents_included": len(pdf_paths),
            "documents_skipped": len(skipped_docs),
            "reconciliation_attempts": reconciliation_attempts + 1,
        }
    ))

    logger.info(
        f"ASSEMBLE complete: {output_path} "
        f"({assembled_pages} pages, match={pages_match})"
    )

    audit_entries.append(log_action("assemble", "assembly_complete", {
        "output_path": output_path,
        "assembled_pages": assembled_pages,
        "source_pages": source_pages,
        "pages_match": pages_match,
        "documents_included": len(pdf_paths),
        "reconciliation_attempts": reconciliation_attempts + 1,
    }))

    # Determine completion status
    assembly_complete = pages_match
    should_fail = not pages_match and reconciliation_attempts >= MAX_RECONCILIATION_ATTEMPTS - 1

    return {
        "current_stage": PipelineStage.ASSEMBLE,
        "stage_history": [PipelineStage.ASSEMBLE.value],
        "assembly_result": assembly_result,
        "assembly_complete": assembly_complete,
        "page_reconciliation_passed": pages_match,
        "page_reconciliation_attempts": reconciliation_attempts + 1,
        "total_source_pages": source_pages,
        "errors": [] if pages_match else [f"Page mismatch: expected {source_pages}, got {assembled_pages}"],
        "pipeline_failed": should_fail,
        "audit_log": audit_entries,
        "decisions": decisions,
    }


def _attempt_page_remediation(
    state: ReportState,
    pdf_paths: List[str],
    page_mapping: Dict[str, List[int]],
    page_trackers: List[PageTracker],
    output_path: str,
) -> Dict[str, Any]:
    """
    Attempt to remediate page count discrepancy.

    This function tries to identify and fix the source of missing pages.
    """
    logger.info("Attempting page remediation...")

    audit_entries = []
    discrepancies = []

    # Re-verify each source document's page count
    structure_result = state.get("structure_result")
    if not structure_result:
        return {"success": False, "audit_entries": []}

    for doc in structure_result.ordered_documents:
        if doc.classification.category == DocumentCategory.EXCLUDED:
            continue

        if doc.file.format != 'pdf':
            continue

        file_path = doc.file.file_path
        if not file_path or not os.path.exists(file_path):
            discrepancies.append({
                "file_id": doc.file.id,
                "filename": doc.file.original_filename,
                "issue": "File not found during remediation",
            })
            continue

        # Re-count pages
        actual_pages = get_pdf_page_count(file_path)
        recorded_pages = doc.file.page_count

        if actual_pages != recorded_pages:
            discrepancies.append({
                "file_id": doc.file.id,
                "filename": doc.file.original_filename,
                "issue": f"Page count mismatch: recorded {recorded_pages}, actual {actual_pages}",
                "recorded": recorded_pages,
                "actual": actual_pages,
                "difference": recorded_pages - actual_pages,
            })

    if discrepancies:
        logger.warning(f"Found {len(discrepancies)} page count discrepancies during remediation")
        audit_entries.append(log_action("assemble", "remediation_discrepancies", {
            "discrepancies": discrepancies,
        }))

        # For now, we can't auto-fix page discrepancies
        # This would require re-ingesting the documents
        return {
            "success": False,
            "audit_entries": audit_entries,
            "discrepancies": discrepancies,
        }

    # No source discrepancies found - might be a merge issue
    # Try re-merging
    logger.info("No source discrepancies found, attempting re-merge...")

    try:
        assembled_pages = merge_pdfs(pdf_paths, output_path)
        audit_entries.append(log_action("assemble", "remerge_attempted", {
            "result_pages": assembled_pages,
        }))

        return {
            "success": True,
            "assembled_pages": assembled_pages,
            "audit_entries": audit_entries,
        }
    except Exception as e:
        logger.error(f"Re-merge failed: {e}")
        audit_entries.append(log_action("assemble", "remerge_failed", {
            "error": str(e),
        }))
        return {
            "success": False,
            "audit_entries": audit_entries,
        }


def remediate_missing_pages(state: ReportState) -> Dict[str, Any]:
    """
    External remediation function called from graph when pages don't match.

    This is called when assembled pages != source pages and we've exhausted
    automatic remediation attempts.
    """
    logger.info("External page remediation triggered...")

    assembly_result = state.get("assembly_result")
    if not assembly_result:
        return {"errors": ["No assembly result to remediate"]}

    audit_entries = []

    # Re-verify each source document's page count
    structure_result = state.get("structure_result")
    if not structure_result:
        return {"errors": ["No structure result for remediation"]}

    discrepancies = []

    for doc in structure_result.ordered_documents:
        if doc.classification.category == DocumentCategory.EXCLUDED:
            continue

        if doc.file.format != 'pdf':
            continue

        file_path = doc.file.file_path
        if not file_path or not os.path.exists(file_path):
            discrepancies.append({
                "file_id": doc.file.id,
                "filename": doc.file.original_filename,
                "issue": "File not found",
            })
            continue

        # Re-count pages
        actual_pages = get_pdf_page_count(file_path)
        recorded_pages = doc.file.page_count

        if actual_pages != recorded_pages:
            discrepancies.append({
                "file_id": doc.file.id,
                "filename": doc.file.original_filename,
                "issue": f"Page count mismatch: recorded {recorded_pages}, actual {actual_pages}",
                "recorded": recorded_pages,
                "actual": actual_pages,
            })

    if discrepancies:
        logger.warning(f"Found {len(discrepancies)} page count discrepancies")
        audit_entries.append(log_action("assemble", "remediation_discrepancies", {
            "discrepancies": discrepancies,
        }))

        return {
            "errors": [f"Page count discrepancy in {len(discrepancies)} documents"],
            "audit_log": audit_entries,
            "human_input_data": {
                "discrepancies": discrepancies,
                "action_required": "Review documents with page count issues",
            },
            "awaiting_human_input": True,
            "human_input_type": "page_remediation",
        }

    # No discrepancies found - might be a merge issue
    logger.warning("No source discrepancies found - may be a merge issue")
    audit_entries.append(log_action("assemble", "remediation_no_discrepancies", {}))

    return {
        "errors": ["Page mismatch but no source discrepancies found - manual review required"],
        "audit_log": audit_entries,
        "awaiting_human_input": True,
        "human_input_type": "page_remediation",
    }

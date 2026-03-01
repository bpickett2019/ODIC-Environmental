"""
INGEST Node - Full AI-Automated System

Accepts PDF, DOCX, JPG/PNG/TIFF. Normalizes all to internal format with:
- Extracted text
- Page counts
- File hashes
- OCR confidence scores

Tags EVERY file with project_id at ingest (prevents cross-contamination).
Idempotent - reprocessing same files produces same output.
"""

import os
import uuid
import logging
from pathlib import Path
from typing import Dict, Any, List
from datetime import datetime

from state import (
    ReportState,
    IngestedFile,
    PipelineStage,
    log_action,
    create_decision,
    RiskLevel,
)
from utils.document_processor import (
    process_document,
    compute_file_hash,
    get_file_format,
)

logger = logging.getLogger(__name__)


def ingest_node(state: ReportState) -> Dict[str, Any]:
    """
    INGEST node - Process uploaded files into normalized internal format.

    Accepts: PDF, DOCX, JPG/PNG/TIFF
    Outputs: List of IngestedFile objects with extracted text, page counts, hashes

    CRITICAL: Every file tagged with project_id for cross-contamination prevention.
    This node is idempotent - reprocessing same files produces same output.
    """
    logger.info(f"INGEST: Starting for project {state['project_id']}")

    new_files: List[IngestedFile] = []
    errors: List[str] = []
    audit_entries: List[Dict] = []
    decisions = []
    total_pages = 0

    # Get upload directory for this project
    project_id = state["project_id"]
    upload_dir = os.environ.get("UPLOAD_DIR", "./uploads")
    project_upload_dir = os.path.join(upload_dir, project_id)

    if not os.path.exists(project_upload_dir):
        logger.warning(f"No upload directory found: {project_upload_dir}")
        return {
            "current_stage": PipelineStage.INGEST,
            "stage_history": [PipelineStage.INGEST.value],
            "ingest_complete": True,
            "ingest_errors": ["No files found in upload directory"],
            "total_source_pages": 0,
            "audit_log": [log_action("ingest", "no_files_found", {"dir": project_upload_dir})],
            "decisions": [create_decision(
                stage="ingest",
                action="No files found in upload directory",
                confidence=1.0,
                risk_level=RiskLevel.LOW,
                reasoning="Upload directory is empty or doesn't exist",
            )],
        }

    # Get list of files to process
    # Skip already-processed files (check by content hash)
    existing_hashes = {f.content_hash for f in state.get("files", [])}

    # Supported formats
    supported_extensions = {'.pdf', '.docx', '.doc', '.jpg', '.jpeg', '.png', '.tiff', '.tif'}

    for filename in sorted(os.listdir(project_upload_dir)):
        file_path = os.path.join(project_upload_dir, filename)

        if not os.path.isfile(file_path):
            continue

        # Skip hidden files and system files
        if filename.startswith('.') or filename.startswith('~'):
            continue

        # Check extension
        ext = Path(filename).suffix.lower()
        if ext not in supported_extensions:
            logger.warning(f"Skipping unsupported format: {filename}")
            errors.append(f"Unsupported format: {filename}")
            continue

        try:
            # Compute hash for deduplication
            file_hash = compute_file_hash(file_path)

            if file_hash in existing_hashes:
                logger.debug(f"Skipping duplicate: {filename}")
                audit_entries.append(log_action("ingest", "duplicate_skipped", {
                    "filename": filename,
                    "hash": file_hash[:16],
                }))
                continue

            # Get file format
            file_format = get_file_format(file_path)
            if file_format == 'unknown':
                logger.warning(f"Unknown format, skipping: {filename}")
                errors.append(f"Unknown format: {filename}")
                continue

            # Process the document
            logger.info(f"Processing: {filename} ({file_format})")
            processed = process_document(file_path)

            if processed.metadata and processed.metadata.get("error"):
                errors.append(f"Error processing {filename}: {processed.metadata['error']}")
                audit_entries.append(log_action("ingest", "processing_error", {
                    "filename": filename,
                    "error": processed.metadata["error"],
                }))
                continue

            # Create IngestedFile with project tagging
            file_id = str(uuid.uuid4())[:8]
            file_size = os.path.getsize(file_path)

            ingested = IngestedFile(
                id=file_id,
                original_filename=filename,
                format=file_format,
                page_count=processed.page_count,
                size_bytes=file_size,
                text_content=processed.text_content,
                ocr_confidence=processed.ocr_confidence,
                content_hash=file_hash,
                metadata={
                    "project_id": project_id,  # CRITICAL: Tag with project
                    "ingested_at": datetime.utcnow().isoformat(),
                    "has_text_layer": processed.metadata.get("has_text_layer", True) if processed.metadata else True,
                    "image_count": processed.metadata.get("image_count", 0) if processed.metadata else 0,
                    **(processed.metadata or {}),
                },
                file_path=file_path,
                project_id=project_id,  # CRITICAL: Project tagging
            )

            new_files.append(ingested)
            existing_hashes.add(file_hash)
            total_pages += processed.page_count

            audit_entries.append(log_action("ingest", "file_ingested", {
                "filename": filename,
                "file_id": file_id,
                "format": file_format,
                "pages": processed.page_count,
                "size_bytes": file_size,
                "ocr_confidence": processed.ocr_confidence,
                "text_length": len(processed.text_content),
            }))

            # Create decision for tracking (deterministic = auto-approve)
            decisions.append(create_decision(
                stage="ingest",
                action=f"Ingested '{filename}'",
                confidence=1.0 if file_format == 'pdf' and not processed.ocr_confidence else (processed.ocr_confidence or 0.8),
                risk_level=RiskLevel.LOW,  # Ingest is deterministic
                reasoning=f"Successfully processed {file_format} file with {processed.page_count} pages",
                details={
                    "file_id": file_id,
                    "filename": filename,
                    "format": file_format,
                    "pages": processed.page_count,
                    "ocr_applied": processed.ocr_confidence is not None,
                }
            ))

            logger.info(
                f"Ingested: {filename} -> {file_id} "
                f"({processed.page_count} pages, "
                f"OCR conf: {processed.ocr_confidence or 'N/A'})"
            )

        except Exception as e:
            logger.exception(f"Failed to ingest {filename}: {e}")
            errors.append(f"Failed to ingest {filename}: {str(e)}")
            audit_entries.append(log_action("ingest", "ingest_exception", {
                "filename": filename,
                "error": str(e),
            }))

    # Summary
    logger.info(
        f"INGEST complete: {len(new_files)} files, "
        f"{total_pages} total pages, "
        f"{len(errors)} errors"
    )

    audit_entries.append(log_action("ingest", "ingest_complete", {
        "files_processed": len(new_files),
        "total_pages": total_pages,
        "errors": len(errors),
    }))

    return {
        "current_stage": PipelineStage.INGEST,
        "stage_history": [PipelineStage.INGEST.value],
        "files": new_files,
        "ingest_complete": True,
        "ingest_errors": errors,
        "total_source_pages": total_pages,
        "audit_log": audit_entries,
        "decisions": decisions,
        "tier1_count": len([d for d in decisions if d.tier.value == "auto_approved"]),
    }


def validate_ingest_input(state: ReportState) -> bool:
    """Validate input for ingest node."""
    if not state.get("project_id"):
        return False
    return True

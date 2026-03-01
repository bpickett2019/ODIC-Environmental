"""
Demo API Endpoints for ESA Pipeline

These endpoints power the visible AI processing demo:
- PDF upload with streaming page extraction
- Streaming AI document classification
- Streaming cross-contamination detection
- Real-time QC summary generation
"""

import os
import json
import asyncio
import uuid
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
from dataclasses import dataclass, asdict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from pydantic import BaseModel

# Add parent to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.pdf_processor import get_pdf_processor, PDFManifest, ProcessingEvent
from utils.streaming_ai import get_streaming_processor, AIThinkingEvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/demo", tags=["demo"])


# ===== Pydantic Models =====

class DemoProject(BaseModel):
    project_id: str
    project_address: str
    company: str = "ODIC Environmental"


class ProcessingResult(BaseModel):
    session_id: str
    status: str
    message: str


# ===== In-memory session storage =====

@dataclass
class DemoSession:
    """Tracks a demo processing session."""
    session_id: str
    project_id: str
    project_address: str
    company: str
    pdf_path: Optional[str] = None
    pdf_manifest: Optional[Dict[str, Any]] = None
    classifications: List[Dict[str, Any]] = None
    contamination_result: Optional[Dict[str, Any]] = None
    qc_summary: Optional[Dict[str, Any]] = None
    status: str = "created"
    created_at: str = None

    def __post_init__(self):
        if self.classifications is None:
            self.classifications = []
        if self.created_at is None:
            self.created_at = datetime.utcnow().isoformat()


# Session storage
_sessions: Dict[str, DemoSession] = {}
_websocket_connections: Dict[str, List[WebSocket]] = {}


def get_session(session_id: str) -> Optional[DemoSession]:
    return _sessions.get(session_id)


def create_session(project: DemoProject) -> DemoSession:
    session_id = f"demo_{uuid.uuid4().hex[:8]}"
    session = DemoSession(
        session_id=session_id,
        project_id=project.project_id,
        project_address=project.project_address,
        company=project.company
    )
    _sessions[session_id] = session
    return session


async def broadcast_to_session(session_id: str, message: Dict[str, Any]):
    """Send message to all WebSocket connections for a session."""
    if session_id in _websocket_connections:
        for ws in _websocket_connections[session_id]:
            try:
                await ws.send_json(message)
            except Exception as e:
                logger.error(f"Failed to send WebSocket message: {e}")


# ===== Endpoints =====

@router.post("/session/create")
async def create_demo_session(project: DemoProject) -> Dict[str, Any]:
    """Create a new demo session."""
    session = create_session(project)
    return {
        "session_id": session.session_id,
        "project_id": session.project_id,
        "status": "created"
    }


@router.get("/session/{session_id}")
async def get_session_status(session_id: str) -> Dict[str, Any]:
    """Get current session status and results."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return {
        "session_id": session.session_id,
        "project_id": session.project_id,
        "status": session.status,
        "pdf_manifest": session.pdf_manifest,
        "classifications": session.classifications,
        "contamination_result": session.contamination_result,
        "qc_summary": session.qc_summary
    }


@router.post("/session/{session_id}/upload")
async def upload_pdf(session_id: str, file: UploadFile = File(...)) -> Dict[str, Any]:
    """Upload a PDF for processing."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    # Save file
    upload_dir = os.environ.get("UPLOAD_DIR", "./uploads")
    session_dir = os.path.join(upload_dir, session_id)
    os.makedirs(session_dir, exist_ok=True)

    file_path = os.path.join(session_dir, file.filename)
    content = await file.read()

    with open(file_path, "wb") as f:
        f.write(content)

    session.pdf_path = file_path
    session.status = "uploaded"

    return {
        "session_id": session_id,
        "filename": file.filename,
        "size_bytes": len(content),
        "status": "uploaded"
    }


@router.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """
    WebSocket endpoint for streaming demo events.

    All processing events are streamed here:
    - PDF page extraction progress
    - AI thinking/analysis text
    - Classification results
    - Cross-contamination alerts
    - QC summary
    """
    await websocket.accept()

    session = get_session(session_id)
    if not session:
        await websocket.send_json({"type": "error", "message": "Session not found"})
        await websocket.close()
        return

    # Register connection
    if session_id not in _websocket_connections:
        _websocket_connections[session_id] = []
    _websocket_connections[session_id].append(websocket)

    try:
        # Send current status
        await websocket.send_json({
            "type": "connected",
            "session_id": session_id,
            "status": session.status
        })

        # Keep connection open
        while True:
            data = await websocket.receive_text()

            # Handle client commands
            try:
                command = json.loads(data)
                command_type = command.get("command")

                if command_type == "start_processing":
                    # Start the full processing pipeline
                    asyncio.create_task(
                        run_demo_pipeline(session_id, websocket)
                    )

                elif command_type == "start_classification":
                    # Just run classification
                    asyncio.create_task(
                        run_classification(session_id, websocket)
                    )

                elif command_type == "start_qc":
                    # Just run QC
                    asyncio.create_task(
                        run_qc_check(session_id, websocket)
                    )

            except json.JSONDecodeError:
                logger.warning(f"Invalid WebSocket message: {data}")

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {session_id}")
    finally:
        if session_id in _websocket_connections:
            _websocket_connections[session_id].remove(websocket)


async def run_demo_pipeline(session_id: str, websocket: WebSocket):
    """
    Run the full demo pipeline with streaming output.

    Stages:
    1. PDF extraction (page by page)
    2. AI classification (with visible thinking)
    3. Cross-contamination check
    4. QC summary generation
    """
    session = get_session(session_id)
    if not session or not session.pdf_path:
        await websocket.send_json({
            "type": "error",
            "message": "No PDF uploaded"
        })
        return

    project_context = {
        "project_id": session.project_id,
        "project_address": session.project_address,
        "company": session.company
    }

    # ===== STAGE 1: PDF EXTRACTION =====
    await websocket.send_json({
        "type": "stage_start",
        "stage": "ingest",
        "message": "Starting PDF extraction..."
    })

    session.status = "extracting"

    async def pdf_event_callback(event: ProcessingEvent):
        await websocket.send_json({
            "type": "pdf_progress",
            "stage": "ingest",
            **event.to_dict()
        })

    try:
        processor = get_pdf_processor()
        manifest = await processor.process_pdf_streaming(
            session.pdf_path,
            event_callback=pdf_event_callback
        )
        session.pdf_manifest = manifest.to_dict()

        await websocket.send_json({
            "type": "stage_complete",
            "stage": "ingest",
            "message": f"Extracted {manifest.total_pages} pages",
            "data": {
                "total_pages": manifest.total_pages,
                "total_words": manifest.total_words
            }
        })

    except Exception as e:
        logger.exception(f"PDF extraction failed: {e}")
        await websocket.send_json({
            "type": "error",
            "stage": "ingest",
            "message": f"PDF extraction failed: {str(e)}"
        })
        return

    # ===== STAGE 2: AI CLASSIFICATION =====
    await websocket.send_json({
        "type": "stage_start",
        "stage": "classify",
        "message": "Starting AI document classification..."
    })

    session.status = "classifying"

    async def ai_event_callback(event: AIThinkingEvent):
        await websocket.send_json({
            "type": "ai_thinking",
            **event.to_dict()
        })

    try:
        ai_processor = get_streaming_processor()

        # Get document chunks for classification
        chunks = processor.get_document_chunks(manifest, chunk_size=15)

        classifications = []
        for chunk in chunks:
            # Get text for this chunk from the PDF
            text = processor.get_page_range_text(
                session.pdf_path,
                chunk["page_start"],
                chunk["page_end"]
            )

            result = await ai_processor.analyze_document_streaming(
                text_content=text,
                page_range=(chunk["page_start"], chunk["page_end"]),
                project_context=project_context,
                event_callback=ai_event_callback
            )

            # Add page info to result
            result["page_start"] = chunk["page_start"]
            result["page_end"] = chunk["page_end"]
            result["text_preview"] = text[:1000]

            classifications.append(result)

            # Send classification result
            await websocket.send_json({
                "type": "classification_result",
                "stage": "classify",
                "data": result
            })

        session.classifications = classifications

        await websocket.send_json({
            "type": "stage_complete",
            "stage": "classify",
            "message": f"Classified {len(classifications)} sections",
            "data": {"classifications": classifications}
        })

    except Exception as e:
        logger.exception(f"Classification failed: {e}")
        await websocket.send_json({
            "type": "error",
            "stage": "classify",
            "message": f"Classification failed: {str(e)}"
        })
        return

    # ===== STAGE 3: CROSS-CONTAMINATION CHECK =====
    await websocket.send_json({
        "type": "stage_start",
        "stage": "qc",
        "message": "Starting cross-contamination scan..."
    })

    session.status = "checking"

    try:
        contamination_result = await ai_processor.check_cross_contamination_streaming(
            sections=classifications,
            project_context=project_context,
            event_callback=ai_event_callback
        )

        session.contamination_result = contamination_result

        await websocket.send_json({
            "type": "contamination_result",
            "stage": "qc",
            "data": contamination_result
        })

    except Exception as e:
        logger.exception(f"Contamination check failed: {e}")
        # Continue anyway

    # ===== STAGE 4: QC SUMMARY =====
    await websocket.send_json({
        "type": "stage_start",
        "stage": "qc",
        "message": "Generating QC summary..."
    })

    try:
        page_stats = {
            "source_pages": manifest.total_pages,
            "classified_pages": sum(
                c.get("page_end", 0) - c.get("page_start", 0) + 1
                for c in classifications
            ),
            "unclassified_pages": 0
        }
        page_stats["unclassified_pages"] = (
            page_stats["source_pages"] - page_stats["classified_pages"]
        )

        qc_summary = await ai_processor.generate_qc_summary_streaming(
            classifications=classifications,
            contamination_result=session.contamination_result or {},
            project_context=project_context,
            page_stats=page_stats,
            event_callback=ai_event_callback
        )

        session.qc_summary = qc_summary

        await websocket.send_json({
            "type": "qc_summary",
            "stage": "qc",
            "data": qc_summary
        })

    except Exception as e:
        logger.exception(f"QC summary failed: {e}")

    # ===== PIPELINE COMPLETE =====
    session.status = "complete"

    await websocket.send_json({
        "type": "pipeline_complete",
        "message": "Processing complete!",
        "data": {
            "session_id": session_id,
            "pdf_manifest": session.pdf_manifest,
            "classifications": session.classifications,
            "contamination_result": session.contamination_result,
            "qc_summary": session.qc_summary
        }
    })


async def run_classification(session_id: str, websocket: WebSocket):
    """Run just the classification stage."""
    # Similar to above but only classification
    pass  # Implemented via full pipeline


async def run_qc_check(session_id: str, websocket: WebSocket):
    """Run just the QC check stage."""
    # Similar to above but only QC
    pass  # Implemented via full pipeline


# ===== Page Reconciliation Endpoint =====

@router.get("/session/{session_id}/reconciliation")
async def get_page_reconciliation(session_id: str) -> Dict[str, Any]:
    """Get page reconciliation report."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if not session.pdf_manifest:
        raise HTTPException(status_code=400, detail="PDF not processed yet")

    manifest = session.pdf_manifest
    classifications = session.classifications or []

    source_pages = manifest.get("total_pages", 0)
    classified_pages = sum(
        c.get("page_end", 0) - c.get("page_start", 0) + 1
        for c in classifications
    )

    return {
        "source_pdf_pages": source_pages,
        "classified_pages": classified_pages,
        "unclassified_pages": max(0, source_pages - classified_pages),
        "coverage_percent": round((classified_pages / source_pages) * 100, 1) if source_pages > 0 else 0,
        "sections_found": [c.get("section", "Unknown") for c in classifications],
        "status": "complete" if classified_pages >= source_pages else "incomplete"
    }

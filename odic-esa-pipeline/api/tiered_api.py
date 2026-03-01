"""
ODIC ESA Pipeline - Tiered Classification API

WebSocket and REST endpoints for the tiered classification system.
Provides real-time progress streaming during classification.
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from skills.tiered_classifier import TieredClassifier, ClassificationProgress
from skills.qa_validator import QAValidator
from core.llm_router import LLMRouter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2", tags=["Tiered Classification"])


# ===== WebSocket Connection Manager =====
class ConnectionManager:
    """Manages WebSocket connections for real-time updates."""

    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket
        logger.info(f"WebSocket connected: {client_id}")

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
            logger.info(f"WebSocket disconnected: {client_id}")

    async def send_progress(self, client_id: str, progress: dict):
        """Send progress update to a specific client."""
        if client_id in self.active_connections:
            try:
                await self.active_connections[client_id].send_json(progress)
            except Exception as e:
                logger.error(f"Failed to send progress to {client_id}: {e}")
                self.disconnect(client_id)

    async def broadcast(self, message: dict):
        """Broadcast message to all connected clients."""
        for client_id, websocket in list(self.active_connections.items()):
            try:
                await websocket.send_json(message)
            except Exception:
                self.disconnect(client_id)


manager = ConnectionManager()


# ===== Pydantic Models =====
class ClassifyRequest(BaseModel):
    """Request to classify a PDF file."""
    file_path: str
    use_tiered: bool = True


class ClassificationResponse(BaseModel):
    """Response from classification."""
    success: bool
    filename: str
    project_id: Optional[str]
    total_pages: int
    sections: List[dict]
    statistics: dict
    cross_contamination_issues: List[dict]
    error: Optional[str] = None


class QARequest(BaseModel):
    """Request to run QA validation."""
    file_path: str
    sections: Optional[List[dict]] = None


# ===== Global State =====
classification_tasks: Dict[str, dict] = {}


def get_config() -> dict:
    """Load configuration."""
    config_path = Path(__file__).parent.parent / "config" / "config.yaml"
    if config_path.exists():
        import yaml
        with open(config_path) as f:
            return yaml.safe_load(f)
    return {}


# ===== WebSocket Endpoint =====
@router.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """
    WebSocket endpoint for real-time classification progress.

    Connect with: ws://localhost:8000/api/v2/ws/{client_id}

    Messages sent:
    - {"type": "connected", "client_id": "..."}
    - {"type": "progress", "data": {...}}
    - {"type": "classification", "data": {...}}
    - {"type": "complete", "data": {...}}
    - {"type": "error", "message": "..."}
    """
    await manager.connect(websocket, client_id)
    await websocket.send_json({
        "type": "connected",
        "client_id": client_id,
        "timestamp": datetime.now().isoformat()
    })

    try:
        while True:
            # Keep connection alive, receive any client messages
            data = await websocket.receive_text()
            # Handle client commands if needed
            if data == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(client_id)


# ===== Classification Endpoints =====
@router.post("/classify")
async def classify_document(request: ClassifyRequest):
    """
    Classify a document using the tiered classification system.

    For real-time progress, connect to WebSocket first.
    """
    file_path = Path(request.file_path)

    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {request.file_path}")

    if file_path.suffix.lower() != '.pdf':
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    config = get_config()
    llm_router = LLMRouter(config)

    task_id = f"classify_{datetime.now().strftime('%Y%m%d%H%M%S')}_{file_path.stem}"

    classification_tasks[task_id] = {
        "status": "started",
        "file": str(file_path),
        "started_at": datetime.now().isoformat(),
        "progress": None,
        "result": None
    }

    async def progress_callback(progress: ClassificationProgress):
        """Send progress updates via WebSocket."""
        progress_data = {
            "type": "progress",
            "task_id": task_id,
            "data": {
                "total_pages": progress.total_pages,
                "processed_pages": progress.processed_pages,
                "current_tier": progress.current_tier,
                "tier1_count": progress.tier1_count,
                "tier2_count": progress.tier2_count,
                "tier3_count": progress.tier3_count,
                "current_batch": progress.current_batch,
                "total_batches": progress.total_batches,
                "elapsed_seconds": progress.elapsed_seconds,
                "percent_complete": int(
                    (progress.tier1_count + progress.tier2_count + progress.tier3_count)
                    / progress.total_pages * 100
                ) if progress.total_pages > 0 else 0
            }
        }
        classification_tasks[task_id]["progress"] = progress_data["data"]
        await manager.broadcast(progress_data)

    try:
        classifier = TieredClassifier(
            config,
            llm_router,
            progress_callback=progress_callback
        )

        result = await classifier.classify_document(str(file_path), progress_callback)

        if result.success:
            classification_tasks[task_id]["status"] = "complete"
            classification_tasks[task_id]["result"] = result.data

            # Broadcast completion
            await manager.broadcast({
                "type": "complete",
                "task_id": task_id,
                "data": {
                    "filename": result.data["filename"],
                    "project_id": result.data["project_id"],
                    "total_pages": result.data["total_pages"],
                    "sections_count": len(result.data["sections"]),
                    "statistics": result.data["statistics"],
                    "cross_contamination_count": len(result.data.get("cross_contamination_issues", []))
                }
            })

            return {
                "success": True,
                "task_id": task_id,
                **result.data
            }
        else:
            classification_tasks[task_id]["status"] = "failed"
            classification_tasks[task_id]["error"] = result.error

            await manager.broadcast({
                "type": "error",
                "task_id": task_id,
                "message": result.error
            })

            return JSONResponse(
                status_code=500,
                content={"success": False, "error": result.error}
            )

    except Exception as e:
        logger.exception(f"Classification failed: {e}")
        classification_tasks[task_id]["status"] = "failed"
        classification_tasks[task_id]["error"] = str(e)

        await manager.broadcast({
            "type": "error",
            "task_id": task_id,
            "message": str(e)
        })

        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.get("/classify/{task_id}")
async def get_classification_status(task_id: str):
    """Get the status of a classification task."""
    if task_id not in classification_tasks:
        raise HTTPException(status_code=404, detail="Task not found")

    return classification_tasks[task_id]


@router.get("/classify/{task_id}/sections")
async def get_classification_sections(task_id: str):
    """Get the classified sections for a task."""
    if task_id not in classification_tasks:
        raise HTTPException(status_code=404, detail="Task not found")

    task = classification_tasks[task_id]
    if task["status"] != "complete":
        return {"status": task["status"], "sections": []}

    result = task.get("result", {})
    return {
        "status": "complete",
        "sections": result.get("sections", []),
        "classifications": result.get("classifications", [])
    }


# ===== QA Validation Endpoints =====
@router.post("/qa/validate")
async def validate_report(request: QARequest):
    """
    Run QA validation on a report.

    Optionally accepts pre-classified sections for more accurate validation.
    """
    file_path = Path(request.file_path)

    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {request.file_path}")

    config = get_config()
    llm_router = LLMRouter(config)

    try:
        validator = QAValidator(config, llm_router)

        result = await validator.validate_report(
            str(file_path),
            classified_sections=request.sections
        )

        if result.success:
            return {
                "success": True,
                **result.data
            }
        else:
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": result.error}
            )

    except Exception as e:
        logger.exception(f"QA validation failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# ===== Full Pipeline Endpoint =====
@router.post("/process")
async def process_full_pipeline(request: ClassifyRequest):
    """
    Run full classification + QA pipeline on a document.

    1. Classify document with tiered system
    2. Run QA validation
    3. Return combined results
    """
    file_path = Path(request.file_path)

    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {request.file_path}")

    config = get_config()
    llm_router = LLMRouter(config)

    task_id = f"process_{datetime.now().strftime('%Y%m%d%H%M%S')}_{file_path.stem}"

    async def progress_callback(progress: ClassificationProgress):
        await manager.broadcast({
            "type": "progress",
            "task_id": task_id,
            "stage": "classification",
            "data": {
                "total_pages": progress.total_pages,
                "processed_pages": progress.processed_pages,
                "current_tier": progress.current_tier,
                "percent_complete": int(
                    (progress.tier1_count + progress.tier2_count + progress.tier3_count)
                    / progress.total_pages * 100
                ) if progress.total_pages > 0 else 0
            }
        })

    try:
        # Stage 1: Classification
        await manager.broadcast({
            "type": "stage",
            "task_id": task_id,
            "stage": "classification",
            "message": "Starting classification..."
        })

        classifier = TieredClassifier(config, llm_router, progress_callback)
        classify_result = await classifier.classify_document(str(file_path), progress_callback)

        if not classify_result.success:
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": classify_result.error, "stage": "classification"}
            )

        # Stage 2: QA Validation
        await manager.broadcast({
            "type": "stage",
            "task_id": task_id,
            "stage": "qa_validation",
            "message": "Running QA validation..."
        })

        validator = QAValidator(config, llm_router)
        qa_result = await validator.validate_report(
            str(file_path),
            classified_sections=classify_result.data.get("sections")
        )

        # Combine results
        result = {
            "success": True,
            "task_id": task_id,
            "filename": classify_result.data["filename"],
            "project_id": classify_result.data["project_id"],
            "total_pages": classify_result.data["total_pages"],
            "classification": {
                "sections": classify_result.data["sections"],
                "statistics": classify_result.data["statistics"],
                "cross_contamination_issues": classify_result.data.get("cross_contamination_issues", [])
            },
            "qa": qa_result.data if qa_result.success else {"error": qa_result.error}
        }

        await manager.broadcast({
            "type": "complete",
            "task_id": task_id,
            "data": {
                "passed": qa_result.data.get("passed", False) if qa_result.success else False,
                "critical_count": qa_result.data.get("critical_count", 0) if qa_result.success else 0,
                "warning_count": qa_result.data.get("warning_count", 0) if qa_result.success else 0,
                "info_count": qa_result.data.get("info_count", 0) if qa_result.success else 0,
                "classification_stats": classify_result.data["statistics"]
            }
        })

        return result

    except Exception as e:
        logger.exception(f"Pipeline processing failed: {e}")
        await manager.broadcast({
            "type": "error",
            "task_id": task_id,
            "message": str(e)
        })

        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# ===== Health Check =====
@router.get("/health")
async def health_check():
    """Health check endpoint."""
    config = get_config()
    llm_router = LLMRouter(config)

    return {
        "status": "healthy",
        "llm_configured": llm_router.is_configured(),
        "active_websockets": len(manager.active_connections),
        "active_tasks": len(classification_tasks),
        "timestamp": datetime.now().isoformat()
    }

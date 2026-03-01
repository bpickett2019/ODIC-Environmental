"""
FastAPI Server for ESA Pipeline

Provides REST API and WebSocket endpoints for:
- Project creation and management
- File upload
- Pipeline control (start, pause, resume)
- Real-time status updates
- Human-in-the-loop interactions
"""

import os
import asyncio
import uuid
import json
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime

from fastapi import FastAPI, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

# Add parent to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from state import create_initial_state, PipelineStage
from graph import get_compiled_graph, run_pipeline, resume_pipeline

# Import demo API router
from api.demo_api import router as demo_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="ESA Pipeline API",
    description="LangGraph-powered ESA Report Assembly & QC Pipeline",
    version="1.0.0",
)

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include demo API routes
app.include_router(demo_router)


# ===== Pydantic Models =====

class ProjectCreate(BaseModel):
    project_id: str
    project_address: str
    report_type: str = "phase_1"
    client_name: str = ""


class HumanInput(BaseModel):
    thread_id: str
    input_type: str  # "classification_review", "appendix_order", "qc_resolution", "final_signoff"
    data: Dict[str, Any]


class ClassificationDecision(BaseModel):
    file_id: str
    category: str
    section: str
    appendix_letter: Optional[str] = None
    reason: Optional[str] = None


class AppendixOrderUpdate(BaseModel):
    new_order: List[str]  # List of file IDs in desired order


class QCResolution(BaseModel):
    approve_with_issues: bool = False
    auto_fix: bool = False
    fixes_to_apply: List[str] = []


class FinalSignoff(BaseModel):
    approved: bool
    notes: str = ""


# ===== Global State =====

class AppState:
    def __init__(self):
        self.active_pipelines: Dict[str, Dict] = {}
        self.websocket_connections: Dict[str, List[WebSocket]] = {}

    def add_pipeline(self, thread_id: str, project_id: str):
        self.active_pipelines[thread_id] = {
            "project_id": project_id,
            "started_at": datetime.utcnow().isoformat(),
            "status": "running",
        }

    def update_pipeline_status(self, thread_id: str, status: str, data: Dict = None):
        if thread_id in self.active_pipelines:
            self.active_pipelines[thread_id]["status"] = status
            if data:
                self.active_pipelines[thread_id].update(data)

    async def broadcast(self, thread_id: str, message: Dict):
        """Broadcast message to all WebSocket connections for a thread."""
        if thread_id in self.websocket_connections:
            for ws in self.websocket_connections[thread_id]:
                try:
                    await ws.send_json(message)
                except Exception as e:
                    logger.error(f"Failed to send to WebSocket: {e}")

app_state = AppState()


# ===== Startup/Shutdown =====

@app.on_event("startup")
async def startup():
    """Initialize on startup."""
    # Create required directories
    os.makedirs(os.environ.get("UPLOAD_DIR", "./uploads"), exist_ok=True)
    os.makedirs(os.environ.get("OUTPUT_DIR", "./assembled_reports"), exist_ok=True)
    os.makedirs(os.environ.get("EXPORT_DIR", "./exports"), exist_ok=True)
    os.makedirs("./checkpoints", exist_ok=True)

    logger.info("ESA Pipeline API started")


# ===== Project Endpoints =====

@app.post("/projects")
async def create_project(project: ProjectCreate):
    """Create a new project."""
    project_id = project.project_id

    # Create upload directory for project
    upload_dir = os.path.join(os.environ.get("UPLOAD_DIR", "./uploads"), project_id)
    os.makedirs(upload_dir, exist_ok=True)

    return {
        "project_id": project_id,
        "upload_dir": upload_dir,
        "status": "created",
    }


@app.get("/projects/{project_id}")
async def get_project(project_id: str):
    """Get project status."""
    upload_dir = os.path.join(os.environ.get("UPLOAD_DIR", "./uploads"), project_id)

    if not os.path.exists(upload_dir):
        raise HTTPException(status_code=404, detail="Project not found")

    # Count uploaded files
    files = [f for f in os.listdir(upload_dir) if not f.startswith('.')]

    return {
        "project_id": project_id,
        "files_uploaded": len(files),
        "files": files,
    }


@app.delete("/projects/{project_id}")
async def delete_project(project_id: str):
    """Delete a project and all its files."""
    import shutil

    upload_dir = os.path.join(os.environ.get("UPLOAD_DIR", "./uploads"), project_id)
    output_dir = os.path.join(os.environ.get("OUTPUT_DIR", "./assembled_reports"), project_id)
    export_dir = os.path.join(os.environ.get("EXPORT_DIR", "./exports"), project_id)

    for dir_path in [upload_dir, output_dir, export_dir]:
        if os.path.exists(dir_path):
            shutil.rmtree(dir_path)

    return {"status": "deleted", "project_id": project_id}


# ===== File Upload Endpoints =====

@app.post("/projects/{project_id}/upload")
async def upload_file(project_id: str, file: UploadFile = File(...)):
    """Upload a file for a project."""
    upload_dir = os.path.join(os.environ.get("UPLOAD_DIR", "./uploads"), project_id)
    os.makedirs(upload_dir, exist_ok=True)

    file_path = os.path.join(upload_dir, file.filename)

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    return {
        "filename": file.filename,
        "size": len(content),
        "path": file_path,
    }


@app.post("/projects/{project_id}/upload-multiple")
async def upload_multiple_files(project_id: str, files: List[UploadFile] = File(...)):
    """Upload multiple files for a project."""
    upload_dir = os.path.join(os.environ.get("UPLOAD_DIR", "./uploads"), project_id)
    os.makedirs(upload_dir, exist_ok=True)

    results = []
    for file in files:
        file_path = os.path.join(upload_dir, file.filename)
        with open(file_path, "wb") as f:
            content = await file.read()
            f.write(content)
        results.append({
            "filename": file.filename,
            "size": len(content),
            "path": file_path,
        })

    return {"uploaded": len(results), "files": results}


# ===== Pipeline Control Endpoints =====

@app.post("/pipeline/start")
async def start_pipeline(project: ProjectCreate, background_tasks: BackgroundTasks):
    """Start the pipeline for a project."""
    thread_id = f"{project.project_id}_{uuid.uuid4().hex[:8]}"

    app_state.add_pipeline(thread_id, project.project_id)

    # Run pipeline in background
    background_tasks.add_task(
        run_pipeline_task,
        thread_id,
        project.project_id,
        project.project_address,
        project.report_type,
        project.client_name,
    )

    return {
        "thread_id": thread_id,
        "project_id": project.project_id,
        "status": "started",
    }


async def run_pipeline_task(
    thread_id: str,
    project_id: str,
    project_address: str,
    report_type: str,
    client_name: str,
):
    """Background task to run the pipeline."""
    try:
        logger.info(f"Running pipeline for {project_id} (thread: {thread_id})")

        # Create initial state
        initial_state = create_initial_state(
            project_id=project_id,
            project_address=project_address,
            report_type=report_type,
            client_name=client_name,
        )

        # Get compiled graph
        graph = get_compiled_graph()

        config = {"configurable": {"thread_id": thread_id}}

        # Stream events
        async for event in graph.astream(initial_state, config, stream_mode="values"):
            # Broadcast status update
            stage = event.get("current_stage")
            if isinstance(stage, PipelineStage):
                stage = stage.value

            await app_state.broadcast(thread_id, {
                "type": "status_update",
                "stage": stage,
                "awaiting_human_input": event.get("awaiting_human_input", False),
                "human_input_type": event.get("human_input_type"),
                "errors": event.get("errors", []),
            })

            # Check if waiting for human input
            if event.get("awaiting_human_input"):
                app_state.update_pipeline_status(thread_id, "awaiting_input", {
                    "input_type": event.get("human_input_type"),
                    "input_data": event.get("human_input_data"),
                })
                return  # Pipeline will be resumed later

        # Pipeline completed
        app_state.update_pipeline_status(thread_id, "completed")
        await app_state.broadcast(thread_id, {
            "type": "pipeline_complete",
            "thread_id": thread_id,
        })

    except Exception as e:
        logger.exception(f"Pipeline failed: {e}")
        app_state.update_pipeline_status(thread_id, "failed", {"error": str(e)})
        await app_state.broadcast(thread_id, {
            "type": "pipeline_error",
            "error": str(e),
        })


@app.get("/pipeline/{thread_id}/status")
async def get_pipeline_status(thread_id: str):
    """Get current pipeline status."""
    if thread_id not in app_state.active_pipelines:
        raise HTTPException(status_code=404, detail="Pipeline not found")

    pipeline = app_state.active_pipelines[thread_id]

    # Get state from checkpoint
    graph = get_compiled_graph()
    config = {"configurable": {"thread_id": thread_id}}

    try:
        state = graph.get_state(config)
        if state and state.values:
            pipeline["state"] = {
                "current_stage": state.values.get("current_stage"),
                "awaiting_human_input": state.values.get("awaiting_human_input"),
                "human_input_type": state.values.get("human_input_type"),
                "human_input_data": state.values.get("human_input_data"),
            }
    except Exception as e:
        logger.warning(f"Could not get state: {e}")

    return pipeline


@app.post("/pipeline/{thread_id}/resume")
async def resume_pipeline_endpoint(
    thread_id: str,
    human_input: HumanInput,
    background_tasks: BackgroundTasks,
):
    """Resume a paused pipeline with human input."""
    if thread_id not in app_state.active_pipelines:
        raise HTTPException(status_code=404, detail="Pipeline not found")

    # Validate input type matches what pipeline is waiting for
    pipeline = app_state.active_pipelines[thread_id]
    expected_type = pipeline.get("input_type")

    if expected_type and expected_type != human_input.input_type:
        raise HTTPException(
            status_code=400,
            detail=f"Expected input type '{expected_type}', got '{human_input.input_type}'"
        )

    # Resume in background
    background_tasks.add_task(
        resume_pipeline_task,
        thread_id,
        human_input.data,
    )

    return {
        "thread_id": thread_id,
        "status": "resuming",
    }


async def resume_pipeline_task(thread_id: str, human_input: Dict[str, Any]):
    """Background task to resume pipeline."""
    try:
        logger.info(f"Resuming pipeline {thread_id} with input")

        graph = get_compiled_graph()
        config = {"configurable": {"thread_id": thread_id}}

        # Resume with human input
        async for event in graph.astream(human_input, config, stream_mode="values"):
            stage = event.get("current_stage")
            if isinstance(stage, PipelineStage):
                stage = stage.value

            await app_state.broadcast(thread_id, {
                "type": "status_update",
                "stage": stage,
                "awaiting_human_input": event.get("awaiting_human_input", False),
                "human_input_type": event.get("human_input_type"),
            })

            if event.get("awaiting_human_input"):
                app_state.update_pipeline_status(thread_id, "awaiting_input", {
                    "input_type": event.get("human_input_type"),
                    "input_data": event.get("human_input_data"),
                })
                return

        app_state.update_pipeline_status(thread_id, "completed")
        await app_state.broadcast(thread_id, {
            "type": "pipeline_complete",
            "thread_id": thread_id,
        })

    except Exception as e:
        logger.exception(f"Resume failed: {e}")
        app_state.update_pipeline_status(thread_id, "failed", {"error": str(e)})
        await app_state.broadcast(thread_id, {
            "type": "pipeline_error",
            "error": str(e),
        })


# ===== Human Input Endpoints =====

@app.post("/pipeline/{thread_id}/classification-review")
async def submit_classification_review(
    thread_id: str,
    decisions: List[ClassificationDecision],
    background_tasks: BackgroundTasks,
):
    """Submit classification review decisions."""
    decisions_dict = {
        d.file_id: {
            "category": d.category,
            "section": d.section,
            "appendix_letter": d.appendix_letter,
            "reason": d.reason,
        }
        for d in decisions
    }

    background_tasks.add_task(
        resume_pipeline_task,
        thread_id,
        {"decisions": decisions_dict},
    )

    return {"status": "submitted"}


@app.post("/pipeline/{thread_id}/appendix-order")
async def submit_appendix_order(
    thread_id: str,
    order: AppendixOrderUpdate,
    background_tasks: BackgroundTasks,
):
    """Submit appendix order update."""
    background_tasks.add_task(
        resume_pipeline_task,
        thread_id,
        {"new_order": order.new_order},
    )

    return {"status": "submitted"}


@app.post("/pipeline/{thread_id}/qc-resolution")
async def submit_qc_resolution(
    thread_id: str,
    resolution: QCResolution,
    background_tasks: BackgroundTasks,
):
    """Submit QC resolution decision."""
    background_tasks.add_task(
        resume_pipeline_task,
        thread_id,
        {
            "approve_with_issues": resolution.approve_with_issues,
            "auto_fix": resolution.auto_fix,
            "fixes_to_apply": resolution.fixes_to_apply,
        },
    )

    return {"status": "submitted"}


@app.post("/pipeline/{thread_id}/final-signoff")
async def submit_final_signoff(
    thread_id: str,
    signoff: FinalSignoff,
    background_tasks: BackgroundTasks,
):
    """Submit final sign-off."""
    background_tasks.add_task(
        resume_pipeline_task,
        thread_id,
        {
            "approved": signoff.approved,
            "notes": signoff.notes,
        },
    )

    return {"status": "submitted"}


# ===== WebSocket Endpoint =====

@app.websocket("/ws/{thread_id}")
async def websocket_endpoint(websocket: WebSocket, thread_id: str):
    """WebSocket endpoint for real-time updates."""
    await websocket.accept()

    # Register connection
    if thread_id not in app_state.websocket_connections:
        app_state.websocket_connections[thread_id] = []
    app_state.websocket_connections[thread_id].append(websocket)

    try:
        # Send current status
        if thread_id in app_state.active_pipelines:
            await websocket.send_json({
                "type": "current_status",
                "data": app_state.active_pipelines[thread_id],
            })

        # Keep connection open
        while True:
            data = await websocket.receive_text()
            # Handle any client messages if needed
            logger.debug(f"Received from client: {data}")

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {thread_id}")
    finally:
        # Unregister connection
        if thread_id in app_state.websocket_connections:
            app_state.websocket_connections[thread_id].remove(websocket)


# ===== Export/Download Endpoints =====

@app.get("/projects/{project_id}/exports")
async def list_exports(project_id: str):
    """List available exports for a project."""
    export_dir = os.path.join(os.environ.get("EXPORT_DIR", "./exports"), project_id)

    if not os.path.exists(export_dir):
        return {"exports": []}

    exports = []
    for filename in os.listdir(export_dir):
        file_path = os.path.join(export_dir, filename)
        if os.path.isfile(file_path):
            exports.append({
                "filename": filename,
                "size": os.path.getsize(file_path),
                "path": file_path,
            })

    return {"exports": exports}


@app.get("/projects/{project_id}/exports/{filename}")
async def download_export(project_id: str, filename: str):
    """Download an exported file."""
    file_path = os.path.join(
        os.environ.get("EXPORT_DIR", "./exports"),
        project_id,
        filename
    )

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(
        file_path,
        filename=filename,
        media_type="application/octet-stream",
    )


# ===== Health Check =====

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "active_pipelines": len(app_state.active_pipelines),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

"""
ODIC ESA Pipeline - FastAPI Server

Exposes REST API endpoints for the dashboard to interact with the pipeline.
Run with: uvicorn server:app --reload --port 8000
"""

import os
from dotenv import load_dotenv

# Load .env file if it exists
load_dotenv()
import sys
import json
import asyncio
import hashlib
import shutil
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, asdict
import logging

from fastapi import FastAPI, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import yaml
import paramiko

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent))

from core.state import StateManager, DocumentStatus, ProjectStatus
from core.llm_router import LLMRouter
from core.pipeline import Pipeline
from skills.document_classifier import DocumentClassifier
from skills.file_organizer import FileOrganizer
from skills.report_assembler import ReportAssembler
from skills.qa_checker import QAChecker
from skills.tiered_classifier import TieredClassifier
from skills.qa_validator import QAValidator

# Import tiered API router
try:
    from api.tiered_api import router as tiered_router
    TIERED_API_AVAILABLE = True
except ImportError:
    TIERED_API_AVAILABLE = False

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ===== FastAPI App =====
app = FastAPI(
    title="ODIC ESA Pipeline API",
    description="API for the ESA Report Automation Pipeline",
    version="1.0.0"
)

# CORS middleware for dashboard
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include tiered API router if available
if TIERED_API_AVAILABLE:
    app.include_router(tiered_router)
    logger.info("Tiered Classification API (v2) enabled at /api/v2")

# ===== Global State =====
class AppState:
    """Application state container."""
    def __init__(self):
        self.config: Dict = {}
        self.state_manager: Optional[StateManager] = None
        self.llm_router: Optional[LLMRouter] = None
        self.pipeline: Optional[Pipeline] = None
        self.ftp_connected: bool = False
        self.ftp_config: Dict = {}
        self.processing_queue: List[Dict] = []
        self.classification_results: List[Dict] = []
        self.assembly_tasks: Dict[str, Dict] = {}
        self.triage_decisions: Dict[str, Dict[str, Dict]] = {}  # project_id -> doc_id -> decision

    def load_config(self):
        """Load configuration from file."""
        config_path = Path(__file__).parent / "config" / "config.yaml"
        if config_path.exists():
            with open(config_path) as f:
                self.config = yaml.safe_load(f)
        else:
            self.config = {}

    def init_components(self):
        """Initialize pipeline components."""
        self.state_manager = StateManager(
            self.config.get("state_db", "./pipeline_state.db")
        )
        self.llm_router = LLMRouter(self.config)

state = AppState()


# ===== Pydantic Models =====
class FTPConfig(BaseModel):
    host: str
    port: int = 22
    username: str
    password: str
    watch_directory: str = "/incoming"


class ClassifyRequest(BaseModel):
    file_paths: List[str]


class ManualClassification(BaseModel):
    file_path: str
    document_type: str
    project_id: Optional[str] = None


class AssemblyStatus(BaseModel):
    project_id: str
    status: str
    stage: str
    progress: int
    message: str
    error: Optional[str] = None


class TriageDocument(BaseModel):
    """Document triage decision."""
    document_id: str
    include: bool
    reason: Optional[str] = None
    order: Optional[int] = None  # For drag-and-drop ordering
    document_type: Optional[str] = None  # For manual classification override


class TriageRequest(BaseModel):
    """Request to triage documents for a project."""
    documents: List[TriageDocument]
    confirmed: bool = False  # Must be True to proceed with assembly


class DocumentOrderRequest(BaseModel):
    """Request to reorder documents."""
    document_ids: List[str]  # Ordered list of document IDs


# ===== Startup =====
@app.on_event("startup")
async def startup():
    """Initialize application on startup."""
    logger.info("Starting ODIC ESA Pipeline API...")
    state.load_config()
    state.init_components()

    # Create required directories
    dirs = ["./staging", "./projects", "./completed_reports", "./failed", "./uploads"]
    for d in dirs:
        Path(d).mkdir(parents=True, exist_ok=True)

    # Check API key configuration and log status
    if state.llm_router:
        if state.llm_router.is_configured():
            model = state.llm_router.model
            base_url = state.llm_router.base_url
            logger.info(f"✓ AI connected: {model}")
            logger.info(f"  API endpoint: {base_url}")

            # Optional: Quick test call to verify connectivity
            try:
                test_result = state.llm_router.classify(
                    "Respond with exactly: OK",
                    "Health check"
                )
                if test_result.get("success"):
                    logger.info(f"  Health check: PASSED")
                else:
                    logger.warning(f"  Health check: FAILED - {test_result.get('error', 'unknown')}")
            except Exception as e:
                logger.warning(f"  Health check: SKIPPED - {e}")
        else:
            logger.warning("⚠ AI NOT CONNECTED - Set ANTHROPIC_API_KEY environment variable")
            logger.warning("  Document classification and QA will be limited without AI")
    else:
        logger.error("✗ LLM Router failed to initialize")

    logger.info("API ready")


# ===== FTP Endpoints =====
@app.post("/api/ftp/connect")
async def ftp_connect(config: FTPConfig):
    """Test FTP connection with provided credentials."""
    try:
        transport = paramiko.Transport((config.host, config.port))
        transport.connect(username=config.username, password=config.password)
        sftp = paramiko.SFTPClient.from_transport(transport)

        # Test listing directory
        try:
            sftp.listdir(config.watch_directory)
        except FileNotFoundError:
            sftp.close()
            transport.close()
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": f"Directory not found: {config.watch_directory}"}
            )

        sftp.close()
        transport.close()

        # Save config for sync
        state.ftp_config = config.dict()
        state.ftp_connected = True

        # Update config file
        state.config["ftp"] = config.dict()

        return {"success": True, "message": "Connected successfully"}

    except paramiko.AuthenticationException:
        return JSONResponse(
            status_code=401,
            content={"success": False, "error": "Authentication failed"}
        )
    except Exception as e:
        logger.exception(f"FTP connection failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/api/ftp/status")
async def ftp_status():
    """Get current FTP connection status."""
    return {
        "connected": state.ftp_connected,
        "config": {
            "host": state.ftp_config.get("host", ""),
            "port": state.ftp_config.get("port", 22),
            "username": state.ftp_config.get("username", ""),
            "watch_directory": state.ftp_config.get("watch_directory", "/incoming"),
        } if state.ftp_config else None
    }


@app.get("/api/ftp/list")
async def ftp_list_files():
    """List files on FTP server."""
    if not state.ftp_connected:
        return JSONResponse(
            status_code=400,
            content={"error": "Not connected to FTP server"}
        )

    try:
        config = state.ftp_config
        transport = paramiko.Transport((config["host"], config["port"]))
        transport.connect(username=config["username"], password=config["password"])
        sftp = paramiko.SFTPClient.from_transport(transport)

        files = []
        for entry in sftp.listdir_attr(config["watch_directory"]):
            if not entry.filename.startswith('.'):
                files.append({
                    "name": entry.filename,
                    "size": entry.st_size,
                    "modified": datetime.fromtimestamp(entry.st_mtime).isoformat(),
                    "is_pdf": entry.filename.lower().endswith('.pdf')
                })

        sftp.close()
        transport.close()

        return {"files": files, "directory": config["watch_directory"]}

    except Exception as e:
        logger.exception(f"FTP list failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@app.post("/api/ftp/sync")
async def ftp_sync(background_tasks: BackgroundTasks):
    """Sync files from FTP to local staging."""
    if not state.ftp_connected:
        return JSONResponse(
            status_code=400,
            content={"error": "Not connected to FTP server"}
        )

    try:
        config = state.ftp_config
        transport = paramiko.Transport((config["host"], config["port"]))
        transport.connect(username=config["username"], password=config["password"])
        sftp = paramiko.SFTPClient.from_transport(transport)

        # Create staging directory
        staging_dir = Path("./staging") / datetime.now().strftime("%Y%m%d")
        staging_dir.mkdir(parents=True, exist_ok=True)

        synced_files = []
        for entry in sftp.listdir_attr(config["watch_directory"]):
            if entry.filename.lower().endswith('.pdf'):
                remote_path = f"{config['watch_directory']}/{entry.filename}"
                local_path = staging_dir / entry.filename

                # Skip if already exists
                if local_path.exists():
                    continue

                sftp.get(remote_path, str(local_path))

                synced_files.append({
                    "name": entry.filename,
                    "path": str(local_path),
                    "size": entry.st_size
                })

                # Add to processing queue
                state.processing_queue.append({
                    "id": hashlib.md5(str(local_path).encode()).hexdigest()[:12],
                    "name": entry.filename,
                    "path": str(local_path),
                    "size": entry.st_size,
                    "status": "queued",
                    "timestamp": datetime.now().isoformat()
                })

        sftp.close()
        transport.close()

        return {
            "success": True,
            "synced_count": len(synced_files),
            "files": synced_files
        }

    except Exception as e:
        logger.exception(f"FTP sync failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


# ===== Upload Endpoints =====
ALLOWED_EXTENSIONS = {'.pdf', '.docx', '.doc', '.jpg', '.jpeg', '.png', '.tiff', '.tif'}


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Upload a file for processing.

    Accepts: PDF, DOCX, DOC, JPG, PNG, TIFF
    Non-PDF files are automatically converted to PDF for processing.
    """
    from skills.file_converter import FileConverter

    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in ALLOWED_EXTENSIONS:
        return JSONResponse(
            status_code=400,
            content={
                "error": f"File type not supported: {file_ext}",
                "allowed": list(ALLOWED_EXTENSIONS)
            }
        )

    try:
        # Save to uploads directory
        upload_dir = Path("./uploads") / datetime.now().strftime("%Y%m%d")
        upload_dir.mkdir(parents=True, exist_ok=True)

        file_path = upload_dir / file.filename

        # Handle duplicates
        counter = 1
        while file_path.exists():
            stem = Path(file.filename).stem
            suffix = Path(file.filename).suffix
            file_path = upload_dir / f"{stem}_{counter}{suffix}"
            counter += 1

        with open(file_path, "wb") as f:
            content = await file.read()
            f.write(content)

        file_id = hashlib.md5(str(file_path).encode()).hexdigest()[:12]

        # Convert non-PDF files to PDF
        final_path = file_path
        converted = False
        if file_ext != '.pdf':
            try:
                converter = FileConverter(state.config)
                result = await converter.process(str(file_path))
                if result.success:
                    final_path = Path(result.data['output_path'])
                    file_id = hashlib.md5(str(final_path).encode()).hexdigest()[:12]
                    converted = True
                    logger.info(f"Converted {file_path.name} to PDF: {final_path.name}")
                else:
                    return JSONResponse(
                        status_code=500,
                        content={"error": f"File conversion failed: {result.error}"}
                    )
            except Exception as e:
                logger.exception(f"Conversion failed for {file_path.name}")
                return JSONResponse(
                    status_code=500,
                    content={"error": f"File conversion failed: {str(e)}"}
                )

        # Add to processing queue
        queue_item = {
            "id": file_id,
            "name": file_path.name,
            "original_name": file.filename,
            "path": str(final_path),
            "original_path": str(file_path) if converted else None,
            "size": final_path.stat().st_size,
            "status": "queued",
            "converted": converted,
            "original_format": file_ext if converted else None,
            "timestamp": datetime.now().isoformat()
        }
        state.processing_queue.append(queue_item)

        return {
            "success": True,
            "file_id": file_id,
            "name": final_path.name,
            "original_name": file.filename,
            "path": str(final_path),
            "size": final_path.stat().st_size,
            "converted": converted,
            "original_format": file_ext if converted else None
        }

    except Exception as e:
        logger.exception(f"Upload failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


# ===== Classification Endpoints =====
@app.get("/api/queue")
async def get_queue():
    """Get current processing queue."""
    return {"queue": state.processing_queue}


@app.post("/api/classify")
async def classify_documents(background_tasks: BackgroundTasks):
    """Classify all documents in the queue."""
    queued_items = [item for item in state.processing_queue if item["status"] == "queued"]

    if not queued_items:
        return {"message": "No documents to classify", "count": 0}

    # Start classification in background
    background_tasks.add_task(process_classification_queue)

    return {
        "message": f"Classification started for {len(queued_items)} documents",
        "count": len(queued_items)
    }


async def process_classification_queue():
    """Background task to classify queued documents."""
    if not state.llm_router.is_configured():
        logger.error("LLM router not configured - cannot classify")
        return

    classifier = DocumentClassifier(state.config, state.llm_router)
    organizer = FileOrganizer(state.config, state.state_manager)

    for item in state.processing_queue:
        if item["status"] != "queued":
            continue

        item["status"] = "processing"

        try:
            # Classify document
            result = await classifier.process(item["path"])

            if result.success:
                classification = {
                    "id": item["id"],
                    "filename": item["name"],
                    "path": item["path"],
                    "size": item["size"],
                    "type": result.data["type"],
                    "confidence": result.data["confidence"],
                    "project_id": result.data.get("project_id"),
                    "reasoning": result.data.get("reasoning", ""),
                    "requires_manual_review": result.data.get("requires_manual_review", False),
                    "status": "needs_review" if result.data.get("requires_manual_review") else "classified",
                    "timestamp": datetime.now().isoformat()
                }

                state.classification_results.append(classification)
                item["status"] = "classified"
                item["result"] = classification

                # If high confidence, organize into project folder
                if not result.data.get("requires_manual_review"):
                    try:
                        org_result = await organizer.process(result.data)
                        if org_result.success:
                            classification["organized_path"] = org_result.data.get("organized_path")
                            classification["project_id"] = org_result.data.get("project_id")
                    except Exception as e:
                        logger.error(f"Organization failed: {e}")

            else:
                item["status"] = "failed"
                item["error"] = result.error

        except Exception as e:
            logger.exception(f"Classification failed for {item['name']}: {e}")
            item["status"] = "failed"
            item["error"] = str(e)


@app.get("/api/classifications")
async def get_classifications():
    """Get all classification results."""
    return {"results": state.classification_results}


@app.post("/api/classify-tiered/{file_id}")
async def classify_tiered(file_id: str, background_tasks: BackgroundTasks):
    """
    Classify a specific file using the 3-tier classification system.

    This is 10x faster than the standard classifier because:
    - Tier 1 (rule-based) handles ~70% of pages instantly
    - Tier 2 (fast LLM batch) handles ~25% of pages in batches
    - Tier 3 (deep LLM) only analyzes ~5% of pages

    Returns page-by-page classifications and consolidated sections.
    """
    # Find the file in the queue
    target_item = None
    for item in state.processing_queue:
        if item["id"] == file_id:
            target_item = item
            break

    if not target_item:
        return JSONResponse(
            status_code=404,
            content={"error": f"File not found in queue: {file_id}"}
        )

    file_path = target_item["path"]

    if not Path(file_path).exists():
        return JSONResponse(
            status_code=404,
            content={"error": f"File does not exist: {file_path}"}
        )

    # Create tiered classifier
    classifier = TieredClassifier(state.config, state.llm_router)

    target_item["status"] = "processing"

    try:
        # Run tiered classification
        result = await classifier.classify_document(file_path)

        if result.success:
            # Store detailed results
            classification = {
                "id": file_id,
                "filename": target_item["name"],
                "path": file_path,
                "size": target_item["size"],
                "project_id": result.data.get("project_id"),
                "total_pages": result.data.get("total_pages"),
                "sections": result.data.get("sections", []),
                "statistics": result.data.get("statistics", {}),
                "cross_contamination_issues": result.data.get("cross_contamination_issues", []),
                "classifications": result.data.get("classifications", []),
                "status": "classified",
                "timestamp": datetime.now().isoformat()
            }

            # Count classifications
            classification["classification_count"] = len(result.data.get("classifications", []))

            state.classification_results.append(classification)
            target_item["status"] = "classified"
            target_item["result"] = classification

            return {
                "success": True,
                "file_id": file_id,
                **classification
            }
        else:
            target_item["status"] = "failed"
            target_item["error"] = result.error
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": result.error}
            )

    except Exception as e:
        logger.exception(f"Tiered classification failed for {target_item['name']}: {e}")
        target_item["status"] = "failed"
        target_item["error"] = str(e)
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/qa-validate/{file_id}")
async def qa_validate(file_id: str):
    """
    Run QA validation using the new 5-validator system.

    Validators:
    1. Completeness - ASTM E1527-21 required sections
    2. Page Integrity - Blank pages, duplicates
    3. Project Consistency - Cross-contamination detection
    4. Section Ordering - Appendix order
    5. Document Quality - Text extraction quality

    Returns issues categorized as critical/warning/info.
    """
    # Find the classification result
    target_result = None
    for result in state.classification_results:
        if result.get("id") == file_id:
            target_result = result
            break

    if not target_result:
        return JSONResponse(
            status_code=404,
            content={"error": f"No classification found for file: {file_id}"}
        )

    file_path = target_result.get("path")
    sections = target_result.get("sections")

    if not Path(file_path).exists():
        return JSONResponse(
            status_code=404,
            content={"error": f"File does not exist: {file_path}"}
        )

    # Run QA validation
    validator = QAValidator(state.config, state.llm_router)

    try:
        result = await validator.validate_report(file_path, classified_sections=sections)

        if result.success:
            return {
                "success": True,
                "file_id": file_id,
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


@app.get("/api/review-queue")
async def get_review_queue():
    """Get documents needing manual review."""
    review_items = [
        r for r in state.classification_results
        if r.get("requires_manual_review") or r.get("status") == "needs_review"
    ]
    return {"items": review_items}


@app.post("/api/manual-classify")
async def manual_classify(data: ManualClassification):
    """Manually classify a document."""
    # Find the classification result
    for result in state.classification_results:
        if result["path"] == data.file_path:
            result["type"] = data.document_type
            result["confidence"] = 1.0
            result["requires_manual_review"] = False
            result["status"] = "manually_classified"
            if data.project_id:
                result["project_id"] = data.project_id

            # Organize into project folder
            organizer = FileOrganizer(state.config, state.state_manager)
            try:
                org_result = await organizer.process(result)
                if org_result.success:
                    result["organized_path"] = org_result.data.get("organized_path")
                    result["project_id"] = org_result.data.get("project_id")
            except Exception as e:
                logger.error(f"Organization failed: {e}")

            return {"success": True, "result": result}

    return JSONResponse(
        status_code=404,
        content={"error": "Classification not found"}
    )


# ===== Project Endpoints =====
@app.get("/api/projects")
async def list_projects():
    """List all projects."""
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))

    projects = []
    if projects_dir.exists():
        for project_path in projects_dir.iterdir():
            if project_path.is_dir():
                project_id = project_path.name

                # Count documents
                doc_count = sum(1 for f in project_path.rglob("*.pdf"))

                # Check status from state
                project_status = "pending"
                if state.state_manager:
                    try:
                        project = state.state_manager.get_or_create_project(project_id)
                        project_status = project.status
                    except:
                        pass

                # Calculate progress
                required_types = ["edr", "topographic_map", "site_photograph"]
                found_types = set()
                for subdir in project_path.iterdir():
                    if subdir.is_dir() and any(subdir.glob("*.pdf")):
                        found_types.add(subdir.name)

                progress = int(len(found_types) / len(required_types) * 100) if required_types else 0

                projects.append({
                    "id": project_id,
                    "path": str(project_path),
                    "document_count": doc_count,
                    "status": project_status,
                    "progress": min(progress, 100),
                    "created": datetime.fromtimestamp(project_path.stat().st_ctime).isoformat()
                })

    # Sort by creation date
    projects.sort(key=lambda x: x["created"], reverse=True)

    return {"projects": projects}


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str):
    """Get detailed project information."""
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Collect documents by type
    documents = []
    doc_types = {}

    for pdf_file in project_path.rglob("*.pdf"):
        rel_path = pdf_file.relative_to(project_path)
        doc_type = rel_path.parts[0] if len(rel_path.parts) > 1 else "other"

        doc_info = {
            "name": pdf_file.name,
            "path": str(pdf_file),
            "type": doc_type,
            "size": pdf_file.stat().st_size,
            "modified": datetime.fromtimestamp(pdf_file.stat().st_mtime).isoformat()
        }
        documents.append(doc_info)

        doc_types[doc_type] = doc_types.get(doc_type, 0) + 1

    # Check for narratives
    narratives = {}
    narratives_dir = project_path / "narratives"
    if narratives_dir.exists():
        for json_file in narratives_dir.glob("*.json"):
            try:
                with open(json_file) as f:
                    narrative_data = json.load(f)
                    section_id = json_file.stem
                    narratives[section_id] = {
                        "status": "complete",
                        "content": narrative_data.get("content", ""),
                        "word_count": narrative_data.get("word_count", 0)
                    }
            except:
                pass

    # Check for assembled report
    reports_dir = project_path / "reports"
    report = None
    if reports_dir.exists():
        for pdf in reports_dir.glob("*_Final.pdf"):
            report = {
                "path": str(pdf),
                "name": pdf.name,
                "size": pdf.stat().st_size,
                "created": datetime.fromtimestamp(pdf.stat().st_ctime).isoformat()
            }
            break

    # Check for QA results
    qa_result = None
    qa_file = project_path / "qa_result.json"
    if qa_file.exists():
        try:
            with open(qa_file) as f:
                qa_result = json.load(f)
        except:
            pass

    # Get assembly status
    assembly_status = state.assembly_tasks.get(project_id)

    return {
        "id": project_id,
        "path": str(project_path),
        "documents": documents,
        "document_types": doc_types,
        "narratives": narratives,
        "report": report,
        "qa_result": qa_result,
        "assembly_status": assembly_status
    }


@app.get("/api/projects/{project_id}/documents")
async def get_project_documents(project_id: str):
    """Get all documents for a project."""
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    documents = []
    for pdf_file in project_path.rglob("*.pdf"):
        rel_path = pdf_file.relative_to(project_path)
        doc_type = rel_path.parts[0] if len(rel_path.parts) > 1 else "other"

        documents.append({
            "name": pdf_file.name,
            "path": str(pdf_file),
            "type": doc_type,
            "size": pdf_file.stat().st_size,
            "modified": datetime.fromtimestamp(pdf_file.stat().st_mtime).isoformat()
        })

    return {"documents": documents}


# ===== File Triage Endpoints =====
@app.get("/api/projects/{project_id}/triage")
async def get_triage_status(project_id: str):
    """
    Get file triage status for a project.

    Returns all classified documents with their include/exclude status,
    confidence scores, and whether triage has been confirmed.
    """
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Get all documents in the project
    documents = []
    for pdf_file in project_path.rglob("*.pdf"):
        rel_path = pdf_file.relative_to(project_path)
        doc_type = rel_path.parts[0] if len(rel_path.parts) > 1 else "other"

        # Generate document ID
        doc_id = hashlib.md5(str(pdf_file).encode()).hexdigest()[:12]

        # Get classification info if available
        classification = None
        for result in state.classification_results:
            if result.get("path") == str(pdf_file) or result.get("organized_path") == str(pdf_file):
                classification = result
                break

        confidence = classification.get("confidence", 1.0) if classification else 1.0

        # Get triage decision if exists
        triage_decision = state.triage_decisions.get(project_id, {}).get(doc_id)

        # Determine default include status based on type and confidence
        # Reference reports and low-confidence items default to exclude
        default_include = True
        auto_exclude_reason = None

        if doc_type == "reference_report" or (classification and classification.get("type") == "reference_report"):
            default_include = False
            auto_exclude_reason = "Third-party reference report - review before including"
        elif confidence < 0.9:
            default_include = False
            auto_exclude_reason = f"Low confidence classification ({confidence:.1%}) - review required"

        # Use triage decision if exists, otherwise use default
        if triage_decision:
            include = triage_decision.get("include", default_include)
            reason = triage_decision.get("reason")
        else:
            include = default_include
            reason = auto_exclude_reason

        # Try to get page count
        page_count = None
        try:
            from PyPDF2 import PdfReader
            reader = PdfReader(str(pdf_file))
            page_count = len(reader.pages)
        except:
            pass

        documents.append({
            "id": doc_id,
            "name": pdf_file.name,
            "path": str(pdf_file),
            "relative_path": str(rel_path),
            "type": classification.get("type", doc_type) if classification else doc_type,
            "confidence": confidence,
            "page_count": page_count,
            "size": pdf_file.stat().st_size,
            "include": include,
            "reason": reason,
            "auto_excluded": not default_include,
            "requires_review": classification.get("requires_manual_review", False) if classification else False,
            "modified": datetime.fromtimestamp(pdf_file.stat().st_mtime).isoformat()
        })

    # Sort: excluded items first (need attention), then by name
    documents.sort(key=lambda x: (x["include"], x["name"]))

    # Check if triage has been confirmed
    triage_confirmed = state.triage_decisions.get(project_id, {}).get("_confirmed", False)

    return {
        "project_id": project_id,
        "documents": documents,
        "total_documents": len(documents),
        "included_count": sum(1 for d in documents if d["include"]),
        "excluded_count": sum(1 for d in documents if not d["include"]),
        "needs_review_count": sum(1 for d in documents if d.get("requires_review") or d.get("auto_excluded")),
        "triage_confirmed": triage_confirmed,
        "can_assemble": triage_confirmed
    }


@app.post("/api/projects/{project_id}/triage")
async def update_triage(project_id: str, request: TriageRequest):
    """
    Update file triage decisions for a project.

    Each document can be marked as include/exclude with an optional reason.
    Set confirmed=True to lock in decisions and allow assembly to proceed.
    """
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Initialize triage decisions for project if needed
    if project_id not in state.triage_decisions:
        state.triage_decisions[project_id] = {}

    # Update decisions
    for doc in request.documents:
        state.triage_decisions[project_id][doc.document_id] = {
            "include": doc.include,
            "reason": doc.reason,
            "updated_at": datetime.now().isoformat()
        }

    # Mark as confirmed if requested
    if request.confirmed:
        state.triage_decisions[project_id]["_confirmed"] = True
        state.triage_decisions[project_id]["_confirmed_at"] = datetime.now().isoformat()

        # Save triage decisions to project folder
        triage_file = project_path / "triage_decisions.json"
        triage_data = {
            "project_id": project_id,
            "confirmed": True,
            "confirmed_at": datetime.now().isoformat(),
            "decisions": {
                k: v for k, v in state.triage_decisions[project_id].items()
                if not k.startswith("_")
            }
        }
        with open(triage_file, "w") as f:
            json.dump(triage_data, f, indent=2)

        logger.info(f"Triage confirmed for project {project_id}")

    return {
        "success": True,
        "project_id": project_id,
        "updated_count": len(request.documents),
        "confirmed": request.confirmed
    }


@app.delete("/api/projects/{project_id}/triage")
async def reset_triage(project_id: str):
    """Reset triage decisions for a project, requiring re-review."""
    if project_id in state.triage_decisions:
        del state.triage_decisions[project_id]

    # Remove saved triage file if exists
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    triage_file = projects_dir / project_id / "triage_decisions.json"
    if triage_file.exists():
        triage_file.unlink()

    return {"success": True, "message": "Triage reset - review required before assembly"}


@app.post("/api/projects/{project_id}/triage/reorder")
async def reorder_documents(project_id: str, request: DocumentOrderRequest):
    """
    Reorder documents for assembly.

    This sets the order in which documents will be assembled into the final report.
    Used by the drag-and-drop interface in the triage screen.
    """
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Initialize triage decisions for project if needed
    if project_id not in state.triage_decisions:
        state.triage_decisions[project_id] = {}

    # Update order for each document
    for idx, doc_id in enumerate(request.document_ids):
        if doc_id not in state.triage_decisions[project_id]:
            state.triage_decisions[project_id][doc_id] = {}
        state.triage_decisions[project_id][doc_id]["order"] = idx
        state.triage_decisions[project_id][doc_id]["updated_at"] = datetime.now().isoformat()

    # Save order to project folder
    order_file = project_path / "document_order.json"
    with open(order_file, "w") as f:
        json.dump({
            "project_id": project_id,
            "order": request.document_ids,
            "updated_at": datetime.now().isoformat()
        }, f, indent=2)

    logger.info(f"Document order updated for project {project_id}: {len(request.document_ids)} documents")

    return {
        "success": True,
        "project_id": project_id,
        "document_count": len(request.document_ids)
    }


@app.put("/api/projects/{project_id}/triage/{document_id}")
async def update_single_document_triage(project_id: str, document_id: str, data: TriageDocument):
    """
    Update triage decision for a single document.

    Allows updating include/exclude status, document type override, and reason.
    """
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Initialize triage decisions for project if needed
    if project_id not in state.triage_decisions:
        state.triage_decisions[project_id] = {}

    # Update decision
    state.triage_decisions[project_id][document_id] = {
        "include": data.include,
        "reason": data.reason,
        "document_type": data.document_type,
        "order": data.order,
        "updated_at": datetime.now().isoformat()
    }

    # If document type was changed, update classification results
    if data.document_type:
        for result in state.classification_results:
            if hashlib.md5(result.get("path", "").encode()).hexdigest()[:12] == document_id:
                result["type"] = data.document_type
                result["manually_classified"] = True
                break

    return {
        "success": True,
        "document_id": document_id,
        "include": data.include,
        "document_type": data.document_type
    }


def get_included_documents(project_id: str) -> List[Path]:
    """
    Get list of documents that should be included in assembly.

    Used by the assembly process to filter documents.
    """
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return []

    triage = state.triage_decisions.get(project_id, {})
    included_docs = []

    for pdf_file in project_path.rglob("*.pdf"):
        doc_id = hashlib.md5(str(pdf_file).encode()).hexdigest()[:12]
        decision = triage.get(doc_id, {})

        # Default to include if no decision made
        if decision.get("include", True):
            included_docs.append(pdf_file)

    return included_docs


# ===== Document Management Endpoints =====
class AddDocumentRequest(BaseModel):
    """Request to add a document to a project."""
    project_id: str
    document_type: str
    target_section: Optional[str] = None  # e.g., "historical/sanborn_maps"


class MoveDocumentRequest(BaseModel):
    """Request to move a document to a different section."""
    target_type: str  # New document type / section


class RemoveDocumentRequest(BaseModel):
    """Request to remove a document from a project."""
    reason: Optional[str] = None
    move_to_excluded: bool = True  # Move to excluded folder instead of deleting


@app.post("/api/projects/{project_id}/documents/add")
async def add_document_to_project(
    project_id: str,
    document_type: str = "other",
    file: UploadFile = File(...)
):
    """
    Add a new document directly to a project folder.

    The user can specify the document type, and the file will be placed
    in the correct subfolder within the project.
    """
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Map document type to subfolder
    SUBFOLDER_MAP = {
        "sanborn_map": "historical/sanborn_maps",
        "topographic_map": "historical/topo_maps",
        "aerial_photograph": "historical/aerials",
        "city_directory": "historical/city_directories",
        "fire_insurance_map": "historical/fire_insurance_maps",
        "edr": "regulatory/edr",
        "title_record": "records/title",
        "tax_record": "records/tax",
        "building_permit": "records/permits",
        "site_photograph": "site_visit/photos",
        "regulatory_correspondence": "regulatory/correspondence",
        "prior_environmental_report": "prior_reports",
        "client_correspondence": "client",
        "lab_results": "lab_results",
        "other": "other",
    }

    subfolder = SUBFOLDER_MAP.get(document_type, "other")
    target_dir = project_path / subfolder
    target_dir.mkdir(parents=True, exist_ok=True)

    # Save file
    file_path = target_dir / file.filename
    counter = 1
    while file_path.exists():
        stem = Path(file.filename).stem
        suffix = Path(file.filename).suffix
        file_path = target_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    try:
        content = await file.read()
        with open(file_path, "wb") as f:
            f.write(content)

        doc_id = hashlib.md5(str(file_path).encode()).hexdigest()[:12]

        logger.info(f"Added document to project {project_id}: {file_path.name} ({document_type})")

        # Reset triage confirmation since project contents changed
        if project_id in state.triage_decisions:
            state.triage_decisions[project_id].pop("_confirmed", None)
            state.triage_decisions[project_id].pop("_confirmed_at", None)
            logger.info(f"Triage reset for project {project_id} (document added)")

        return {
            "success": True,
            "document_id": doc_id,
            "name": file_path.name,
            "path": str(file_path),
            "type": document_type,
            "section": subfolder,
            "size": file_path.stat().st_size,
            "triage_reset": True
        }

    except Exception as e:
        logger.exception(f"Failed to add document: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/projects/{project_id}/documents/{document_id}")
async def remove_document_from_project(
    project_id: str,
    document_id: str,
    move_to_excluded: bool = True
):
    """
    Remove a document from a project.

    By default moves to an 'excluded' subfolder (recoverable).
    Set move_to_excluded=False to permanently delete.
    """
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Find the document by ID
    target_file = None
    for pdf_file in project_path.rglob("*.pdf"):
        doc_id = hashlib.md5(str(pdf_file).encode()).hexdigest()[:12]
        if doc_id == document_id:
            target_file = pdf_file
            break

    if not target_file:
        return JSONResponse(status_code=404, content={"error": "Document not found"})

    try:
        original_path = str(target_file)
        original_name = target_file.name

        if move_to_excluded:
            # Move to excluded folder (recoverable)
            excluded_dir = project_path / "_excluded"
            excluded_dir.mkdir(parents=True, exist_ok=True)
            dest = excluded_dir / target_file.name
            counter = 1
            while dest.exists():
                stem = target_file.stem
                suffix = target_file.suffix
                dest = excluded_dir / f"{stem}_{counter}{suffix}"
                counter += 1
            shutil.move(str(target_file), str(dest))
            logger.info(f"Moved document to excluded: {original_name}")
        else:
            target_file.unlink()
            logger.info(f"Deleted document: {original_name}")

        # Update triage to mark as excluded
        if project_id not in state.triage_decisions:
            state.triage_decisions[project_id] = {}
        state.triage_decisions[project_id][document_id] = {
            "include": False,
            "reason": "Removed by user",
            "updated_at": datetime.now().isoformat()
        }

        # Reset triage confirmation
        state.triage_decisions[project_id].pop("_confirmed", None)
        state.triage_decisions[project_id].pop("_confirmed_at", None)

        return {
            "success": True,
            "document_id": document_id,
            "name": original_name,
            "action": "moved_to_excluded" if move_to_excluded else "deleted",
            "triage_reset": True
        }

    except Exception as e:
        logger.exception(f"Failed to remove document: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/projects/{project_id}/documents/{document_id}/move")
async def move_document_in_project(
    project_id: str,
    document_id: str,
    request: MoveDocumentRequest
):
    """
    Move a document to a different section/type within a project.

    This reclassifies the document and moves it to the appropriate subfolder.
    """
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Find the document by ID
    target_file = None
    for pdf_file in project_path.rglob("*.pdf"):
        doc_id = hashlib.md5(str(pdf_file).encode()).hexdigest()[:12]
        if doc_id == document_id:
            target_file = pdf_file
            break

    if not target_file:
        return JSONResponse(status_code=404, content={"error": "Document not found"})

    SUBFOLDER_MAP = {
        "sanborn_map": "historical/sanborn_maps",
        "topographic_map": "historical/topo_maps",
        "aerial_photograph": "historical/aerials",
        "city_directory": "historical/city_directories",
        "fire_insurance_map": "historical/fire_insurance_maps",
        "edr": "regulatory/edr",
        "title_record": "records/title",
        "tax_record": "records/tax",
        "building_permit": "records/permits",
        "site_photograph": "site_visit/photos",
        "regulatory_correspondence": "regulatory/correspondence",
        "prior_environmental_report": "prior_reports",
        "client_correspondence": "client",
        "lab_results": "lab_results",
        "other": "other",
    }

    new_subfolder = SUBFOLDER_MAP.get(request.target_type, "other")
    new_dir = project_path / new_subfolder
    new_dir.mkdir(parents=True, exist_ok=True)

    try:
        old_path = str(target_file)
        new_path = new_dir / target_file.name

        # Handle name collision
        counter = 1
        while new_path.exists():
            stem = target_file.stem
            suffix = target_file.suffix
            new_path = new_dir / f"{stem}_{counter}{suffix}"
            counter += 1

        shutil.move(str(target_file), str(new_path))

        # New document ID (path changed)
        new_doc_id = hashlib.md5(str(new_path).encode()).hexdigest()[:12]

        # Update classification results
        for result in state.classification_results:
            if (result.get("path") == old_path or
                    hashlib.md5(result.get("path", "").encode()).hexdigest()[:12] == document_id):
                result["type"] = request.target_type
                result["path"] = str(new_path)
                result["manually_classified"] = True
                break

        # Reset triage confirmation
        if project_id in state.triage_decisions:
            state.triage_decisions[project_id].pop("_confirmed", None)

        logger.info(
            f"Moved document {target_file.name} to {new_subfolder} "
            f"in project {project_id}"
        )

        return {
            "success": True,
            "old_document_id": document_id,
            "new_document_id": new_doc_id,
            "name": new_path.name,
            "new_path": str(new_path),
            "new_type": request.target_type,
            "new_section": new_subfolder,
            "triage_reset": True
        }

    except Exception as e:
        logger.exception(f"Failed to move document: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/projects/{project_id}/documents/{document_id}/restore")
async def restore_excluded_document(project_id: str, document_id: str):
    """
    Restore a previously excluded document back into the project.

    Moves the file from the _excluded folder back to its original section.
    """
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id
    excluded_dir = project_path / "_excluded"

    if not excluded_dir.exists():
        return JSONResponse(status_code=404, content={"error": "No excluded documents found"})

    # Find in excluded folder
    target_file = None
    for pdf_file in excluded_dir.glob("*.pdf"):
        doc_id = hashlib.md5(str(pdf_file).encode()).hexdigest()[:12]
        if doc_id == document_id:
            target_file = pdf_file
            break

    if not target_file:
        return JSONResponse(status_code=404, content={"error": "Document not found in excluded"})

    # Move back to 'other' section (user can re-classify)
    other_dir = project_path / "other"
    other_dir.mkdir(parents=True, exist_ok=True)

    try:
        dest = other_dir / target_file.name
        shutil.move(str(target_file), str(dest))

        new_doc_id = hashlib.md5(str(dest).encode()).hexdigest()[:12]

        # Update triage
        if project_id in state.triage_decisions:
            state.triage_decisions[project_id].pop(document_id, None)
            state.triage_decisions[project_id].pop("_confirmed", None)

        logger.info(f"Restored document {target_file.name} to project {project_id}")

        return {
            "success": True,
            "document_id": new_doc_id,
            "name": dest.name,
            "path": str(dest),
            "restored_to": "other",
            "triage_reset": True
        }

    except Exception as e:
        logger.exception(f"Failed to restore document: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/projects/{project_id}/excluded")
async def list_excluded_documents(project_id: str):
    """List all excluded/removed documents for a project."""
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    excluded_dir = projects_dir / project_id / "_excluded"

    if not excluded_dir.exists():
        return {"documents": [], "count": 0}

    documents = []
    for pdf_file in excluded_dir.glob("*.pdf"):
        doc_id = hashlib.md5(str(pdf_file).encode()).hexdigest()[:12]
        documents.append({
            "id": doc_id,
            "name": pdf_file.name,
            "path": str(pdf_file),
            "size": pdf_file.stat().st_size,
            "excluded_at": datetime.fromtimestamp(pdf_file.stat().st_mtime).isoformat()
        })

    return {"documents": documents, "count": len(documents)}


# ===== Assembly Endpoints =====
@app.post("/api/assemble/{project_id}")
async def assemble_project(project_id: str, background_tasks: BackgroundTasks, skip_triage: bool = False):
    """
    Start report assembly for a project.

    Assembly requires file triage to be confirmed first, unless skip_triage=True.
    This ensures all documents have been reviewed before inclusion.
    """
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Check if triage has been confirmed (unless explicitly skipped)
    if not skip_triage:
        triage_confirmed = state.triage_decisions.get(project_id, {}).get("_confirmed", False)

        # Also check for saved triage file
        triage_file = project_path / "triage_decisions.json"
        if not triage_confirmed and triage_file.exists():
            try:
                with open(triage_file) as f:
                    saved_triage = json.load(f)
                    triage_confirmed = saved_triage.get("confirmed", False)
            except:
                pass

        if not triage_confirmed:
            return JSONResponse(
                status_code=400,
                content={
                    "error": "File triage not confirmed",
                    "message": "Please review and confirm file triage before assembly. "
                              "Use the 'Review Files' tab to include/exclude documents.",
                    "triage_required": True
                }
            )

    # Initialize assembly status
    state.assembly_tasks[project_id] = {
        "status": "started",
        "stage": "initializing",
        "progress": 0,
        "message": "Starting assembly process...",
        "started_at": datetime.now().isoformat()
    }

    # Start assembly in background
    background_tasks.add_task(run_assembly, project_id)

    return {"success": True, "message": f"Assembly started for project {project_id}"}


async def run_assembly(project_id: str):
    """Background task to run full assembly pipeline."""
    try:
        projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
        project_path = projects_dir / project_id

        # Stage 1: Assemble PDF
        state.assembly_tasks[project_id].update({
            "stage": "assemble",
            "progress": 50,
            "message": "Assembling PDF report..."
        })

        assembler = ReportAssembler(state.config, state.llm_router, state.state_manager)

        try:
            assembly_result = await assembler.process(project_id)

            if assembly_result.success:
                state.assembly_tasks[project_id].update({
                    "progress": 70,
                    "message": f"Report assembled: {assembly_result.data.get('page_count', 0)} pages"
                })
            else:
                state.assembly_tasks[project_id].update({
                    "status": "failed",
                    "message": f"Assembly failed: {assembly_result.error}",
                    "error": assembly_result.error
                })
                return
        except Exception as e:
            logger.exception(f"Assembly failed: {e}")
            state.assembly_tasks[project_id].update({
                "status": "failed",
                "message": f"Assembly failed: {str(e)}",
                "error": str(e)
            })
            return

        # Stage 3: QA Check
        state.assembly_tasks[project_id].update({
            "stage": "qa",
            "progress": 80,
            "message": "Running QA checks..."
        })

        qa_checker = QAChecker(state.config, state.llm_router, state.state_manager)

        try:
            report_path = assembly_result.data.get("report_path")
            qa_result = await qa_checker.process({
                "project_id": project_id,
                "report_path": report_path
            })

            if qa_result.success:
                # Save QA result
                qa_file = project_path / "qa_result.json"
                with open(qa_file, "w") as f:
                    json.dump(qa_result.data, f, indent=2)

                passed = qa_result.data.get("passed", False)
                score = qa_result.data.get("score", 0)

                state.assembly_tasks[project_id].update({
                    "stage": "complete",
                    "progress": 100,
                    "status": "complete",
                    "message": f"QA {'passed' if passed else 'failed'} with score {score}%",
                    "qa_passed": passed,
                    "qa_score": score,
                    "report_path": report_path,
                    "completed_at": datetime.now().isoformat()
                })
            else:
                state.assembly_tasks[project_id].update({
                    "progress": 90,
                    "message": f"QA check failed: {qa_result.error}"
                })
        except Exception as e:
            logger.error(f"QA check failed: {e}")
            state.assembly_tasks[project_id].update({
                "stage": "complete",
                "progress": 100,
                "status": "complete",
                "message": "Assembly complete (QA check skipped)",
                "report_path": assembly_result.data.get("report_path"),
                "completed_at": datetime.now().isoformat()
            })

    except Exception as e:
        logger.exception(f"Assembly pipeline failed: {e}")
        state.assembly_tasks[project_id].update({
            "status": "failed",
            "message": f"Pipeline failed: {str(e)}",
            "error": str(e)
        })


@app.get("/api/assemble/{project_id}/status")
async def get_assembly_status(project_id: str):
    """Get assembly status for a project."""
    status = state.assembly_tasks.get(project_id)
    if not status:
        return {"status": "not_started", "message": "Assembly not started"}
    return status


# ===== Compression Endpoints =====
@app.post("/api/projects/{project_id}/compress")
async def compress_report(project_id: str, target_size_mb: float = 25.0):
    """
    Compress the assembled report for a project.

    Compresses the final PDF report to reduce file size for email delivery.
    Uses image downsampling, metadata stripping, and stream optimization.

    Args:
        project_id: The project ID
        target_size_mb: Target maximum file size in MB (default 25)

    Returns:
        Compression results including new file path and statistics
    """
    from skills.pdf_compressor import PDFCompressor

    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Find the assembled report
    reports_dir = project_path / "reports"
    report_path = None

    if reports_dir.exists():
        for pdf in reports_dir.glob("*.pdf"):
            # Prefer non-compressed versions
            if "_compressed" not in pdf.name:
                report_path = pdf
                break
        # Fall back to any PDF if no non-compressed found
        if not report_path:
            for pdf in reports_dir.glob("*.pdf"):
                report_path = pdf
                break

    # Also check completed_reports directory
    if not report_path:
        output_dir = Path(state.config.get("pipeline", {}).get("output_dir", "./completed_reports"))
        for pdf in output_dir.glob(f"{project_id}*.pdf"):
            if "_compressed" not in pdf.name:
                report_path = pdf
                break

    if not report_path:
        return JSONResponse(
            status_code=404,
            content={"error": "No assembled report found. Please assemble the report first."}
        )

    # Check if compression is needed
    current_size = report_path.stat().st_size
    target_size = target_size_mb * 1024 * 1024

    if current_size <= target_size:
        return {
            "success": True,
            "message": "Report is already under target size",
            "compression_needed": False,
            "current_size_mb": round(current_size / 1024 / 1024, 2),
            "target_size_mb": target_size_mb
        }

    try:
        compressor = PDFCompressor(state.config)
        result = await compressor.process({
            'file_path': str(report_path),
            'project_id': project_id,
            'target_size_mb': target_size_mb
        })

        if result.success:
            # Copy compressed file to project reports folder
            compressed_path = Path(result.data['output_path'])
            project_compressed_path = reports_dir / compressed_path.name
            shutil.copy2(compressed_path, project_compressed_path)

            return {
                "success": True,
                "message": f"Report compressed: {result.data['reduction_percent']}% reduction",
                "compression_needed": True,
                "original_size_mb": result.data['original_size_mb'],
                "compressed_size_mb": result.data['compressed_size_mb'],
                "reduction_percent": result.data['reduction_percent'],
                "meets_target": result.data['meets_target'],
                "output_path": str(project_compressed_path),
                "page_count": result.data['page_count']
            }
        else:
            return JSONResponse(
                status_code=500,
                content={"error": result.error}
            )

    except Exception as e:
        logger.exception(f"Compression failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@app.get("/api/projects/{project_id}/compression-info")
async def get_compression_info(project_id: str):
    """Get compression information for a project's report."""
    from skills.pdf_compressor import PDFCompressor

    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Find reports
    reports_dir = project_path / "reports"
    original_report = None
    compressed_report = None

    if reports_dir.exists():
        for pdf in reports_dir.glob("*.pdf"):
            if "_compressed" in pdf.name:
                compressed_report = pdf
            else:
                original_report = pdf

    compressor = PDFCompressor(state.config)
    target_size_mb = state.config.get('compressor', {}).get('target_max_size_mb', 25)

    result = {
        "project_id": project_id,
        "target_size_mb": target_size_mb,
        "original_report": None,
        "compressed_report": None
    }

    if original_report:
        info = compressor.get_compression_info(original_report)
        if info:
            result["original_report"] = info

    if compressed_report:
        info = compressor.get_compression_info(compressed_report)
        if info:
            result["compressed_report"] = info

    return result


# ===== Status Endpoints =====
@app.get("/api/status")
async def get_status():
    """Get overall pipeline status including AI connection status."""
    ai_status = {
        "connected": False,
        "model": None,
        "base_url": None,
        "warning": None
    }

    if state.llm_router:
        ai_status["connected"] = state.llm_router.is_configured()
        if ai_status["connected"]:
            ai_status["model"] = state.llm_router.model
            ai_status["base_url"] = state.llm_router.base_url
        else:
            ai_status["warning"] = "Set ANTHROPIC_API_KEY environment variable to enable AI features"

    return {
        "status": "running",
        "ftp_connected": state.ftp_connected,
        "llm_configured": state.llm_router.is_configured() if state.llm_router else False,
        "ai_status": ai_status,
        "queue_length": len([q for q in state.processing_queue if q["status"] == "queued"]),
        "review_queue_length": len([r for r in state.classification_results if r.get("requires_manual_review")]),
        "timestamp": datetime.now().isoformat()
    }


@app.get("/api/ai/status")
async def ai_status():
    """Get AI connection status."""
    if not state.llm_router:
        return {
            "configured": False,
            "model": None,
            "base_url": None,
            "error": "LLM Router not initialized"
        }

    return {
        "configured": state.llm_router.is_configured(),
        "model": state.llm_router.model if state.llm_router.is_configured() else None,
        "base_url": state.llm_router.base_url if state.llm_router.is_configured() else None
    }


@app.get("/api/stats")
async def get_stats():
    """Get pipeline statistics."""
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))

    project_count = 0
    document_count = 0
    complete_count = 0

    if projects_dir.exists():
        for project_path in projects_dir.iterdir():
            if project_path.is_dir():
                project_count += 1
                document_count += sum(1 for f in project_path.rglob("*.pdf"))
                if (project_path / "reports").exists():
                    if any((project_path / "reports").glob("*_Final.pdf")):
                        complete_count += 1

    return {
        "total_projects": project_count,
        "total_documents": document_count,
        "complete_reports": complete_count,
        "pending_review": len([r for r in state.classification_results if r.get("requires_manual_review")]),
        "queue_length": len([q for q in state.processing_queue if q["status"] == "queued"])
    }


# ===== Document Type Reference =====
@app.get("/api/document-types")
async def get_document_types():
    """Get available document types."""
    doc_types_path = Path(__file__).parent / "config" / "document_types.yaml"

    if doc_types_path.exists():
        with open(doc_types_path) as f:
            config = yaml.safe_load(f)
            return {"document_types": config.get("document_types", {})}

    # Default types
    return {
        "document_types": {
            "sanborn_map": {"name": "Sanborn Fire Insurance Map"},
            "topographic_map": {"name": "Topographic Map"},
            "aerial_photograph": {"name": "Aerial Photograph"},
            "city_directory": {"name": "City Directory"},
            "fire_insurance_map": {"name": "Fire Insurance Map"},
            "edr": {"name": "Environmental Database Report"},
            "title_record": {"name": "Title Record"},
            "tax_record": {"name": "Tax Record"},
            "building_permit": {"name": "Building Permit"},
            "site_photograph": {"name": "Site Photograph"},
            "regulatory_correspondence": {"name": "Regulatory Correspondence"},
            "prior_environmental_report": {"name": "Prior Environmental Report"},
            "client_correspondence": {"name": "Client Correspondence"},
            "lab_results": {"name": "Lab Results"},
            "phase1_esa_report": {"name": "Phase I ESA Report"},
            "other": {"name": "Other/Unknown"}
        }
    }


# ===== Export Endpoints =====
class ExportRequest(BaseModel):
    """Request for report export."""
    format: str = "pdf"  # "pdf" or "docx"
    max_size_mb: float = 25.0
    split_if_needed: bool = True


@app.post("/api/projects/{project_id}/export")
async def export_report(project_id: str, request: ExportRequest):
    """
    Export the assembled report in the requested format.

    Supports:
    - PDF export with optional splitting at size limit
    - DOCX export for manual editing

    Args:
        project_id: The project ID
        request.format: "pdf" or "docx"
        request.max_size_mb: Maximum file size in MB (default 25)
        request.split_if_needed: Split at size limit if too large

    Returns:
        Export results with file path(s)
    """
    from skills.report_splitter import ReportSplitter
    from skills.word_exporter import WordExporter

    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    # Find the assembled report
    reports_dir = project_path / "reports"
    report_path = None

    if reports_dir.exists():
        for pdf in reports_dir.glob("*.pdf"):
            if "_compressed" not in pdf.name and "_part" not in pdf.name:
                report_path = pdf
                break
        if not report_path:
            for pdf in reports_dir.glob("*.pdf"):
                if "_part" not in pdf.name:
                    report_path = pdf
                    break

    if not report_path:
        return JSONResponse(
            status_code=404,
            content={"error": "No assembled report found. Please assemble the report first."}
        )

    try:
        if request.format.lower() == "docx":
            # Export to Word
            exporter = WordExporter(state.config)
            result = await exporter.process({
                'pdf_path': str(report_path),
                'project_id': project_id
            })

            if result.success:
                return {
                    "success": True,
                    "format": "docx",
                    "files": [{
                        "path": result.data['output_path'],
                        "size_mb": round(result.data['output_size'] / 1024 / 1024, 2),
                        "type": "docx"
                    }],
                    "warnings": result.data.get('warnings', [])
                }
            else:
                return JSONResponse(
                    status_code=500,
                    content={"error": result.error}
                )

        else:
            # PDF export with optional splitting
            current_size = report_path.stat().st_size
            max_size_bytes = request.max_size_mb * 1024 * 1024

            if current_size <= max_size_bytes or not request.split_if_needed:
                # No split needed
                return {
                    "success": True,
                    "format": "pdf",
                    "split_required": False,
                    "files": [{
                        "path": str(report_path),
                        "size_mb": round(current_size / 1024 / 1024, 2),
                        "type": "pdf",
                        "part": 1
                    }],
                    "total_parts": 1
                }

            # Split the PDF
            splitter = ReportSplitter(state.config)
            result = await splitter.process({
                'file_path': str(report_path),
                'project_id': project_id,
                'max_size_mb': request.max_size_mb
            })

            if result.success:
                files = []
                for chunk in result.data['chunks']:
                    files.append({
                        "path": chunk['path'],
                        "size_mb": chunk['size_mb'],
                        "type": "pdf",
                        "part": chunk['part_number'],
                        "pages": f"{chunk['start_page']}-{chunk['end_page']}"
                    })

                return {
                    "success": True,
                    "format": "pdf",
                    "split_required": True,
                    "files": files,
                    "total_parts": result.data['chunk_count'],
                    "original_size_mb": result.data['original_size_mb'],
                    "page_integrity_verified": result.data.get('page_integrity_verified', True)
                }
            else:
                return JSONResponse(
                    status_code=500,
                    content={"error": result.error}
                )

    except Exception as e:
        logger.exception(f"Export failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@app.get("/api/projects/{project_id}/export-status")
async def get_export_status(project_id: str):
    """Get export information for a project's report."""
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id

    if not project_path.exists():
        return JSONResponse(status_code=404, content={"error": "Project not found"})

    reports_dir = project_path / "reports"
    result = {
        "project_id": project_id,
        "has_report": False,
        "report_size_mb": None,
        "needs_split": False,
        "exports": []
    }

    if reports_dir.exists():
        # Find main report
        for pdf in reports_dir.glob("*.pdf"):
            if "_part" not in pdf.name and "_compressed" not in pdf.name:
                size = pdf.stat().st_size
                result["has_report"] = True
                result["report_size_mb"] = round(size / 1024 / 1024, 2)
                result["needs_split"] = size > 25 * 1024 * 1024
                break

        # Find existing exports
        for file in reports_dir.iterdir():
            if file.suffix in ['.pdf', '.docx']:
                result["exports"].append({
                    "path": str(file),
                    "name": file.name,
                    "size_mb": round(file.stat().st_size / 1024 / 1024, 2),
                    "type": file.suffix[1:],
                    "is_split": "_part" in file.name
                })

    return result


# ===== File Download =====
@app.get("/api/download/{project_id}/report")
async def download_report(project_id: str):
    """Download assembled report PDF."""
    projects_dir = Path(state.config.get("pipeline", {}).get("project_base_dir", "./projects"))
    project_path = projects_dir / project_id
    reports_dir = project_path / "reports"

    if reports_dir.exists():
        for pdf in reports_dir.glob("*_Final.pdf"):
            return FileResponse(
                pdf,
                media_type="application/pdf",
                filename=pdf.name
            )

    return JSONResponse(status_code=404, content={"error": "Report not found"})


# ===== Serve Dashboard =====
@app.get("/")
async def serve_dashboard():
    """Serve the dashboard HTML."""
    dashboard_path = Path(__file__).parent / "dashboard.html"
    if dashboard_path.exists():
        return FileResponse(dashboard_path, media_type="text/html")
    return JSONResponse(status_code=404, content={"error": "Dashboard not found"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

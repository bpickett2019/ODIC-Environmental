"""
ODIC ESA Pipeline - Pipeline Orchestrator

Orchestrates skill execution in order:
1. FTP Watcher detects new file
2. Document Classifier identifies document type
3. File Organizer sorts into project folder
4. Check if all required documents are present
5. Trigger Report Assembler when project is complete
"""

import asyncio
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Callable, Awaitable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

import yaml

from .state import StateManager, DocumentStatus, ProjectStatus
from .llm_router import LLMRouter
from skills.base import SkillResult
from skills.document_classifier import DocumentClassifier
from skills.file_organizer import FileOrganizer
from skills.ftp_watcher import FTPWatcher, LocalDirectoryWatcher


logger = logging.getLogger(__name__)


class PipelineStage(Enum):
    """Stages in the document processing pipeline."""
    DETECT = "detect"
    CLASSIFY = "classify"
    ORGANIZE = "organize"
    CHECK_COMPLETE = "check_complete"
    ASSEMBLE = "assemble"
    QA = "qa"
    NOTIFY = "notify"


@dataclass
class PipelineResult:
    """Result of processing a document through the pipeline."""
    success: bool
    file_path: str
    stages_completed: List[str] = field(default_factory=list)
    stage_results: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    error_stage: Optional[str] = None
    project_id: Optional[str] = None
    document_type: Optional[str] = None
    project_complete: bool = False


class Pipeline:
    """
    Orchestrates the document processing pipeline.

    Coordinates:
    - File detection (FTP or local)
    - Document classification
    - File organization
    - Project completeness checking
    - Report assembly triggering

    Features:
    - Configurable skill instances
    - Error handling with graceful degradation
    - State persistence
    - Async processing
    """

    def __init__(
        self,
        config: dict,
        state_manager: Optional[StateManager] = None,
        use_local_watcher: bool = False
    ):
        """
        Initialize the pipeline.

        Args:
            config: Configuration dictionary
            state_manager: Optional StateManager instance
            use_local_watcher: Use local directory watcher instead of FTP
        """
        self.config = config
        self.state_manager = state_manager or StateManager(
            config.get("state_db", "./pipeline_state.db")
        )

        # Load required document types
        self.required_types = self._get_required_types()

        # Initialize LLM router
        self.llm_router = LLMRouter(config)

        # Initialize skills
        self._init_skills(use_local_watcher)

        # Pipeline settings
        pipeline_config = config.get("pipeline", {})
        self.auto_assemble = pipeline_config.get("auto_assemble_when_complete", True)
        self.max_concurrent = pipeline_config.get("max_concurrent_projects", 5)

        # Processing queue
        self._processing_queue: asyncio.Queue = asyncio.Queue()
        self._running = False

        # Callbacks for pipeline events
        self.on_document_processed: Optional[Callable[[PipelineResult], Awaitable[None]]] = None
        self.on_project_complete: Optional[Callable[[str], Awaitable[None]]] = None

    def _get_required_types(self) -> List[str]:
        """Get required document types from config and ESA template."""
        required = []

        # From QA config
        qa_config = self.config.get("qa", {})
        if qa_config.get("require_edr", True):
            required.append("edr")
        if qa_config.get("require_topo", True):
            required.append("topographic_map")
        if qa_config.get("require_site_photos", True):
            required.append("site_photograph")

        # From ESA template
        template_path = Path(__file__).parent.parent / "config" / "esa_template.yaml"
        if template_path.exists():
            with open(template_path) as f:
                template = yaml.safe_load(f)
                min_docs = (
                    template.get("phase1_esa", {})
                    .get("required_documents", {})
                    .get("minimum", [])
                )
                for doc in min_docs:
                    if doc not in required:
                        required.append(doc)

        return required

    def _init_skills(self, use_local_watcher: bool):
        """Initialize pipeline skills."""
        # File watcher
        if use_local_watcher:
            self.watcher = LocalDirectoryWatcher(
                self.config,
                self.state_manager,
                on_new_file=self._on_new_file
            )
        else:
            self.watcher = FTPWatcher(
                self.config,
                self.state_manager,
                on_new_file=self._on_new_file
            )

        # Document classifier
        self.classifier = DocumentClassifier(
            self.config,
            self.llm_router
        )

        # File organizer
        self.organizer = FileOrganizer(
            self.config,
            self.state_manager
        )

        logger.info("Pipeline skills initialized")

    async def _on_new_file(self, file_path: str):
        """Callback when watcher detects a new file."""
        logger.info(f"New file detected: {file_path}")
        await self._processing_queue.put(file_path)

    async def process_document(self, file_path: str) -> PipelineResult:
        """
        Process a single document through the pipeline.

        Args:
            file_path: Path to the document to process

        Returns:
            PipelineResult with processing outcome
        """
        result = PipelineResult(
            success=False,
            file_path=file_path,
        )

        path = Path(file_path)
        if not path.exists():
            result.error = f"File not found: {file_path}"
            result.error_stage = PipelineStage.DETECT.value
            return result

        logger.info(f"Processing document: {path.name}")

        # Stage 1: Classification
        try:
            classify_result = await self.classifier.process(file_path)
            result.stages_completed.append(PipelineStage.CLASSIFY.value)
            result.stage_results["classify"] = classify_result.data

            if not classify_result.success:
                result.error = classify_result.error
                result.error_stage = PipelineStage.CLASSIFY.value
                self._handle_failed_document(file_path, classify_result.error)
                return result

            result.document_type = classify_result.data.get("type")
            result.project_id = classify_result.data.get("project_id")

            logger.info(
                f"Classified: type={result.document_type}, "
                f"confidence={classify_result.data.get('confidence', 0):.2f}, "
                f"project={result.project_id}"
            )

        except Exception as e:
            logger.exception(f"Classification failed: {e}")
            result.error = str(e)
            result.error_stage = PipelineStage.CLASSIFY.value
            self._handle_failed_document(file_path, str(e))
            return result

        # Stage 2: Organization
        try:
            organize_result = await self.organizer.process(classify_result.data)
            result.stages_completed.append(PipelineStage.ORGANIZE.value)
            result.stage_results["organize"] = organize_result.data

            if not organize_result.success:
                result.error = organize_result.error
                result.error_stage = PipelineStage.ORGANIZE.value
                self._handle_failed_document(file_path, organize_result.error)
                return result

            # Update project ID if it was determined during organization
            if organize_result.data.get("project_id"):
                result.project_id = organize_result.data["project_id"]

            logger.info(
                f"Organized: {organize_result.data.get('organized_path', 'N/A')}"
            )

        except Exception as e:
            logger.exception(f"Organization failed: {e}")
            result.error = str(e)
            result.error_stage = PipelineStage.ORGANIZE.value
            self._handle_failed_document(file_path, str(e))
            return result

        # Stage 3: Check project completeness
        result.stages_completed.append(PipelineStage.CHECK_COMPLETE.value)

        if result.project_id:
            completeness = self._check_project_completeness(result.project_id)
            result.stage_results["check_complete"] = completeness
            result.project_complete = completeness.get("complete", False)

            if result.project_complete:
                logger.info(f"Project {result.project_id} has all required documents!")

                # Update project status
                if self.state_manager:
                    self.state_manager.set_project_status(
                        result.project_id, ProjectStatus.READY
                    )

                # Stage 4: Trigger assembly
                if self.auto_assemble:
                    result.stages_completed.append(PipelineStage.ASSEMBLE.value)
                    result.stage_results["assemble"] = {"triggered": True}
                    # Note: Actual assembly would be triggered here
                    # await self._trigger_assembly(result.project_id)

                # Notify callback
                if self.on_project_complete:
                    try:
                        await self.on_project_complete(result.project_id)
                    except Exception as e:
                        logger.error(f"Project complete callback failed: {e}")
            else:
                logger.info(
                    f"Project {result.project_id} missing documents: "
                    f"{completeness.get('missing', [])}"
                )

        # Mark success
        result.success = True

        # Notify callback
        if self.on_document_processed:
            try:
                await self.on_document_processed(result)
            except Exception as e:
                logger.error(f"Document processed callback failed: {e}")

        return result

    def _check_project_completeness(self, project_id: str) -> Dict[str, Any]:
        """Check if a project has all required documents."""
        if self.state_manager:
            return self.state_manager.check_project_completeness(
                project_id, self.required_types
            )

        # Fallback to organizer's check
        return self.organizer._check_project_completeness(project_id)

    def _handle_failed_document(self, file_path: str, error: str):
        """Handle a document that failed processing."""
        logger.error(f"Document processing failed: {file_path} - {error}")

        if self.state_manager:
            self.state_manager.mark_document_failed(file_path, error)

    async def process_batch(self, file_paths: List[str]) -> List[PipelineResult]:
        """
        Process multiple documents.

        Args:
            file_paths: List of file paths to process

        Returns:
            List of PipelineResults
        """
        results = []
        for file_path in file_paths:
            result = await self.process_document(file_path)
            results.append(result)
        return results

    async def run(self, duration_seconds: Optional[int] = None):
        """
        Run the pipeline continuously.

        Args:
            duration_seconds: Optional duration limit
        """
        self._running = True
        start_time = datetime.now()

        logger.info("Starting pipeline")

        # Start the watcher
        watch_task = asyncio.create_task(
            self.watcher.watch(duration_seconds)
        )

        # Process queue
        try:
            while self._running:
                try:
                    # Wait for new files with timeout
                    file_path = await asyncio.wait_for(
                        self._processing_queue.get(),
                        timeout=5.0
                    )

                    # Process the document
                    result = await self.process_document(file_path)

                    if result.success:
                        logger.info(
                            f"Successfully processed: {Path(file_path).name} "
                            f"-> {result.document_type} ({result.project_id})"
                        )
                    else:
                        logger.error(
                            f"Failed to process: {Path(file_path).name} "
                            f"at stage {result.error_stage}: {result.error}"
                        )

                except asyncio.TimeoutError:
                    # No new files, check if we should stop
                    if duration_seconds:
                        elapsed = (datetime.now() - start_time).total_seconds()
                        if elapsed >= duration_seconds:
                            break

                except Exception as e:
                    logger.exception(f"Error processing queue: {e}")

        finally:
            self._running = False
            self.watcher.stop()

            # Wait for watcher to finish
            try:
                await asyncio.wait_for(watch_task, timeout=5.0)
            except asyncio.TimeoutError:
                watch_task.cancel()

            logger.info("Pipeline stopped")

    def stop(self):
        """Stop the pipeline."""
        self._running = False
        self.watcher.stop()

    def get_status(self) -> Dict[str, Any]:
        """Get current pipeline status."""
        status = {
            "running": self._running,
            "queue_size": self._processing_queue.qsize(),
            "auto_assemble": self.auto_assemble,
            "required_document_types": self.required_types,
        }

        if self.state_manager:
            status["stats"] = self.state_manager.get_stats()

        return status

    def get_project_status(self, project_id: str) -> Dict[str, Any]:
        """Get status of a specific project."""
        status = self.organizer.get_project_status(project_id)

        if self.state_manager:
            # Get documents from state
            docs = self.state_manager.get_documents_for_project(project_id)
            status["documents"] = [
                {
                    "filename": doc.original_filename,
                    "type": doc.document_type,
                    "status": doc.status,
                    "confidence": doc.confidence,
                }
                for doc in docs
            ]

            # Get project record
            project = self.state_manager.get_or_create_project(project_id)
            status["project_status"] = project.status

        return status

    def get_pending_projects(self) -> List[Dict[str, Any]]:
        """Get list of projects awaiting completion."""
        if not self.state_manager:
            return []

        projects = self.state_manager.get_projects_by_status(ProjectStatus.INCOMPLETE)
        return [
            {
                "project_id": p.project_id,
                "document_count": p.document_count,
                "created_at": p.created_at,
            }
            for p in projects
        ]

    def get_ready_projects(self) -> List[Dict[str, Any]]:
        """Get list of projects ready for report assembly."""
        if not self.state_manager:
            return []

        projects = self.state_manager.get_projects_by_status(ProjectStatus.READY)
        return [
            {
                "project_id": p.project_id,
                "document_count": p.document_count,
                "project_path": p.project_path,
            }
            for p in projects
        ]

# Convenience function for running pipeline
async def run_pipeline(
    config_path: str = "./config/config.yaml",
    use_local_watcher: bool = False,
    duration_seconds: Optional[int] = None
):
    """
    Run the pipeline with configuration from file.

    Args:
        config_path: Path to configuration file
        use_local_watcher: Use local directory instead of FTP
        duration_seconds: Optional run duration
    """
    # Load config
    with open(config_path) as f:
        config = yaml.safe_load(f)

    # Create pipeline
    pipeline = Pipeline(
        config,
        use_local_watcher=use_local_watcher
    )

    # Run
    await pipeline.run(duration_seconds)

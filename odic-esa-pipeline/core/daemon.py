"""
ODIC ESA Pipeline - Daemon Process

Main daemon that runs continuously:
- Starts the FTP watcher
- Processes incoming files through the full pipeline
- Handles graceful shutdown on SIGTERM/SIGINT
- Manages project completion and report assembly
"""

import asyncio
import signal
import logging
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any

import yaml

from .state import StateManager, ProjectStatus
from .llm_router import LLMRouter
from .pipeline import Pipeline, PipelineResult
from skills.report_assembler import ReportAssembler
from skills.qa_checker import QAChecker
from skills.notifier import Notifier


logger = logging.getLogger(__name__)


class Daemon:
    """
    Main daemon process for the ESA pipeline.

    Manages:
    - Pipeline execution
    - Project completion detection
    - Report assembly triggering
    - QA and notifications
    - Graceful shutdown
    """

    def __init__(
        self,
        config: dict,
        use_local_watcher: bool = False
    ):
        """
        Initialize the daemon.

        Args:
            config: Configuration dictionary
            use_local_watcher: Use local directory watcher instead of FTP
        """
        self.config = config
        self.use_local_watcher = use_local_watcher
        self._running = False
        self._shutdown_event = asyncio.Event()

        # Initialize state manager
        state_db = config.get("state_db", "./pipeline_state.db")
        self.state_manager = StateManager(state_db)

        # Initialize LLM router
        self.llm_router = LLMRouter(config)

        # Initialize pipeline
        self.pipeline = Pipeline(
            config,
            state_manager=self.state_manager,
            use_local_watcher=use_local_watcher
        )

        # Initialize assembler, QA, and notifier
        self.assembler = ReportAssembler(
            config,
            llm_router=self.llm_router,
            state_manager=self.state_manager
        )
        self.qa_checker = QAChecker(
            config,
            llm_router=self.llm_router,
            state_manager=self.state_manager
        )
        self.notifier = Notifier(config)

        # Set up pipeline callbacks
        self.pipeline.on_document_processed = self._on_document_processed
        self.pipeline.on_project_complete = self._on_project_complete

        # Tracking
        self._stats = {
            "started_at": None,
            "documents_processed": 0,
            "projects_completed": 0,
            "reports_generated": 0,
            "qa_passed": 0,
            "qa_failed": 0,
            "errors": 0,
        }

    def _setup_signal_handlers(self):
        """Set up signal handlers for graceful shutdown."""
        loop = asyncio.get_running_loop()

        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(
                sig,
                lambda s=sig: asyncio.create_task(self._handle_shutdown(s))
            )

        logger.info("Signal handlers configured for graceful shutdown")

    async def _handle_shutdown(self, sig: signal.Signals):
        """Handle shutdown signal."""
        logger.info(f"Received signal {sig.name}, initiating graceful shutdown...")
        self._running = False
        self._shutdown_event.set()

    async def _on_document_processed(self, result: PipelineResult):
        """Callback when a document is processed."""
        self._stats["documents_processed"] += 1

        if not result.success:
            self._stats["errors"] += 1
            logger.error(
                f"Document processing failed: {result.file_path} - {result.error}"
            )

            # Send error notification
            await self.notifier.notify_error(
                error_type="Document Processing Failed",
                error_message=result.error or "Unknown error",
                context={
                    "file": result.file_path,
                    "stage": result.error_stage,
                    "project_id": result.project_id,
                }
            )

    async def _on_project_complete(self, project_id: str):
        """Callback when a project has all required documents."""
        logger.info(f"Project {project_id} complete - triggering report assembly")

        try:
            # Assemble report
            assemble_result = await self.assembler.process(project_id)

            if not assemble_result.success:
                self._stats["errors"] += 1
                logger.error(f"Report assembly failed: {assemble_result.error}")

                await self.notifier.notify_error(
                    error_type="Report Assembly Failed",
                    error_message=assemble_result.error or "Unknown error",
                    context={"project_id": project_id}
                )
                return

            self._stats["reports_generated"] += 1
            report_path = assemble_result.data.get("report_path")
            logger.info(f"Report assembled: {report_path}")

            # Run QA check
            qa_result = await self.qa_checker.process({
                "project_id": project_id,
                "report_path": report_path
            })

            if not qa_result.success:
                self._stats["errors"] += 1
                logger.error(f"QA check failed: {qa_result.error}")
                return

            qa_data = qa_result.data

            if qa_data.get("passed"):
                self._stats["qa_passed"] += 1
                self._stats["projects_completed"] += 1
                logger.info(f"Project {project_id} passed QA!")

                # Send success notification
                await self.notifier.notify_qa_passed(
                    project_id=project_id,
                    report_path=report_path,
                    qa_details=qa_data
                )
            else:
                self._stats["qa_failed"] += 1
                logger.warning(
                    f"Project {project_id} failed QA: {qa_data.get('issues')}"
                )

                # Send failure notification
                await self.notifier.notify_qa_failed(
                    project_id=project_id,
                    report_path=report_path,
                    qa_details=qa_data
                )

        except Exception as e:
            self._stats["errors"] += 1
            logger.exception(f"Error in project completion handler: {e}")

            await self.notifier.notify_error(
                error_type="Project Completion Error",
                error_message=str(e),
                context={"project_id": project_id}
            )

    async def _check_ready_projects(self):
        """Check for projects that are ready for assembly."""
        ready_projects = self.pipeline.get_ready_projects()

        for project_info in ready_projects:
            project_id = project_info["project_id"]
            logger.info(f"Found ready project: {project_id}")
            await self._on_project_complete(project_id)

    async def run(self, duration_seconds: Optional[int] = None):
        """
        Run the daemon.

        Args:
            duration_seconds: Optional max run time (None = indefinite)
        """
        self._running = True
        self._stats["started_at"] = datetime.utcnow().isoformat()

        logger.info("=" * 60)
        logger.info("ODIC ESA Pipeline Daemon Starting")
        logger.info("=" * 60)

        # Set up signal handlers
        try:
            self._setup_signal_handlers()
        except Exception as e:
            logger.warning(f"Could not set up signal handlers: {e}")

        # Log configuration
        logger.info(f"FTP Watcher: {'Local' if self.use_local_watcher else 'SFTP'}")
        logger.info(f"LLM Configured: {self.llm_router.is_configured()}")
        logger.info(f"Notifications: {self.notifier._is_configured()}")

        start_time = datetime.now()

        try:
            # Check for any projects that are already ready
            await self._check_ready_projects()

            # Start the main pipeline
            pipeline_task = asyncio.create_task(
                self.pipeline.run(duration_seconds)
            )

            # Wait for shutdown or duration
            if duration_seconds:
                try:
                    await asyncio.wait_for(
                        self._shutdown_event.wait(),
                        timeout=duration_seconds
                    )
                except asyncio.TimeoutError:
                    logger.info("Duration limit reached")
            else:
                await self._shutdown_event.wait()

            # Stop the pipeline
            self.pipeline.stop()

            # Wait for pipeline to finish
            try:
                await asyncio.wait_for(pipeline_task, timeout=10.0)
            except asyncio.TimeoutError:
                logger.warning("Pipeline did not stop cleanly")
                pipeline_task.cancel()

        except asyncio.CancelledError:
            logger.info("Daemon cancelled")
        except Exception as e:
            logger.exception(f"Daemon error: {e}")
            self._stats["errors"] += 1
        finally:
            self._running = False
            runtime = (datetime.now() - start_time).total_seconds()

            logger.info("=" * 60)
            logger.info("ODIC ESA Pipeline Daemon Stopped")
            logger.info(f"Runtime: {runtime:.1f} seconds")
            logger.info(f"Documents processed: {self._stats['documents_processed']}")
            logger.info(f"Projects completed: {self._stats['projects_completed']}")
            logger.info(f"Reports generated: {self._stats['reports_generated']}")
            logger.info(f"QA passed: {self._stats['qa_passed']}")
            logger.info(f"QA failed: {self._stats['qa_failed']}")
            logger.info(f"Errors: {self._stats['errors']}")
            logger.info("=" * 60)

    def stop(self):
        """Stop the daemon."""
        self._running = False
        self._shutdown_event.set()

    def get_status(self) -> Dict[str, Any]:
        """Get daemon status."""
        return {
            "running": self._running,
            "stats": self._stats,
            "pipeline_status": self.pipeline.get_status(),
        }


def setup_logging(config: dict):
    """Configure logging based on config."""
    log_config = config.get("logging", {})
    level = getattr(logging, log_config.get("level", "INFO").upper())
    log_format = log_config.get("format", "text")

    if log_format == "json":
        # Simple JSON-like format
        formatter = logging.Formatter(
            '{"time": "%(asctime)s", "level": "%(levelname)s", '
            '"logger": "%(name)s", "message": "%(message)s"}'
        )
    else:
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)

    # File handler if configured
    log_file = log_config.get("file")
    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_file)
        file_handler.setFormatter(formatter)
        root_logger.addHandler(file_handler)


async def run_daemon(
    config_path: str = "./config/config.yaml",
    use_local_watcher: bool = False,
    duration_seconds: Optional[int] = None
):
    """
    Run the daemon with configuration from file.

    Args:
        config_path: Path to configuration file
        use_local_watcher: Use local directory instead of FTP
        duration_seconds: Optional run duration
    """
    # Load config
    config_file = Path(config_path)
    if not config_file.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_file) as f:
        config = yaml.safe_load(f)

    # Set up logging
    setup_logging(config)

    # Create and run daemon
    daemon = Daemon(config, use_local_watcher=use_local_watcher)
    await daemon.run(duration_seconds)

#!/usr/bin/env python3
"""
ODIC ESA Pipeline - Main Entry Point

CLI for running the ESA document processing pipeline.

Usage:
    python main.py --daemon                    # Run continuously
    python main.py --process-folder ./pdfs     # Process a folder of PDFs
    python main.py --status                    # Show pipeline status
    python main.py --process-project PROJ-001  # Assemble specific project
"""

import argparse
from dotenv import load_dotenv

# Load .env file if it exists
load_dotenv()
import asyncio
import sys
import json
from pathlib import Path
from typing import Optional

import yaml

# Add project to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from core.daemon import Daemon, run_daemon, setup_logging
from core.state import StateManager, ProjectStatus
from core.pipeline import Pipeline
from skills.document_classifier import DocumentClassifier
from skills.file_organizer import FileOrganizer
from skills.report_assembler import ReportAssembler
from skills.qa_checker import QAChecker


def load_config(config_path: str) -> dict:
    """Load configuration from YAML file."""
    config_file = Path(config_path)
    if not config_file.exists():
        print(f"Error: Config file not found: {config_path}")
        sys.exit(1)

    with open(config_file) as f:
        return yaml.safe_load(f)


async def run_daemon_mode(config: dict, duration: Optional[int] = None):
    """Run the pipeline in daemon mode."""
    print("Starting ODIC ESA Pipeline Daemon...")
    print("Press Ctrl+C to stop")
    print()

    daemon = Daemon(config, use_local_watcher=True)
    await daemon.run(duration)


async def process_folder(config: dict, folder_path: str):
    """Process all PDFs in a folder."""
    folder = Path(folder_path)
    if not folder.exists():
        print(f"Error: Folder not found: {folder_path}")
        sys.exit(1)

    pdfs = list(folder.glob("*.pdf"))
    if not pdfs:
        print(f"No PDF files found in: {folder_path}")
        sys.exit(1)

    print(f"Found {len(pdfs)} PDF files to process")
    print()

    # Initialize pipeline
    state_manager = StateManager(config.get("state_db", "./pipeline_state.db"))
    pipeline = Pipeline(config, state_manager=state_manager, use_local_watcher=True)

    # Process each PDF
    results = await pipeline.process_batch([str(p) for p in pdfs])

    # Print results
    successful = sum(1 for r in results if r.success)
    failed = len(results) - successful

    print()
    print("=" * 60)
    print(f"Processing Complete")
    print(f"  Successful: {successful}")
    print(f"  Failed: {failed}")
    print("=" * 60)

    # Print details
    for result in results:
        status = "✓" if result.success else "✗"
        file_name = Path(result.file_path).name
        print(f"  {status} {file_name}")
        if result.success:
            print(f"      Type: {result.document_type}")
            print(f"      Project: {result.project_id or 'Unassigned'}")
        else:
            print(f"      Error: {result.error}")

    # Check for complete projects
    ready_projects = pipeline.get_ready_projects()
    if ready_projects:
        print()
        print(f"Projects ready for assembly: {len(ready_projects)}")
        for proj in ready_projects:
            print(f"  - {proj['project_id']} ({proj['document_count']} documents)")


async def process_project(config: dict, project_id: str):
    """Assemble and QA a specific project."""
    print(f"Processing project: {project_id}")
    print()

    # Initialize components
    state_manager = StateManager(config.get("state_db", "./pipeline_state.db"))
    assembler = ReportAssembler(config, state_manager=state_manager)
    qa_checker = QAChecker(config, state_manager=state_manager)

    # Assemble report
    print("Assembling report...")
    assemble_result = await assembler.process(project_id)

    if not assemble_result.success:
        print(f"Error: Assembly failed - {assemble_result.error}")
        sys.exit(1)

    print(f"  Report: {assemble_result.data.get('report_path')}")
    print(f"  Pages: {assemble_result.data.get('total_pages')}")
    print(f"  Documents: {assemble_result.data.get('documents_included')}")
    print()

    # Run QA
    print("Running QA check...")
    qa_result = await qa_checker.process({
        "project_id": project_id,
        "report_path": assemble_result.data.get("report_path")
    })

    if not qa_result.success:
        print(f"Error: QA check failed - {qa_result.error}")
        sys.exit(1)

    qa_data = qa_result.data
    status = "PASSED ✓" if qa_data.get("passed") else "FAILED ✗"
    print(f"  Status: {status}")
    print(f"  Score: {qa_data.get('score', 0):.2f}")

    if qa_data.get("issues"):
        print("  Issues:")
        for issue in qa_data["issues"]:
            print(f"    - {issue}")

    if qa_data.get("warnings"):
        print("  Warnings:")
        for warning in qa_data["warnings"]:
            print(f"    - {warning}")

    if qa_data.get("recommendations"):
        print("  Recommendations:")
        for rec in qa_data["recommendations"]:
            print(f"    - {rec}")


def show_status(config: dict):
    """Show current pipeline status."""
    state_manager = StateManager(config.get("state_db", "./pipeline_state.db"))
    stats = state_manager.get_stats()

    print()
    print("=" * 60)
    print("ODIC ESA Pipeline Status")
    print("=" * 60)
    print()

    # Document stats
    print("Documents:")
    print(f"  Total tracked: {stats['total_documents']}")
    doc_status = stats.get("documents_by_status", {})
    for status, count in doc_status.items():
        print(f"    {status}: {count}")

    print()

    # Project stats
    print("Projects:")
    print(f"  Total: {stats['total_projects']}")
    proj_status = stats.get("projects_by_status", {})
    for status, count in proj_status.items():
        print(f"    {status}: {count}")

    print()

    # Pending documents
    pending = state_manager.get_pending_documents()
    if pending:
        print(f"Pending Documents ({len(pending)}):")
        for doc in pending[:10]:
            print(f"  - {doc.original_filename}")
        if len(pending) > 10:
            print(f"  ... and {len(pending) - 10} more")
        print()

    # Failed documents
    failed = state_manager.get_failed_documents()
    if failed:
        print(f"Failed Documents ({len(failed)}):")
        for doc in failed[:5]:
            print(f"  - {doc.original_filename}: {doc.error_message}")
        if len(failed) > 5:
            print(f"  ... and {len(failed) - 5} more")
        print()

    # Manual review
    review = state_manager.get_documents_needing_review()
    if review:
        print(f"Documents Needing Review ({len(review)}):")
        for doc in review[:5]:
            print(f"  - {doc.original_filename} ({doc.document_type})")
        print()

    # Ready projects
    ready = state_manager.get_projects_by_status(ProjectStatus.READY)
    if ready:
        print(f"Projects Ready for Assembly ({len(ready)}):")
        for proj in ready:
            print(f"  - {proj.project_id} ({proj.document_count} documents)")
        print()

    # Completed projects
    complete = state_manager.get_projects_by_status(ProjectStatus.COMPLETE)
    if complete:
        print(f"Completed Projects ({len(complete)}):")
        for proj in complete[:5]:
            print(f"  - {proj.project_id}: {proj.report_path}")
        print()

    print("=" * 60)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="ODIC ESA Pipeline - Document Processing and Report Generation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py --daemon                    Run pipeline continuously
  python main.py --process-folder ./pdfs     Process PDFs in folder
  python main.py --process-project ODIC-2024-001  Assemble specific project
  python main.py --status                    Show pipeline status
        """
    )

    parser.add_argument(
        "--config", "-c",
        default="./config/config.yaml",
        help="Path to config file (default: ./config/config.yaml)"
    )

    parser.add_argument(
        "--daemon", "-d",
        action="store_true",
        help="Run as daemon (continuous processing)"
    )

    parser.add_argument(
        "--duration",
        type=int,
        default=None,
        help="Max run time in seconds (daemon mode only)"
    )

    parser.add_argument(
        "--process-folder", "-f",
        metavar="PATH",
        help="Process all PDFs in a folder"
    )

    parser.add_argument(
        "--process-project", "-p",
        metavar="PROJECT_ID",
        help="Assemble and QA a specific project"
    )

    parser.add_argument(
        "--status", "-s",
        action="store_true",
        help="Show current pipeline status"
    )

    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Verbose output"
    )

    args = parser.parse_args()

    # Load config
    config = load_config(args.config)

    # Set up logging
    if args.verbose:
        config.setdefault("logging", {})["level"] = "DEBUG"
    setup_logging(config)

    # Execute command
    if args.status:
        show_status(config)

    elif args.daemon:
        asyncio.run(run_daemon_mode(config, args.duration))

    elif args.process_folder:
        asyncio.run(process_folder(config, args.process_folder))

    elif args.process_project:
        asyncio.run(process_project(config, args.process_project))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()

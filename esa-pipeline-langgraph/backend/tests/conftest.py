"""
Pytest configuration and fixtures for ESA Pipeline tests.
"""

import os
import sys
import pytest
import tempfile
import shutil
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from state import (
    ReportState,
    IngestedFile,
    Classification,
    ClassifiedDocument,
    DocumentCategory,
    PipelineStage,
    create_initial_state,
)


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    temp = tempfile.mkdtemp()
    yield temp
    shutil.rmtree(temp)


@pytest.fixture
def sample_project_state() -> ReportState:
    """Create a sample project state for testing."""
    return create_initial_state(
        project_id="TEST-2024-001",
        project_address="123 Test Street, Test City, TS 12345",
        report_type="phase_1",
        client_name="Test Corporation",
    )


@pytest.fixture
def sample_ingested_file() -> IngestedFile:
    """Create a sample ingested file for testing."""
    return IngestedFile(
        id="test-file-001",
        original_filename="executive_summary.pdf",
        format="pdf",
        page_count=5,
        size_bytes=102400,
        text_content="EXECUTIVE SUMMARY\n\nThis Phase I Environmental Site Assessment...",
        ocr_confidence=None,
        content_hash="abc123def456",
        metadata={"project_id": "TEST-2024-001"},
        file_path="/tmp/test/executive_summary.pdf",
    )


@pytest.fixture
def sample_classification() -> Classification:
    """Create a sample classification for testing."""
    return Classification(
        category=DocumentCategory.MAIN_BODY,
        section="executive_summary",
        appendix_letter=None,
        confidence=0.95,
        flags=[],
        reasoning="Document contains executive summary content",
    )


@pytest.fixture
def sample_classified_document(sample_ingested_file, sample_classification) -> ClassifiedDocument:
    """Create a sample classified document for testing."""
    return ClassifiedDocument(
        file=sample_ingested_file,
        classification=sample_classification,
        needs_review=False,
    )


@pytest.fixture
def sample_files_for_assembly(temp_dir) -> list:
    """Create sample PDF files for assembly testing."""
    # This would create actual test PDF files
    # For now, return empty list - real tests would use fixtures
    return []


@pytest.fixture
def mock_llm_response():
    """Mock LLM response for classification."""
    return {
        "category": "main_body",
        "section": "executive_summary",
        "appendix_letter": None,
        "confidence": 0.92,
        "reasoning": "Document contains Phase I ESA executive summary",
        "flags": [],
    }


@pytest.fixture(autouse=True)
def set_test_env(temp_dir, monkeypatch):
    """Set environment variables for testing."""
    monkeypatch.setenv("UPLOAD_DIR", os.path.join(temp_dir, "uploads"))
    monkeypatch.setenv("OUTPUT_DIR", os.path.join(temp_dir, "output"))
    monkeypatch.setenv("EXPORT_DIR", os.path.join(temp_dir, "exports"))

    # Create directories
    for subdir in ["uploads", "output", "exports"]:
        os.makedirs(os.path.join(temp_dir, subdir), exist_ok=True)

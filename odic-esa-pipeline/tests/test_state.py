"""
ODIC ESA Pipeline - State Manager Tests

Tests for SQLite-based state tracking with idempotency.
"""

import os
import sys
import tempfile
import pytest
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.state import (
    StateManager,
    DocumentStatus,
    ProjectStatus,
    DocumentRecord,
    ProjectRecord,
)


@pytest.fixture
def temp_db():
    """Create a temporary database file."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    yield db_path
    # Cleanup
    if os.path.exists(db_path):
        os.unlink(db_path)


@pytest.fixture
def state_manager(temp_db):
    """Create a StateManager with temporary database."""
    return StateManager(temp_db)


@pytest.fixture
def sample_pdf(tmp_path):
    """Create a sample PDF file for testing."""
    pdf_path = tmp_path / "test_document.pdf"
    # Create minimal PDF-like content
    pdf_path.write_bytes(b"%PDF-1.4\ntest content\n%%EOF")
    return str(pdf_path)


@pytest.fixture
def sample_pdf_2(tmp_path):
    """Create a second sample PDF file with different content."""
    pdf_path = tmp_path / "test_document_2.pdf"
    pdf_path.write_bytes(b"%PDF-1.4\ndifferent content\n%%EOF")
    return str(pdf_path)


class TestStateManagerInitialization:
    """Test StateManager initialization."""

    def test_creates_database(self, temp_db):
        """Test that database file is created."""
        manager = StateManager(temp_db)
        assert os.path.exists(temp_db)

    def test_creates_tables(self, state_manager, temp_db):
        """Test that required tables are created."""
        import sqlite3

        conn = sqlite3.connect(temp_db)
        cursor = conn.cursor()

        # Check for documents table
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'"
        )
        assert cursor.fetchone() is not None

        # Check for projects table
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'"
        )
        assert cursor.fetchone() is not None

        # Check for processing_log table
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='processing_log'"
        )
        assert cursor.fetchone() is not None

        conn.close()

    def test_creates_parent_directory(self, tmp_path):
        """Test that parent directories are created."""
        db_path = tmp_path / "subdir" / "nested" / "state.db"
        manager = StateManager(str(db_path))
        assert db_path.exists()


class TestFileHashing:
    """Test file hash computation."""

    def test_compute_file_hash(self, state_manager, sample_pdf):
        """Test file hash computation."""
        hash1 = state_manager.compute_file_hash(sample_pdf)

        # Hash should be hex string
        assert len(hash1) == 64  # SHA-256 produces 64 hex chars
        assert all(c in "0123456789abcdef" for c in hash1)

    def test_same_file_same_hash(self, state_manager, sample_pdf):
        """Test that same file produces same hash."""
        hash1 = state_manager.compute_file_hash(sample_pdf)
        hash2 = state_manager.compute_file_hash(sample_pdf)
        assert hash1 == hash2

    def test_different_files_different_hash(
        self, state_manager, sample_pdf, sample_pdf_2
    ):
        """Test that different files produce different hashes."""
        hash1 = state_manager.compute_file_hash(sample_pdf)
        hash2 = state_manager.compute_file_hash(sample_pdf_2)
        assert hash1 != hash2


class TestDocumentTracking:
    """Test document tracking functionality."""

    def test_add_document(self, state_manager, sample_pdf):
        """Test adding a new document."""
        record = state_manager.add_document(sample_pdf)

        assert record is not None
        assert record.original_filename == "test_document.pdf"
        assert record.status == DocumentStatus.PENDING.value
        assert record.file_hash is not None

    def test_add_document_idempotent(self, state_manager, sample_pdf):
        """Test that adding same document twice returns None (idempotent)."""
        record1 = state_manager.add_document(sample_pdf)
        record2 = state_manager.add_document(sample_pdf)

        assert record1 is not None
        assert record2 is None  # Already exists

    def test_is_document_processed(self, state_manager, sample_pdf, sample_pdf_2):
        """Test checking if document has been processed."""
        # Initially not processed
        assert state_manager.is_document_processed(sample_pdf) is False

        # Add document
        state_manager.add_document(sample_pdf)

        # Now should be processed
        assert state_manager.is_document_processed(sample_pdf) is True

        # Different file should not be processed
        assert state_manager.is_document_processed(sample_pdf_2) is False

    def test_get_document_by_hash(self, state_manager, sample_pdf):
        """Test retrieving document by hash."""
        state_manager.add_document(sample_pdf)
        file_hash = state_manager.compute_file_hash(sample_pdf)

        record = state_manager.get_document_by_hash(file_hash)
        assert record is not None
        assert record.original_filename == "test_document.pdf"

    def test_get_document_by_path(self, state_manager, sample_pdf):
        """Test retrieving document by path."""
        state_manager.add_document(sample_pdf)

        record = state_manager.get_document_by_path(sample_pdf)
        assert record is not None
        assert record.original_filename == "test_document.pdf"

    def test_update_document_classification(self, state_manager, sample_pdf):
        """Test updating document with classification results."""
        state_manager.add_document(sample_pdf)

        success = state_manager.update_document_classification(
            file_path=sample_pdf,
            document_type="edr",
            confidence=0.95,
            project_id="ODIC-2024-001",
            requires_manual_review=False,
            metadata={"date": "2024-01-15", "location": "123 Main St"},
        )

        assert success is True

        # Verify update
        record = state_manager.get_document_by_path(sample_pdf)
        assert record.document_type == "edr"
        assert record.confidence == 0.95
        assert record.project_id == "ODIC-2024-001"
        assert record.status == DocumentStatus.CLASSIFIED.value

    def test_update_classification_manual_review(self, state_manager, sample_pdf):
        """Test that low confidence triggers manual review status."""
        state_manager.add_document(sample_pdf)

        state_manager.update_document_classification(
            file_path=sample_pdf,
            document_type="other",
            confidence=0.5,
            project_id=None,
            requires_manual_review=True,
            metadata={},
        )

        record = state_manager.get_document_by_path(sample_pdf)
        assert record.status == DocumentStatus.MANUAL_REVIEW.value
        assert record.requires_manual_review is True

    def test_update_document_organized(self, state_manager, sample_pdf):
        """Test updating document after organization."""
        state_manager.add_document(sample_pdf)

        new_path = "/projects/ODIC-2024-001/regulatory/edr/test_document.pdf"
        success = state_manager.update_document_organized(
            sample_pdf, new_path, "ODIC-2024-001"
        )

        assert success is True

        record = state_manager.get_document_by_path(sample_pdf)
        assert record.current_path == new_path
        assert record.project_id == "ODIC-2024-001"
        assert record.status == DocumentStatus.ORGANIZED.value

    def test_mark_document_failed(self, state_manager, sample_pdf):
        """Test marking document as failed."""
        state_manager.add_document(sample_pdf)

        success = state_manager.mark_document_failed(
            sample_pdf, "Classification failed: API error"
        )

        assert success is True

        record = state_manager.get_document_by_path(sample_pdf)
        assert record.status == DocumentStatus.FAILED.value
        assert "API error" in record.error_message


class TestProjectTracking:
    """Test project tracking functionality."""

    def test_get_or_create_project_new(self, state_manager):
        """Test creating a new project."""
        project = state_manager.get_or_create_project(
            "ODIC-2024-001",
            required_documents=["edr", "topographic_map", "site_photograph"],
        )

        assert project is not None
        assert project.project_id == "ODIC-2024-001"
        assert project.status == ProjectStatus.INCOMPLETE.value

    def test_get_or_create_project_existing(self, state_manager):
        """Test getting existing project."""
        project1 = state_manager.get_or_create_project("ODIC-2024-001")
        project2 = state_manager.get_or_create_project("ODIC-2024-001")

        assert project1.project_id == project2.project_id
        # Should be same record
        assert project1.id == project2.id

    def test_update_project_documents(self, state_manager, sample_pdf, sample_pdf_2):
        """Test updating project document count."""
        project_id = "ODIC-2024-001"
        state_manager.get_or_create_project(project_id)

        # Add and organize documents
        state_manager.add_document(sample_pdf)
        state_manager.update_document_classification(
            sample_pdf, "edr", 0.95, project_id, False, {}
        )
        state_manager.update_document_organized(sample_pdf, "/new/path.pdf", project_id)

        # Update project
        project = state_manager.update_project_documents(project_id)
        assert project.document_count == 1

    def test_check_project_completeness(self, state_manager, sample_pdf, sample_pdf_2):
        """Test checking project completeness."""
        project_id = "ODIC-2024-001"
        required = ["edr", "topographic_map"]

        # Create project and add one document
        state_manager.get_or_create_project(project_id)
        state_manager.add_document(sample_pdf)
        state_manager.update_document_classification(
            sample_pdf, "edr", 0.95, project_id, False, {}
        )
        state_manager.update_document_organized(sample_pdf, "/new/path.pdf", project_id)

        # Check completeness
        result = state_manager.check_project_completeness(project_id, required)

        assert result["complete"] is False
        assert "edr" in result["present"]
        assert "topographic_map" in result["missing"]

    def test_set_project_status(self, state_manager):
        """Test setting project status."""
        project_id = "ODIC-2024-001"
        state_manager.get_or_create_project(project_id)

        success = state_manager.set_project_status(project_id, ProjectStatus.READY)
        assert success is True

        project = state_manager.get_or_create_project(project_id)
        assert project.status == ProjectStatus.READY.value

    def test_set_project_report_path(self, state_manager):
        """Test setting completed report path."""
        project_id = "ODIC-2024-001"
        state_manager.get_or_create_project(project_id)

        report_path = "/completed_reports/ODIC-2024-001_ESA.pdf"
        success = state_manager.set_project_report_path(project_id, report_path)

        assert success is True

        project = state_manager.get_or_create_project(project_id)
        assert project.report_path == report_path
        assert project.status == ProjectStatus.COMPLETE.value


class TestQueryMethods:
    """Test query methods."""

    def test_get_pending_documents(self, state_manager, sample_pdf, sample_pdf_2):
        """Test getting pending documents."""
        state_manager.add_document(sample_pdf)
        state_manager.add_document(sample_pdf_2)

        pending = state_manager.get_pending_documents()
        assert len(pending) == 2

        # Classify one
        state_manager.update_document_classification(
            sample_pdf, "edr", 0.95, "ODIC-2024-001", False, {}
        )

        pending = state_manager.get_pending_documents()
        assert len(pending) == 1

    def test_get_documents_for_project(self, state_manager, sample_pdf, sample_pdf_2):
        """Test getting documents for a project."""
        project_id = "ODIC-2024-001"

        state_manager.add_document(sample_pdf)
        state_manager.add_document(sample_pdf_2)

        state_manager.update_document_classification(
            sample_pdf, "edr", 0.95, project_id, False, {}
        )
        state_manager.update_document_classification(
            sample_pdf_2, "topographic_map", 0.92, "OTHER-PROJECT", False, {}
        )

        docs = state_manager.get_documents_for_project(project_id)
        assert len(docs) == 1
        assert docs[0].document_type == "edr"

    def test_get_projects_by_status(self, state_manager):
        """Test getting projects by status."""
        state_manager.get_or_create_project("ODIC-2024-001")
        state_manager.get_or_create_project("ODIC-2024-002")
        state_manager.set_project_status("ODIC-2024-002", ProjectStatus.READY)

        incomplete = state_manager.get_projects_by_status(ProjectStatus.INCOMPLETE)
        ready = state_manager.get_projects_by_status(ProjectStatus.READY)

        assert len(incomplete) == 1
        assert len(ready) == 1
        assert incomplete[0].project_id == "ODIC-2024-001"
        assert ready[0].project_id == "ODIC-2024-002"

    def test_get_documents_needing_review(self, state_manager, sample_pdf):
        """Test getting documents flagged for manual review."""
        state_manager.add_document(sample_pdf)
        state_manager.update_document_classification(
            sample_pdf, "other", 0.5, None, True, {}
        )

        review_docs = state_manager.get_documents_needing_review()
        assert len(review_docs) == 1
        assert review_docs[0].requires_manual_review is True

    def test_get_failed_documents(self, state_manager, sample_pdf):
        """Test getting failed documents."""
        state_manager.add_document(sample_pdf)
        state_manager.mark_document_failed(sample_pdf, "Test error")

        failed = state_manager.get_failed_documents()
        assert len(failed) == 1
        assert failed[0].status == DocumentStatus.FAILED.value


class TestProcessingLog:
    """Test processing log functionality."""

    def test_log_entries_created(self, state_manager, sample_pdf):
        """Test that processing actions create log entries."""
        state_manager.add_document(sample_pdf)

        log = state_manager.get_processing_log()
        assert len(log) > 0
        assert any(entry["action"] == "document_added" for entry in log)

    def test_get_processing_log_by_project(self, state_manager, sample_pdf):
        """Test filtering log by project."""
        project_id = "ODIC-2024-001"
        state_manager.add_document(sample_pdf)
        state_manager.update_document_classification(
            sample_pdf, "edr", 0.95, project_id, False, {}
        )

        log = state_manager.get_processing_log(project_id=project_id)
        assert len(log) > 0
        assert all(
            entry["project_id"] == project_id or entry["project_id"] is None
            for entry in log
        )


class TestStatistics:
    """Test statistics gathering."""

    def test_get_stats(self, state_manager, sample_pdf, sample_pdf_2):
        """Test getting pipeline statistics."""
        # Add some data
        state_manager.add_document(sample_pdf)
        state_manager.add_document(sample_pdf_2)
        state_manager.get_or_create_project("ODIC-2024-001")

        stats = state_manager.get_stats()

        assert stats["total_documents"] == 2
        assert stats["total_projects"] == 1
        assert "documents_by_status" in stats
        assert "projects_by_status" in stats


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

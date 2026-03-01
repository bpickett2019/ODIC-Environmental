"""
Tests for the state module.
"""

import pytest
from state import (
    ReportState,
    IngestedFile,
    Classification,
    ClassifiedDocument,
    DocumentCategory,
    PipelineStage,
    QCSeverity,
    QCIssue,
    create_initial_state,
    log_action,
)


class TestCreateInitialState:
    """Tests for create_initial_state function."""

    def test_creates_valid_state(self):
        """Test that create_initial_state returns valid ReportState."""
        state = create_initial_state(
            project_id="TEST-001",
            project_address="123 Main St",
            report_type="phase_1",
            client_name="Test Client",
        )

        assert state["project_id"] == "TEST-001"
        assert state["project_address"] == "123 Main St"
        assert state["report_type"] == "phase_1"
        assert state["client_name"] == "Test Client"
        assert state["current_stage"] == PipelineStage.INGEST
        assert state["files"] == []
        assert state["ingest_complete"] is False
        assert state["pipeline_failed"] is False
        assert state["max_remediations"] == 3

    def test_defaults_to_phase_1(self):
        """Test that report_type defaults to phase_1."""
        state = create_initial_state(
            project_id="TEST-001",
            project_address="123 Main St",
        )
        assert state["report_type"] == "phase_1"

    def test_empty_client_name(self):
        """Test that client_name defaults to empty string."""
        state = create_initial_state(
            project_id="TEST-001",
            project_address="123 Main St",
        )
        assert state["client_name"] == ""


class TestLogAction:
    """Tests for log_action function."""

    def test_creates_log_entry(self, sample_project_state):
        """Test that log_action creates proper log entry."""
        entry = log_action(sample_project_state, "test_action", {"key": "value"})

        assert "timestamp" in entry
        assert entry["action"] == "test_action"
        assert entry["details"] == {"key": "value"}
        assert entry["project_id"] == "TEST-2024-001"

    def test_log_entry_without_details(self, sample_project_state):
        """Test log_action with no details."""
        entry = log_action(sample_project_state, "simple_action")

        assert entry["details"] == {}


class TestIngestedFile:
    """Tests for IngestedFile dataclass."""

    def test_creates_ingested_file(self):
        """Test IngestedFile creation."""
        file = IngestedFile(
            id="test-123",
            original_filename="test.pdf",
            format="pdf",
            page_count=10,
            size_bytes=50000,
            text_content="Test content",
            content_hash="hash123",
        )

        assert file.id == "test-123"
        assert file.page_count == 10
        assert file.ocr_confidence is None
        assert file.metadata == {}

    def test_optional_fields(self):
        """Test optional fields have correct defaults."""
        file = IngestedFile(
            id="test",
            original_filename="test.pdf",
            format="pdf",
            page_count=1,
            size_bytes=1000,
            text_content="",
        )

        assert file.ocr_confidence is None
        assert file.content_hash == ""
        assert file.file_path == ""


class TestClassification:
    """Tests for Classification dataclass."""

    def test_creates_classification(self):
        """Test Classification creation."""
        classification = Classification(
            category=DocumentCategory.MAIN_BODY,
            section="executive_summary",
            confidence=0.95,
        )

        assert classification.category == DocumentCategory.MAIN_BODY
        assert classification.section == "executive_summary"
        assert classification.confidence == 0.95
        assert classification.flags == []

    def test_appendix_classification(self):
        """Test appendix classification with letter."""
        classification = Classification(
            category=DocumentCategory.APPENDIX,
            section="appendix_a_site_plans_maps",
            appendix_letter="A",
            confidence=0.88,
        )

        assert classification.appendix_letter == "A"


class TestQCIssue:
    """Tests for QCIssue dataclass."""

    def test_creates_qc_issue(self):
        """Test QCIssue creation."""
        issue = QCIssue(
            agent="completeness",
            severity=QCSeverity.CRITICAL,
            description="Missing executive summary",
            location="Section 1",
        )

        assert issue.agent == "completeness"
        assert issue.severity == QCSeverity.CRITICAL
        assert issue.auto_fixable is False
        assert issue.fixed is False

    def test_auto_fixable_issue(self):
        """Test auto-fixable QC issue."""
        issue = QCIssue(
            agent="structure",
            severity=QCSeverity.WARNING,
            description="TOC needs update",
            location="Table of Contents",
            auto_fixable=True,
            suggested_fix="Regenerate TOC",
        )

        assert issue.auto_fixable is True
        assert issue.suggested_fix == "Regenerate TOC"


class TestDocumentCategory:
    """Tests for DocumentCategory enum."""

    def test_all_categories_exist(self):
        """Test all expected categories exist."""
        assert DocumentCategory.MAIN_BODY.value == "main_body"
        assert DocumentCategory.APPENDIX.value == "appendix"
        assert DocumentCategory.SUPPORTING_RECORD.value == "supporting_record"
        assert DocumentCategory.EXCLUDED.value == "excluded"


class TestPipelineStage:
    """Tests for PipelineStage enum."""

    def test_all_stages_exist(self):
        """Test all expected pipeline stages exist."""
        stages = [
            PipelineStage.INGEST,
            PipelineStage.CLASSIFY,
            PipelineStage.STRUCTURE,
            PipelineStage.ASSEMBLE,
            PipelineStage.QC,
            PipelineStage.EXPORT,
        ]
        assert len(stages) == 6

    def test_stage_values(self):
        """Test stage value strings."""
        assert PipelineStage.INGEST.value == "ingest"
        assert PipelineStage.QC.value == "qc"

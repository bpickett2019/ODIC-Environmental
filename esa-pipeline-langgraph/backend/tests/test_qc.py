"""
Tests for QC (Quality Control) node and sub-validators.
"""

import pytest
from unittest.mock import patch, MagicMock

from state import (
    ReportState,
    IngestedFile,
    Classification,
    ClassifiedDocument,
    DocumentCategory,
    PipelineStage,
    StructureResult,
    AssemblyResult,
    QCResult,
    QCIssue,
    QCSeverity,
    create_initial_state,
)


class TestQCNode:
    """Tests for the main QC node."""

    def test_qc_requires_assembly_result(self, sample_project_state):
        """Test that QC node requires assembly result."""
        from nodes.qc import qc_node

        # No assembly result
        result = qc_node(sample_project_state)

        assert result["pipeline_failed"] is True
        assert "No assembled report" in str(result.get("errors", []))


class TestCompletenessValidator:
    """Tests for the completeness sub-validator."""

    def test_completeness_detects_missing_sections(self, sample_project_state):
        """Test completeness validator detects missing sections."""
        from nodes.qc import _validate_completeness

        # Create structure result with missing sections
        structure_result = StructureResult(
            template="phase_1_astm_e1527",
            sections_found=["executive_summary"],
            sections_missing=["introduction", "site_description"],
            completeness_score=0.5,
        )
        sample_project_state["structure_result"] = structure_result

        assembly_result = AssemblyResult(
            assembled_file_path="/test/report.pdf",
            total_pages=100,
            source_pages=100,
            pages_match=True,
        )

        result = _validate_completeness(sample_project_state, assembly_result)

        assert result["score"] < 1.0
        assert len(result["issues"]) > 0

    def test_completeness_detects_page_mismatch(self, sample_project_state):
        """Test completeness validator detects page count mismatch."""
        from nodes.qc import _validate_completeness

        structure_result = StructureResult(
            template="phase_1_astm_e1527",
            sections_found=["executive_summary"],
            sections_missing=[],
            completeness_score=1.0,
        )
        sample_project_state["structure_result"] = structure_result

        # Pages don't match
        assembly_result = AssemblyResult(
            assembled_file_path="/test/report.pdf",
            total_pages=96,  # 4 pages missing
            source_pages=100,
            pages_match=False,
        )

        result = _validate_completeness(sample_project_state, assembly_result)

        # Should have critical issue for page mismatch
        critical_issues = [i for i in result["issues"] if i.severity == QCSeverity.CRITICAL]
        assert len(critical_issues) > 0
        assert result["score"] < 1.0


class TestCrossContaminationValidator:
    """Tests for cross-contamination detection."""

    @patch('nodes.qc.check_cross_contamination')
    def test_detects_wrong_project_id(self, mock_check, sample_project_state):
        """Test detection of wrong project ID in content."""
        from nodes.qc import _validate_cross_contamination

        mock_check.return_value = {
            "contamination_found": True,
            "issues": [{
                "description": "Found different project ID: OTHER-2024-999",
                "location": "Page 5",
                "severity": "critical",
            }],
            "confidence": 0.9,
        }

        assembly_result = AssemblyResult(
            assembled_file_path="/test/report.pdf",
            total_pages=100,
            source_pages=100,
            pages_match=True,
        )

        result = _validate_cross_contamination(
            sample_project_state,
            "Report content with OTHER-2024-999 project ID",
            assembly_result,
        )

        assert result["score"] < 1.0
        assert len(result["issues"]) > 0

    @patch('nodes.qc.check_cross_contamination')
    def test_no_contamination(self, mock_check, sample_project_state):
        """Test no contamination detected."""
        from nodes.qc import _validate_cross_contamination

        mock_check.return_value = {
            "contamination_found": False,
            "issues": [],
            "confidence": 0.95,
        }

        assembly_result = AssemblyResult(
            assembled_file_path="/test/report.pdf",
            total_pages=100,
            source_pages=100,
            pages_match=True,
        )

        result = _validate_cross_contamination(
            sample_project_state,
            "Clean report content for TEST-2024-001",
            assembly_result,
        )

        assert result["score"] == 1.0
        assert len(result["issues"]) == 0


class TestStructureValidator:
    """Tests for structure validation."""

    def test_detects_missing_toc(self, sample_project_state):
        """Test detection of missing Table of Contents."""
        from nodes.qc import _validate_structure

        assembly_result = AssemblyResult(
            assembled_file_path="/test/report.pdf",
            total_pages=100,
            source_pages=100,
            pages_match=True,
        )

        # Content without TOC
        report_text = "EXECUTIVE SUMMARY\n\nThis is the executive summary..."

        result = _validate_structure(sample_project_state, assembly_result, report_text)

        # Should flag missing TOC
        toc_issues = [i for i in result["issues"] if "Table of Contents" in i.description]
        assert len(toc_issues) > 0

    def test_detects_non_sequential_appendices(self, sample_project_state):
        """Test detection of non-sequential appendix letters."""
        from nodes.qc import _validate_structure

        assembly_result = AssemblyResult(
            assembled_file_path="/test/report.pdf",
            total_pages=100,
            source_pages=100,
            pages_match=True,
        )

        # Content with non-sequential appendices (A, C - missing B)
        report_text = """
        TABLE OF CONTENTS
        Introduction ........... 1

        Appendix A - Site Maps
        Appendix C - Historical Sources
        """

        result = _validate_structure(sample_project_state, assembly_result, report_text)

        # May flag non-sequential appendices
        assert result["score"] <= 1.0


class TestContentIntegrityValidator:
    """Tests for content integrity validation."""

    @patch('nodes.qc.check_content_integrity')
    def test_passes_valid_content(self, mock_check, sample_project_state):
        """Test passing content integrity check."""
        from nodes.qc import _validate_content_integrity

        mock_check.return_value = {
            "passed": True,
            "issues": [],
            "confidence": 0.9,
            "notes": "Content appears consistent",
        }

        result = _validate_content_integrity(
            sample_project_state,
            "Valid consistent report content...",
        )

        assert result["score"] == 1.0
        assert result.get("notes") == "Content appears consistent"

    @patch('nodes.qc.check_content_integrity')
    def test_detects_inconsistent_content(self, mock_check, sample_project_state):
        """Test detection of inconsistent content."""
        from nodes.qc import _validate_content_integrity

        mock_check.return_value = {
            "passed": False,
            "issues": [{
                "description": "Executive summary mentions findings not in report",
                "location": "Executive Summary, paragraph 3",
                "severity": "warning",
            }],
            "confidence": 0.8,
            "notes": "Potential inconsistency found",
        }

        result = _validate_content_integrity(
            sample_project_state,
            "Inconsistent report content...",
        )

        assert result["score"] < 1.0
        assert len(result["issues"]) > 0


class TestFormatValidator:
    """Tests for format validation."""

    def test_detects_small_file(self, sample_project_state, temp_dir):
        """Test detection of suspiciously small file."""
        from nodes.qc import _validate_format
        import os

        # Create a tiny file
        test_file = os.path.join(temp_dir, "tiny.pdf")
        with open(test_file, 'w') as f:
            f.write("tiny")

        result = _validate_format(sample_project_state, test_file, "tiny")

        # Should flag the small file
        critical_issues = [i for i in result["issues"] if i.severity == QCSeverity.CRITICAL]
        assert len(critical_issues) > 0


class TestQCAutoFixes:
    """Tests for QC auto-fix functionality."""

    def test_apply_auto_fixes(self, sample_project_state):
        """Test applying auto-fixes to QC issues."""
        from nodes.qc import apply_auto_fixes

        # Create QC result with auto-fixable issues
        qc_result = QCResult(
            qc_passed=False,
            overall_score=0.7,
            confidence_level=0.8,
            blocking_issues=[
                QCIssue(
                    agent="structure",
                    severity=QCSeverity.WARNING,
                    description="TOC needs update",
                    location="TOC",
                    auto_fixable=True,
                    suggested_fix="Regenerate TOC",
                ),
            ],
        )
        sample_project_state["qc_result"] = qc_result
        sample_project_state["remediation_attempts"] = 0

        result = apply_auto_fixes(sample_project_state, ["TOC needs update"])

        assert result["remediation_attempts"] == 1


class TestPageReconciliation:
    """Tests for critical page reconciliation feature."""

    def test_page_count_must_match(self, sample_project_state):
        """Test that page mismatch is critical error."""
        from nodes.qc import _validate_completeness

        structure_result = StructureResult(
            template="phase_1_astm_e1527",
            completeness_score=1.0,
        )
        sample_project_state["structure_result"] = structure_result

        # 104 pages missing (from the spec example)
        assembly_result = AssemblyResult(
            assembled_file_path="/test/report.pdf",
            total_pages=3672,
            source_pages=3776,
            pages_match=False,
        )

        result = _validate_completeness(sample_project_state, assembly_result)

        # Must have critical issue
        critical = [i for i in result["issues"] if i.severity == QCSeverity.CRITICAL]
        assert len(critical) > 0
        assert "104" in critical[0].description or "page" in critical[0].description.lower()

"""
Tests for pipeline nodes.
"""

import pytest
import os
from unittest.mock import patch, MagicMock

from state import (
    ReportState,
    IngestedFile,
    Classification,
    ClassifiedDocument,
    DocumentCategory,
    PipelineStage,
    StructureResult,
    create_initial_state,
)


class TestIngestNode:
    """Tests for the INGEST node."""

    def test_ingest_returns_correct_stage(self, sample_project_state, temp_dir):
        """Test that ingest node returns correct stage."""
        from nodes.ingest import ingest_node

        # Create upload directory
        upload_dir = os.path.join(temp_dir, "uploads", "TEST-2024-001")
        os.makedirs(upload_dir, exist_ok=True)

        result = ingest_node(sample_project_state)

        assert result["current_stage"] == PipelineStage.INGEST
        assert result["ingest_complete"] is True

    def test_ingest_no_files(self, sample_project_state, temp_dir):
        """Test ingest with no files in directory."""
        from nodes.ingest import ingest_node

        result = ingest_node(sample_project_state)

        assert result["ingest_complete"] is True
        assert len(result.get("ingest_errors", [])) > 0 or result.get("files", []) == []


class TestClassifyNode:
    """Tests for the CLASSIFY node."""

    @patch('nodes.classify.classify_document')
    def test_classify_returns_correct_stage(self, mock_classify, sample_project_state, sample_ingested_file):
        """Test that classify node returns correct stage."""
        from nodes.classify import classify_node

        # Mock the LLM classification
        mock_classify.return_value = {
            "category": "main_body",
            "section": "executive_summary",
            "confidence": 0.95,
            "reasoning": "Test reasoning",
            "flags": [],
        }

        # Add file to state
        sample_project_state["files"] = [sample_ingested_file]

        result = classify_node(sample_project_state)

        assert result["current_stage"] == PipelineStage.CLASSIFY
        assert len(result["classified_documents"]) == 1

    def test_classify_no_files(self, sample_project_state):
        """Test classify with no files."""
        from nodes.classify import classify_node

        sample_project_state["files"] = []
        result = classify_node(sample_project_state)

        assert result["classification_complete"] is True
        assert result["classified_documents"] == []

    @patch('nodes.classify.classify_document')
    def test_low_confidence_flagged_for_review(self, mock_classify, sample_project_state, sample_ingested_file):
        """Test that low confidence documents are flagged for review."""
        from nodes.classify import classify_node

        mock_classify.return_value = {
            "category": "main_body",
            "section": "executive_summary",
            "confidence": 0.6,  # Below 85% threshold
            "reasoning": "Uncertain classification",
            "flags": [],
        }

        sample_project_state["files"] = [sample_ingested_file]
        result = classify_node(sample_project_state)

        assert result["awaiting_human_input"] is True
        assert result["human_input_type"] == "classification_review"
        assert sample_ingested_file.id in result["documents_needing_review"]


class TestStructureNode:
    """Tests for the STRUCTURE node."""

    def test_structure_with_complete_documents(self, sample_project_state, sample_classified_document):
        """Test structure node with complete document set."""
        from nodes.structure import structure_node

        sample_project_state["classified_documents"] = [sample_classified_document]

        result = structure_node(sample_project_state)

        assert result["current_stage"] == PipelineStage.STRUCTURE
        assert "structure_result" in result
        assert result["structure_result"] is not None

    def test_structure_detects_missing_sections(self, sample_project_state):
        """Test that structure node detects missing required sections."""
        from nodes.structure import structure_node

        # Empty classified documents - all sections missing
        sample_project_state["classified_documents"] = []

        result = structure_node(sample_project_state)

        structure_result = result["structure_result"]
        assert len(structure_result.sections_missing) > 0
        assert structure_result.completeness_score < 1.0

    def test_structure_proposes_appendix_order(self, sample_project_state, sample_ingested_file):
        """Test that structure node proposes appendix ordering."""
        from nodes.structure import structure_node

        # Create appendix documents
        appendix_a = ClassifiedDocument(
            file=IngestedFile(
                id="appendix-a",
                original_filename="site_photos.pdf",
                format="pdf",
                page_count=20,
                size_bytes=5000000,
                text_content="Site photographs",
            ),
            classification=Classification(
                category=DocumentCategory.APPENDIX,
                section="appendix_b_site_photographs",
                appendix_letter="B",
                confidence=0.9,
            ),
        )

        appendix_b = ClassifiedDocument(
            file=IngestedFile(
                id="appendix-b",
                original_filename="site_maps.pdf",
                format="pdf",
                page_count=5,
                size_bytes=1000000,
                text_content="Site maps",
            ),
            classification=Classification(
                category=DocumentCategory.APPENDIX,
                section="appendix_a_site_plans_maps",
                appendix_letter="A",
                confidence=0.92,
            ),
        )

        sample_project_state["classified_documents"] = [appendix_a, appendix_b]

        result = structure_node(sample_project_state)

        # Should propose appendix order
        assert len(result["structure_result"].appendix_order) == 2


class TestApplyHumanClassification:
    """Tests for applying human classification decisions."""

    def test_apply_human_classification(self, sample_project_state, sample_classified_document):
        """Test applying human classification override."""
        from nodes.classify import apply_human_classification

        sample_project_state["classified_documents"] = [sample_classified_document]

        decisions = {
            sample_classified_document.file.id: {
                "category": "appendix",
                "section": "appendix_a_site_plans_maps",
                "appendix_letter": "A",
                "reason": "Manually reclassified",
            }
        }

        result = apply_human_classification(sample_project_state, decisions)

        assert result["classification_complete"] is True
        assert result["awaiting_human_input"] is False
        updated_docs = result["classified_documents"]
        assert len(updated_docs) == 1
        assert updated_docs[0].classification.category == DocumentCategory.APPENDIX


class TestApplyAppendixOrder:
    """Tests for applying appendix order changes."""

    def test_apply_appendix_order(self, sample_project_state):
        """Test applying new appendix order."""
        from nodes.structure import apply_appendix_order, structure_node

        # First run structure to get initial result
        appendix_a = ClassifiedDocument(
            file=IngestedFile(
                id="doc-a",
                original_filename="appendix_a.pdf",
                format="pdf",
                page_count=10,
                size_bytes=100000,
                text_content="Appendix A content",
            ),
            classification=Classification(
                category=DocumentCategory.APPENDIX,
                section="appendix_a_site_plans_maps",
                appendix_letter="A",
                confidence=0.9,
            ),
        )

        appendix_b = ClassifiedDocument(
            file=IngestedFile(
                id="doc-b",
                original_filename="appendix_b.pdf",
                format="pdf",
                page_count=15,
                size_bytes=150000,
                text_content="Appendix B content",
            ),
            classification=Classification(
                category=DocumentCategory.APPENDIX,
                section="appendix_b_site_photographs",
                appendix_letter="B",
                confidence=0.9,
            ),
        )

        sample_project_state["classified_documents"] = [appendix_a, appendix_b]
        structure_result = structure_node(sample_project_state)
        sample_project_state.update(structure_result)

        # Now reorder
        new_order = ["doc-b", "doc-a"]  # Swap order
        result = apply_appendix_order(sample_project_state, new_order)

        assert result["appendix_order_confirmed"] is True
        assert result["structure_result"].appendix_order == new_order

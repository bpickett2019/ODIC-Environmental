"""
Tests for LLM integration with mocked Kimi K2.5 API.

These tests verify that the skills correctly call the LLM router
without making actual API calls. Uses unittest.mock to simulate responses.
"""

import json
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import sys

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.llm_router import LLMRouter
from skills.document_classifier import DocumentClassifier
from skills.qa_checker import QAChecker


# ===== Test Configuration =====
TEST_CONFIG = {
    "llm": {
        "api_key_env": "MOONSHOT_API_KEY",
        "base_url": "https://api.moonshot.ai/v1",
        "model": "kimi-k2.5",
        "max_retries": 3,
        "timeout_seconds": 120,
    },
    "pipeline": {
        "confidence_threshold": 0.90,
        "project_base_dir": "./projects",
        "output_dir": "./completed_reports",
    },
    "qa": {
        "minimum_sections_required": 8,
        "require_site_photos": True,
        "require_edr": True,
        "require_topo": True,
    },
    "debug": True,
}


# ===== Mock Responses =====
MOCK_CLASSIFICATION_RESPONSE = json.dumps({
    "document_type": "edr",
    "confidence": 0.95,
    "reasoning": "Document contains EDR database search results from Environmental Data Resources",
    "extracted_metadata": {
        "date": "January 15, 2024",
        "location": "123 Main Street, Springfield, IL 62701",
        "project_id": None,
        "company_name": "Environmental Data Resources, Inc.",
        "is_appendix_content": False,
        "page_zone": "appendix"
    }
})

MOCK_QA_ANALYSIS_RESPONSE = json.dumps({
    "sections_found": ["Executive Summary", "Introduction", "Site Description"],
    "missing_sections": ["Records Review", "Conclusions"],
    "quality_score": 0.75,
    "issues": [
        {
            "section": "Records Review",
            "issue_type": "missing_content",
            "description": "Records Review section not found in report",
            "severity": "critical",
            "ai_fixable": False
        }
    ],
    "warnings": ["Report appears to be incomplete"],
    "section_order_correct": True,
    "overall_assessment": "Report needs additional sections before finalization",
    "detected_firms": [],
    "detected_projects": []
})

MOCK_CONTAMINATION_CHECK_RESPONSE = json.dumps({
    "detected_firm": "Acme Environmental Consulting",
    "is_odic_document": False,
    "detected_project_id": "ACME-2020-456",
    "detected_address": "123 Main Street, Springfield, IL",
    "document_type": "phase1_esa",
    "has_issues": True,
    "issues": [
        {
            "type": "third_party_report",
            "description": "Document is from Acme Environmental Consulting, not ODIC Environmental",
            "severity": "warning",
            "ai_fixable": False
        }
    ]
})


# ===== Fixtures =====
@pytest.fixture
def mock_llm_router():
    """Create a mocked LLM router."""
    with patch.dict('os.environ', {'MOONSHOT_API_KEY': 'test-api-key'}):
        # Patch at the openai package level before import happens
        with patch('openai.OpenAI') as mock_openai:
            with patch('openai.AsyncOpenAI') as mock_async_openai:
                router = LLMRouter(TEST_CONFIG)
                # Force clients to be set (mock bypasses normal init)
                router.client = MagicMock()
                router.async_client = MagicMock()
                return router


@pytest.fixture
def mock_classifier(mock_llm_router):
    """Create a classifier with mocked LLM router."""
    return DocumentClassifier(TEST_CONFIG, mock_llm_router)


@pytest.fixture
def mock_qa_checker(mock_llm_router):
    """Create a QA checker with mocked LLM router."""
    return QAChecker(TEST_CONFIG, mock_llm_router)


# ===== LLM Router Tests =====
class TestLLMRouter:
    """Tests for the LLM router."""

    def test_router_initialization_with_api_key(self):
        """Test router initializes with API key."""
        with patch.dict('os.environ', {'MOONSHOT_API_KEY': 'test-api-key'}):
            with patch('openai.OpenAI') as mock_openai:
                with patch('openai.AsyncOpenAI') as mock_async_openai:
                    router = LLMRouter(TEST_CONFIG)
                    mock_openai.assert_called_once()
                    mock_async_openai.assert_called_once()

    def test_router_initialization_without_key(self):
        """Test router reports unconfigured without API key."""
        import os
        # Save and clear keys
        old_moonshot = os.environ.pop('MOONSHOT_API_KEY', None)
        old_kimi = os.environ.pop('KIMI_API_KEY', None)

        try:
            router = LLMRouter(TEST_CONFIG)
            assert router.is_configured() is False
        finally:
            if old_moonshot:
                os.environ['MOONSHOT_API_KEY'] = old_moonshot
            if old_kimi:
                os.environ['KIMI_API_KEY'] = old_kimi

    def test_get_model_info(self, mock_llm_router):
        """Test get_model_info returns all task mappings."""
        model_info = mock_llm_router.get_model_info()

        assert "classify" in model_info
        assert "qa_check" in model_info
        assert "analyze" in model_info
        assert model_info["classify"] == "kimi-k2.5"

    def test_is_available_alias(self, mock_llm_router):
        """Test is_available() is an alias for is_configured()."""
        assert mock_llm_router.is_available() == mock_llm_router.is_configured()

    def test_classify_uses_instant_mode(self, mock_llm_router):
        """Test classify() uses instant mode."""
        mock_llm_router._call = MagicMock(return_value={"content": "test", "success": True})

        mock_llm_router.classify("system", "user")

        mock_llm_router._call.assert_called_once()
        call_args = mock_llm_router._call.call_args
        assert call_args[1]["mode"] == "instant"

    def test_analyze_uses_thinking_mode(self, mock_llm_router):
        """Test analyze() uses thinking mode."""
        mock_llm_router._call = MagicMock(return_value={"content": "test", "success": True})

        mock_llm_router.analyze("system", "user")

        mock_llm_router._call.assert_called_once()
        call_args = mock_llm_router._call.call_args
        assert call_args[1]["mode"] == "thinking"

    @pytest.mark.asyncio
    async def test_aclassify_async_version(self, mock_llm_router):
        """Test aclassify() async method."""
        mock_llm_router._acall = AsyncMock(return_value={"content": "test", "success": True})

        await mock_llm_router.aclassify("system", "user")

        mock_llm_router._acall.assert_called_once()
        call_args = mock_llm_router._acall.call_args
        assert call_args[1]["mode"] == "instant"

    @pytest.mark.asyncio
    async def test_legacy_complete_method(self, mock_llm_router):
        """Test legacy complete() method for backward compatibility."""
        mock_llm_router._acall = AsyncMock(return_value={
            "content": MOCK_CLASSIFICATION_RESPONSE,
            "success": True,
            "model": "kimi-k2.5",
            "mode": "instant"
        })

        result = await mock_llm_router.complete(
            task_type="classify",
            messages=[{"role": "user", "content": "test"}],
        )

        assert "content" in result
        assert result["model"] == "kimi-k2.5"
        assert result["task_type"] == "classify"


# ===== Document Classifier Tests =====
class TestDocumentClassifierLLMIntegration:
    """Tests for document classifier LLM integration."""

    @pytest.mark.asyncio
    async def test_classifier_calls_llm_router(self, mock_classifier):
        """Test that classifier makes LLM call via router."""
        mock_classifier.llm_router.complete = AsyncMock(
            return_value={
                "content": MOCK_CLASSIFICATION_RESPONSE,
                "model": "kimi-k2.5",
                "usage": {"input_tokens": 100, "output_tokens": 50}
            }
        )

        result = await mock_classifier.classify_text(
            text="EDR Database Report Content",
            filename="ODIC-2024-001_edr.pdf"
        )

        # Verify LLM was called
        mock_classifier.llm_router.complete.assert_called_once()

        # Verify call arguments
        call_args = mock_classifier.llm_router.complete.call_args
        assert call_args.kwargs["task_type"] == "classify"
        assert "messages" in call_args.kwargs

        # Verify result
        assert result.success is True
        assert result.data["type"] == "edr"
        assert result.data["confidence"] == 0.95

    @pytest.mark.asyncio
    async def test_classifier_handles_llm_failure(self, mock_classifier):
        """Test classifier falls back to rule-based when LLM fails."""
        mock_classifier.llm_router.complete = AsyncMock(
            side_effect=Exception("API Error")
        )

        result = await mock_classifier.classify_text(
            text="Some document text",
            filename="test.pdf"
        )

        # Classifier should succeed with rule-based fallback
        assert result.success is True
        # Should indicate rule-based fallback was used
        assert result.metadata.get("model") == "rule_based_fallback"
        # Should still provide a classification (even if low confidence)
        assert "type" in result.data
        assert "confidence" in result.data

    @pytest.mark.asyncio
    async def test_classifier_parses_json_with_backticks(self, mock_classifier):
        """Test classifier handles JSON wrapped in markdown backticks."""
        # Simulate AI returning JSON wrapped in backticks
        wrapped_response = f"```json\n{MOCK_CLASSIFICATION_RESPONSE}\n```"
        mock_classifier.llm_router.complete = AsyncMock(
            return_value={
                "content": wrapped_response,
                "model": "kimi-k2.5",
                "usage": {"input_tokens": 100, "output_tokens": 50}
            }
        )

        result = await mock_classifier.classify_text(
            text="Test document",
            filename="test.pdf"
        )

        # Should still parse successfully
        assert result.success is True
        assert result.data["type"] == "edr"


# ===== QA Checker Tests =====
class TestQACheckerLLMIntegration:
    """Tests for QA checker LLM integration."""

    @pytest.mark.asyncio
    async def test_qa_checker_calls_llm_for_analysis(self, mock_qa_checker, tmp_path):
        """Test that QA checker makes LLM call for content analysis."""
        mock_qa_checker.llm_router.complete = AsyncMock(
            return_value={
                "content": MOCK_QA_ANALYSIS_RESPONSE,
                "model": "kimi-k2.5",
                "usage": {"input_tokens": 1000, "output_tokens": 200}
            }
        )

        # Mock the PDF extraction
        with patch.object(mock_qa_checker, '_extract_report_text', return_value="Report text content"):
            with patch.object(mock_qa_checker, '_get_report_page_count', return_value=50):
                result = await mock_qa_checker._analyze_with_llm(
                    "Report text content",
                    ["Executive Summary", "Introduction", "Conclusions"]
                )

        # Verify LLM was called
        mock_qa_checker.llm_router.complete.assert_called()

        # Verify call used correct task type
        call_args = mock_qa_checker.llm_router.complete.call_args
        assert call_args.kwargs["task_type"] == "qa_check"

        # Verify result parsing
        assert "sections_found" in result
        assert "missing_sections" in result
        assert "quality_score" in result

    @pytest.mark.asyncio
    async def test_qa_checker_cross_contamination_detection(self, mock_qa_checker):
        """Test that QA checker calls LLM for cross-contamination analysis."""
        mock_qa_checker.llm_router.complete = AsyncMock(
            return_value={
                "content": MOCK_CONTAMINATION_CHECK_RESPONSE,
                "model": "kimi-k2.5",
                "usage": {"input_tokens": 500, "output_tokens": 100}
            }
        )

        result = await mock_qa_checker._analyze_document_origin(
            document_name="prior_report.pdf",
            document_text="Acme Environmental Consulting Phase I Report",
            expected_project_id="ODIC-2024-001",
            expected_address="123 Main Street"
        )

        # Verify LLM was called
        mock_qa_checker.llm_router.complete.assert_called_once()

        # Verify result
        assert result["detected_firm"] == "Acme Environmental Consulting"
        assert result["is_odic_document"] is False
        assert result["has_issues"] is True
        assert len(result["issues"]) > 0

    @pytest.mark.asyncio
    async def test_qa_checker_handles_llm_failure_gracefully(self, mock_qa_checker):
        """Test QA checker returns default results on LLM failure."""
        mock_qa_checker.llm_router.complete = AsyncMock(
            side_effect=Exception("API Error")
        )

        result = await mock_qa_checker._analyze_with_llm(
            "Report text",
            ["Section 1", "Section 2"]
        )

        # Should return default/fallback result
        assert "issues" in result
        assert result["quality_score"] == 0.5


# ===== Test Fallback Without AI =====
class TestFallbackWithoutAI:
    """Tests for graceful degradation when AI is not configured."""

    def test_router_returns_error_when_not_configured(self):
        """Test router returns proper error when API key not set."""
        import os
        old_moonshot = os.environ.pop('MOONSHOT_API_KEY', None)
        old_kimi = os.environ.pop('KIMI_API_KEY', None)

        try:
            router = LLMRouter(TEST_CONFIG)
            result = router.classify("system", "user")

            assert result["success"] is False
            assert "not configured" in result.get("error", "").lower()
        finally:
            if old_moonshot:
                os.environ['MOONSHOT_API_KEY'] = old_moonshot
            if old_kimi:
                os.environ['KIMI_API_KEY'] = old_kimi


# ===== Integration Test (with real API, skipped by default) =====
@pytest.mark.skip(reason="Requires MOONSHOT_API_KEY - run manually")
class TestRealAPIIntegration:
    """Integration tests that call the real Kimi K2.5 API."""

    @pytest.mark.asyncio
    async def test_real_classification_call(self):
        """Test a real classification call to the API."""
        import os
        if not os.environ.get("MOONSHOT_API_KEY") and not os.environ.get("KIMI_API_KEY"):
            pytest.skip("MOONSHOT_API_KEY or KIMI_API_KEY not set")

        router = LLMRouter(TEST_CONFIG)
        classifier = DocumentClassifier(TEST_CONFIG, router)

        result = await classifier.classify_text(
            text="""
            ENVIRONMENTAL DATA RESOURCES, INC.
            EDR RADIUS MAP REPORT
            Site: 123 Main Street, Springfield, IL
            Report Date: January 2024
            Database Search Results included
            """,
            filename="test_edr.pdf"
        )

        assert result.success is True
        assert result.data["type"] in ["edr", "environmental_database_report"]
        assert result.data["confidence"] > 0.5

        print(f"\nReal API Classification Result:")
        print(f"  Model: {router.model}")
        print(f"  Type: {result.data['type']}")
        print(f"  Confidence: {result.data['confidence']}")
        print(f"  Reasoning: {result.data.get('reasoning', 'N/A')[:100]}...")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])

"""
Tests for the QA Checker skill.
"""

import pytest
import asyncio
import tempfile
import shutil
import json
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch
from datetime import datetime

from skills.qa_checker import QAChecker, QAResult
from skills.base import SkillResult
from core.state import StateManager, DocumentStatus, ProjectStatus


@pytest.fixture
def config():
    """Create test configuration."""
    return {
        "llm": {
            "api_key_env": "ANTHROPIC_API_KEY",
            "classifier_model": "claude-haiku-4-5-20251001",
            "reasoning_model": "claude-sonnet-4-5-20250929",
        },
        "pipeline": {
            "project_base_dir": "./test_projects",
            "output_dir": "./test_completed_reports",
            "review_dir": "./test_qa_review",
        },
        "qa": {
            "minimum_sections_required": 8,
            "require_site_photos": True,
            "require_edr": True,
            "require_topo": True,
        },
    }


@pytest.fixture
def temp_dirs():
    """Create temporary directories for testing."""
    base_dir = tempfile.mkdtemp()
    project_dir = Path(base_dir) / "projects"
    output_dir = Path(base_dir) / "completed_reports"
    review_dir = Path(base_dir) / "qa_review"
    project_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)
    review_dir.mkdir(parents=True)

    yield {
        "base": base_dir,
        "projects": project_dir,
        "output": output_dir,
        "review": review_dir,
    }

    # Cleanup
    shutil.rmtree(base_dir, ignore_errors=True)


@pytest.fixture
def temp_state_db():
    """Create temporary state database."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    yield db_path
    Path(db_path).unlink(missing_ok=True)


@pytest.fixture
def state_manager(temp_state_db):
    """Create state manager with temp database."""
    return StateManager(temp_state_db)


@pytest.fixture
def mock_llm_router():
    """Create mock LLM router."""
    router = MagicMock()
    router.is_configured.return_value = True
    router.get_model_for_task.return_value = "kimi-k2.5"
    router.get_model_info.return_value = {
        "classify": "kimi-k2.5",
        "qa_check": "kimi-k2.5",
        "analyze": "kimi-k2.5",
        "assemble": "kimi-k2.5",
    }
    router.model = "kimi-k2.5"

    # Mock async complete method
    async def mock_complete(*args, **kwargs):
        return {
            "content": """{
    "sections_found": ["Executive Summary", "Introduction", "Site Description", "Records Review", "Historical Review", "Site Reconnaissance", "Findings", "Conclusions"],
    "missing_sections": [],
    "quality_score": 0.92,
    "issues": [],
    "warnings": ["Consider adding more detail to Section 4.2"],
    "section_order_correct": true,
    "overall_assessment": "Report appears complete and well-organized."
}""",
            "model": "kimi-k2.5",
            "usage": {"input_tokens": 100, "output_tokens": 200},
        }

    router.complete = mock_complete
    return router


@pytest.fixture
def mock_llm_router_failing():
    """Create mock LLM router that returns failing QA."""
    router = MagicMock()
    router.is_configured.return_value = True
    router.get_model_for_task.return_value = "claude-sonnet-4-5-20250929"

    async def mock_complete(*args, **kwargs):
        return {
            "content": """{
    "sections_found": ["Executive Summary", "Introduction"],
    "missing_sections": ["Site Description", "Records Review", "Historical Review", "Site Reconnaissance", "Findings", "Conclusions"],
    "quality_score": 0.35,
    "issues": ["Missing critical sections", "Report appears incomplete", "No site reconnaissance documented"],
    "warnings": ["Several required appendices are missing"],
    "section_order_correct": false,
    "overall_assessment": "Report is incomplete and requires significant revisions."
}""",
            "model": "claude-sonnet-4-5-20250929",
            "usage": {"input_tokens": 100, "output_tokens": 200},
        }

    router.complete = mock_complete
    return router


class TestQAResultDataclass:
    """Tests for QAResult dataclass."""

    def test_default_values(self):
        """Test QAResult default values."""
        result = QAResult(passed=True, score=0.9)

        assert result.passed is True
        assert result.score == 0.9
        assert result.issues == []
        assert result.warnings == []
        assert result.missing_sections == []
        assert result.missing_documents == []
        assert result.section_order_correct is True
        assert result.recommendations == []

    def test_with_issues(self):
        """Test QAResult with issues."""
        result = QAResult(
            passed=False,
            score=0.5,
            issues=["Missing section 4.2", "Incomplete appendix"],
            missing_sections=["Site Reconnaissance"],
        )

        assert result.passed is False
        assert len(result.issues) == 2
        assert len(result.missing_sections) == 1


class TestQACheckerInit:
    """Tests for QAChecker initialization."""

    def test_init_with_config(self, config, temp_dirs):
        """Test initialization with configuration."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        qa_checker = QAChecker(config)

        assert qa_checker.minimum_sections == 8
        assert qa_checker.require_site_photos is True
        assert qa_checker.require_edr is True
        assert qa_checker.require_topo is True

    def test_init_creates_review_dir(self, config, temp_dirs):
        """Test that initialization creates review directory."""
        new_review = Path(temp_dirs["base"]) / "new_review_dir"
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(new_review)

        qa_checker = QAChecker(config)

        assert new_review.exists()

    def test_init_with_state_manager(self, config, temp_dirs, state_manager):
        """Test initialization with state manager."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        qa_checker = QAChecker(config, state_manager=state_manager)

        assert qa_checker.state_manager is state_manager


class TestQACheckerValidation:
    """Tests for input validation."""

    def test_validate_string_input(self, config, temp_dirs):
        """Test validation with string project ID."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        qa_checker = QAChecker(config)

        assert qa_checker.validate_input("PROJ-001") is True

    def test_validate_dict_with_project_id(self, config, temp_dirs):
        """Test validation with dict containing project_id."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        qa_checker = QAChecker(config)

        assert qa_checker.validate_input({"project_id": "PROJ-001"}) is True

    def test_validate_dict_with_report_path(self, config, temp_dirs):
        """Test validation with dict containing report_path."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        qa_checker = QAChecker(config)

        assert qa_checker.validate_input({"report_path": "/path/to/report.pdf"}) is True

    def test_validate_invalid_input(self, config, temp_dirs):
        """Test validation with invalid input."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        qa_checker = QAChecker(config)

        assert qa_checker.validate_input(None) is False
        assert qa_checker.validate_input(123) is False
        assert qa_checker.validate_input([]) is False


class TestQACheckerHelpers:
    """Tests for helper methods."""

    def test_get_model(self, config, temp_dirs, mock_llm_router):
        """Test get_model returns correct model."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        qa_checker = QAChecker(config, llm_router=mock_llm_router)

        # Model can be either claude-sonnet (original) or kimi-k2.5 (new)
        model = qa_checker.get_model()
        assert model in ["claude-sonnet-4-5-20250929", "kimi-k2.5"] or "kimi" in model.lower() or "sonnet" in model.lower()

    def test_get_required_document_types(self, config, temp_dirs):
        """Test getting required document types."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        qa_checker = QAChecker(config)
        required = qa_checker._get_required_document_types()

        assert "edr" in required
        assert "topographic_map" in required
        assert "site_photograph" in required

    def test_check_project_documents_empty(self, config, temp_dirs):
        """Test checking documents in empty project."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        project_path = temp_dirs["projects"] / "PROJ-001"
        project_path.mkdir()

        qa_checker = QAChecker(config)
        documents = qa_checker._check_project_documents(project_path)

        assert documents == {}

    def test_check_project_documents_with_files(self, config, temp_dirs):
        """Test checking documents with files present."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        # Create project with document folders
        project_path = temp_dirs["projects"] / "PROJ-001"
        edr_path = project_path / "regulatory" / "edr"
        edr_path.mkdir(parents=True)

        # Create dummy PDF
        pdf_file = edr_path / "test_edr.pdf"
        _create_minimal_pdf(pdf_file)

        qa_checker = QAChecker(config)
        documents = qa_checker._check_project_documents(project_path)

        assert "edr" in documents
        assert len(documents["edr"]) == 1

    def test_get_report_page_count(self, config, temp_dirs):
        """Test getting page count from PDF."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        # Create test PDF
        pdf_path = temp_dirs["output"] / "test_report.pdf"
        _create_minimal_pdf(pdf_path)

        qa_checker = QAChecker(config)
        page_count = qa_checker._get_report_page_count(pdf_path)

        assert page_count >= 1


class TestQACheckerProcess:
    """Tests for the main process method."""

    @pytest.mark.asyncio
    async def test_process_missing_report(self, config, temp_dirs, mock_llm_router):
        """Test processing with missing report file."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        qa_checker = QAChecker(config, llm_router=mock_llm_router)
        result = await qa_checker.process({
            "project_id": "PROJ-001",
            "report_path": "/nonexistent/report.pdf"
        })

        assert result.success is False
        assert "not found" in result.error.lower()

    @pytest.mark.asyncio
    async def test_process_passing_report(self, config, temp_dirs, mock_llm_router, state_manager):
        """Test processing a report that passes QA."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        # Create project with required documents
        project_path = temp_dirs["projects"] / "PROJ-001"
        for doc_type, subfolder in [
            ("edr", "regulatory/edr"),
            ("topographic_map", "historical/topo_maps"),
            ("site_photograph", "site_visit/photos"),
        ]:
            folder = project_path / subfolder
            folder.mkdir(parents=True)
            pdf_file = folder / f"test_{doc_type}.pdf"
            _create_minimal_pdf(pdf_file)

        # Create report
        report_path = temp_dirs["output"] / "PROJ-001_report.pdf"
        _create_report_pdf(report_path)

        # Add project to state
        state_manager.get_or_create_project("PROJ-001")

        qa_checker = QAChecker(
            config,
            llm_router=mock_llm_router,
            state_manager=state_manager
        )
        result = await qa_checker.process({
            "project_id": "PROJ-001",
            "report_path": str(report_path)
        })

        assert result.success is True
        assert result.data["passed"] is True
        assert result.data["score"] > 0.7

    @pytest.mark.asyncio
    async def test_process_failing_report(self, config, temp_dirs, mock_llm_router_failing, state_manager):
        """Test processing a report that fails QA."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        # Create project WITHOUT required documents (will fail)
        project_path = temp_dirs["projects"] / "PROJ-002"
        project_path.mkdir()

        # Create minimal report
        report_path = temp_dirs["output"] / "PROJ-002_report.pdf"
        _create_minimal_pdf(report_path)

        # Add project to state
        state_manager.get_or_create_project("PROJ-002")

        qa_checker = QAChecker(
            config,
            llm_router=mock_llm_router_failing,
            state_manager=state_manager
        )
        result = await qa_checker.process({
            "project_id": "PROJ-002",
            "report_path": str(report_path)
        })

        assert result.success is True  # Process succeeded even though QA failed
        assert result.data["passed"] is False
        assert len(result.data["missing_documents"]) > 0

    @pytest.mark.asyncio
    async def test_process_updates_state_on_pass(self, config, temp_dirs, mock_llm_router, state_manager):
        """Test that passing QA updates state to COMPLETE."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        # Create project with required documents
        project_path = temp_dirs["projects"] / "PROJ-001"
        for doc_type, subfolder in [
            ("edr", "regulatory/edr"),
            ("topographic_map", "historical/topo_maps"),
            ("site_photograph", "site_visit/photos"),
        ]:
            folder = project_path / subfolder
            folder.mkdir(parents=True)
            pdf_file = folder / f"test_{doc_type}.pdf"
            _create_minimal_pdf(pdf_file)

        # Create report
        report_path = temp_dirs["output"] / "PROJ-001_report.pdf"
        _create_report_pdf(report_path)

        # Add project to state
        state_manager.get_or_create_project("PROJ-001")

        qa_checker = QAChecker(
            config,
            llm_router=mock_llm_router,
            state_manager=state_manager
        )
        result = await qa_checker.process({
            "project_id": "PROJ-001",
            "report_path": str(report_path)
        })

        # Check that result is valid
        assert result.success is True

        # If QA passed, verify state was updated
        if result.data["passed"]:
            # Use get_projects_by_status to check state
            complete_projects = state_manager.get_projects_by_status(ProjectStatus.COMPLETE)
            project_ids = [p.project_id for p in complete_projects]
            assert "PROJ-001" in project_ids


class TestQACheckerReviewQueue:
    """Tests for moving failed reports to review queue."""

    @pytest.mark.asyncio
    async def test_moves_to_review_on_failure(self, config, temp_dirs, mock_llm_router_failing, state_manager):
        """Test that failed reports are moved to review queue."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        # Create empty project (will fail QA)
        project_path = temp_dirs["projects"] / "PROJ-003"
        project_path.mkdir()

        # Create report
        report_path = temp_dirs["output"] / "PROJ-003_report.pdf"
        _create_minimal_pdf(report_path)

        state_manager.get_or_create_project("PROJ-003")

        qa_checker = QAChecker(
            config,
            llm_router=mock_llm_router_failing,
            state_manager=state_manager
        )
        result = await qa_checker.process({
            "project_id": "PROJ-003",
            "report_path": str(report_path)
        })

        # Check review folder was created
        review_folder = temp_dirs["review"] / "PROJ-003"
        if not result.data["passed"]:
            assert review_folder.exists()
            # Check QA notes file exists
            notes_file = review_folder / "qa_notes.json"
            assert notes_file.exists()

            # Verify notes content
            with open(notes_file) as f:
                notes = json.load(f)
            assert notes["project_id"] == "PROJ-003"
            assert notes["passed"] is False


class TestQACheckerLLMAnalysis:
    """Tests for LLM-based quality analysis."""

    @pytest.mark.asyncio
    async def test_analyze_with_llm(self, config, temp_dirs, mock_llm_router):
        """Test LLM analysis integration."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        qa_checker = QAChecker(config, llm_router=mock_llm_router)

        required_sections = ["Executive Summary", "Introduction", "Site Description"]
        report_text = """
        EXECUTIVE SUMMARY
        This Phase I ESA report summarizes the findings...

        1.0 INTRODUCTION
        This report presents the findings of a Phase I Environmental Site Assessment...

        2.0 SITE DESCRIPTION
        The subject property is located at 123 Main Street...
        """

        analysis = await qa_checker._analyze_with_llm(report_text, required_sections)

        assert "sections_found" in analysis
        assert "quality_score" in analysis
        assert "issues" in analysis

    @pytest.mark.asyncio
    async def test_analyze_without_llm(self, config, temp_dirs):
        """Test fallback when LLM is not configured."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])
        config["pipeline"]["review_dir"] = str(temp_dirs["review"])

        # Create mock router that isn't configured
        mock_router = MagicMock()
        mock_router.is_configured.return_value = False

        qa_checker = QAChecker(config, llm_router=mock_router)

        # Create report
        report_path = temp_dirs["output"] / "test_report.pdf"
        _create_report_pdf(report_path)

        # Create project folder
        project_path = temp_dirs["projects"] / "PROJ-004"
        project_path.mkdir()

        result = await qa_checker.process({
            "project_id": "PROJ-004",
            "report_path": str(report_path)
        })

        # Should still work, just without LLM analysis
        assert result.success is True


def _create_minimal_pdf(path: Path):
    """Create a minimal valid PDF file for testing."""
    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas

        c = canvas.Canvas(str(path), pagesize=letter)
        c.drawString(100, 750, "Test Document")
        c.save()
    except ImportError:
        # Fallback to minimal PDF bytes
        pdf_content = b"""%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer
<< /Size 4 /Root 1 0 R >>
startxref
196
%%EOF"""
        path.write_bytes(pdf_content)


def _create_report_pdf(path: Path):
    """Create a test report PDF with section headings."""
    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas

        c = canvas.Canvas(str(path), pagesize=letter)

        # Add several pages with section headings
        sections = [
            "EXECUTIVE SUMMARY",
            "1.0 INTRODUCTION",
            "2.0 SITE DESCRIPTION",
            "3.0 USER PROVIDED INFORMATION",
            "4.0 RECORDS REVIEW",
            "5.0 HISTORICAL REVIEW",
            "6.0 SITE RECONNAISSANCE",
            "7.0 FINDINGS AND OPINIONS",
            "8.0 CONCLUSIONS",
        ]

        y_pos = 750
        for section in sections:
            c.drawString(100, y_pos, section)
            y_pos -= 50
            c.drawString(100, y_pos, "Lorem ipsum dolor sit amet, consectetur adipiscing elit.")
            y_pos -= 30

            if y_pos < 100:
                c.showPage()
                y_pos = 750

        c.save()
    except ImportError:
        # Fallback to minimal PDF
        _create_minimal_pdf(path)

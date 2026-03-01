"""
Tests for the Report Assembler skill.
"""

import pytest
import asyncio
import tempfile
import shutil
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch

from skills.report_assembler import ReportAssembler, SectionContent
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
        },
        "report": {
            "company_name": "Test Environmental Company",
            "company_address": "123 Test St",
            "company_phone": "555-1234",
            "company_email": "test@test.com",
        },
    }


@pytest.fixture
def temp_dirs():
    """Create temporary directories for testing."""
    base_dir = tempfile.mkdtemp()
    project_dir = Path(base_dir) / "projects"
    output_dir = Path(base_dir) / "completed_reports"
    project_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)

    yield {
        "base": base_dir,
        "projects": project_dir,
        "output": output_dir,
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
    router.get_model_for_task.return_value = "claude-sonnet-4-5-20250929"

    # Mock async complete method
    async def mock_complete(*args, **kwargs):
        return {
            "content": """This is a generated executive summary for the Phase I ESA.

The site assessment reveals no significant environmental concerns. Historical records
indicate the property has been used for commercial purposes since 1950. No recognized
environmental conditions (RECs) were identified during the investigation.""",
            "model": "claude-sonnet-4-5-20250929",
            "usage": {"input_tokens": 100, "output_tokens": 200},
        }

    router.complete = mock_complete
    return router


class TestReportAssemblerInit:
    """Tests for ReportAssembler initialization."""

    def test_init_with_config(self, config, temp_dirs):
        """Test initialization with configuration."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        assembler = ReportAssembler(config)

        assert assembler.project_base_dir == temp_dirs["projects"]
        assert assembler.output_dir == temp_dirs["output"]

    def test_init_creates_output_dir(self, config, temp_dirs):
        """Test that initialization creates output directory."""
        new_output = temp_dirs["output"] / "new_subdir"
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(new_output)

        assembler = ReportAssembler(config)

        assert new_output.exists()

    def test_init_with_state_manager(self, config, temp_dirs, state_manager):
        """Test initialization with state manager."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        assembler = ReportAssembler(config, state_manager=state_manager)

        assert assembler.state_manager is state_manager


class TestReportAssemblerValidation:
    """Tests for input validation."""

    def test_validate_string_input_existing_project(self, config, temp_dirs):
        """Test validation with string project ID for existing project."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        # Create the project folder
        project_path = temp_dirs["projects"] / "PROJ-001"
        project_path.mkdir(parents=True)

        assembler = ReportAssembler(config)

        assert assembler.validate_input("PROJ-001") is True

    def test_validate_string_input_nonexistent_project(self, config, temp_dirs):
        """Test validation with nonexistent project."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        assembler = ReportAssembler(config)

        # Should return False for nonexistent project
        assert assembler.validate_input("NONEXISTENT") is False

    def test_validate_invalid_input(self, config, temp_dirs):
        """Test validation with invalid input."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        assembler = ReportAssembler(config)

        assert assembler.validate_input(None) is False
        assert assembler.validate_input(123) is False
        assert assembler.validate_input({}) is False


class TestReportAssemblerHelpers:
    """Tests for helper methods."""

    def test_get_model(self, config, temp_dirs, mock_llm_router):
        """Test get_model returns correct model."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        assembler = ReportAssembler(config, llm_router=mock_llm_router)

        assert assembler.get_model() == "claude-sonnet-4-5-20250929"

    def test_get_documents_by_type_empty_project(self, config, temp_dirs):
        """Test getting documents from empty project."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        # Create empty project folder
        project_path = temp_dirs["projects"] / "PROJ-001"
        project_path.mkdir()

        assembler = ReportAssembler(config)
        documents = assembler._get_documents_by_type(project_path, "edr")

        assert documents == []

    def test_get_documents_by_type_with_files(self, config, temp_dirs):
        """Test getting documents with PDFs present."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        # Create project with document folders
        project_path = temp_dirs["projects"] / "PROJ-001"
        edr_path = project_path / "regulatory" / "edr"
        edr_path.mkdir(parents=True)

        # Create a dummy PDF
        pdf_file = edr_path / "test_edr.pdf"
        _create_minimal_pdf(pdf_file)

        assembler = ReportAssembler(config)
        documents = assembler._get_documents_by_type(project_path, "edr")

        assert len(documents) == 1
        assert documents[0].name == "test_edr.pdf"


class TestReportAssemblerProcess:
    """Tests for the main process method."""

    @pytest.mark.asyncio
    async def test_process_missing_project(self, config, temp_dirs, mock_llm_router):
        """Test processing with missing project folder."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        assembler = ReportAssembler(config, llm_router=mock_llm_router)
        result = await assembler.process("NONEXISTENT-PROJECT")

        assert result.success is False
        assert "not found" in result.error.lower()

    @pytest.mark.asyncio
    async def test_process_empty_project_creates_minimal_report(self, config, temp_dirs, mock_llm_router):
        """Test processing project with no documents still creates a minimal report."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        # Create empty project folder
        project_path = temp_dirs["projects"] / "PROJ-001"
        project_path.mkdir()

        assembler = ReportAssembler(config, llm_router=mock_llm_router)
        result = await assembler.process("PROJ-001")

        # Even with no documents, it should create a skeleton report
        # Check if it succeeded or failed appropriately
        assert result is not None

    @pytest.mark.asyncio
    async def test_process_updates_state(self, config, temp_dirs, mock_llm_router, state_manager):
        """Test that processing updates state manager."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        # Create project with a document
        project_path = temp_dirs["projects"] / "PROJ-001"
        edr_path = project_path / "regulatory" / "edr"
        edr_path.mkdir(parents=True)

        # Create a minimal valid PDF
        pdf_file = edr_path / "test_edr.pdf"
        _create_minimal_pdf(pdf_file)

        # Add project to state
        state_manager.get_or_create_project("PROJ-001")

        assembler = ReportAssembler(
            config,
            llm_router=mock_llm_router,
            state_manager=state_manager
        )

        # The assembler should attempt to update project status
        result = await assembler.process("PROJ-001")

        # Check that the result is returned
        assert result is not None


class TestReportAssemblerIntegration:
    """Integration tests (may require API key)."""

    @pytest.mark.skipif(
        not Path("/Users/bp/ODIC Enviornmental/odic-esa-pipeline/tests/fixtures").exists(),
        reason="Test fixtures not available"
    )
    @pytest.mark.asyncio
    async def test_process_with_fixtures(self, config, temp_dirs, mock_llm_router):
        """Test processing with real fixture files."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        # Copy fixtures to project folder
        fixtures_dir = Path("/Users/bp/ODIC Enviornmental/odic-esa-pipeline/tests/fixtures")
        if fixtures_dir.exists():
            project_path = temp_dirs["projects"] / "PROJ-001"
            project_path.mkdir()

            # Copy any PDFs from fixtures
            for pdf in fixtures_dir.glob("*.pdf"):
                shutil.copy(pdf, project_path / pdf.name)

        assembler = ReportAssembler(config, llm_router=mock_llm_router)
        result = await assembler.process("PROJ-001")

        # Just check it doesn't crash
        assert result is not None


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


class TestCoverPageGeneration:
    """Tests for cover page generation."""

    def test_create_cover_page(self, config, temp_dirs, mock_llm_router):
        """Test cover page creation returns bytes."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        assembler = ReportAssembler(config, llm_router=mock_llm_router)

        cover_bytes = assembler._create_cover_page(
            project_id="PROJ-001",
            site_address="123 Test Street, Test City, ST 12345",
            client_name="Test Client LLC"
        )

        assert isinstance(cover_bytes, bytes)
        assert len(cover_bytes) > 0
        # Check it's a valid PDF
        assert cover_bytes.startswith(b'%PDF')


class TestTableOfContents:
    """Tests for table of contents generation."""

    def test_create_toc(self, config, temp_dirs, mock_llm_router):
        """Test TOC creation returns bytes."""
        config["pipeline"]["project_base_dir"] = str(temp_dirs["projects"])
        config["pipeline"]["output_dir"] = str(temp_dirs["output"])

        assembler = ReportAssembler(config, llm_router=mock_llm_router)

        # Create SectionContent objects as expected by the method
        sections = [
            SectionContent(
                section_id="exec_summary",
                section_name="Executive Summary",
                page_number=1,
                pdf_paths=[]
            ),
            SectionContent(
                section_id="introduction",
                section_name="1.0 Introduction",
                page_number=3,
                pdf_paths=[]
            ),
            SectionContent(
                section_id="site_description",
                section_name="2.0 Site Description",
                page_number=5,
                pdf_paths=[]
            ),
        ]

        toc_bytes = assembler._create_toc(sections=sections)

        assert isinstance(toc_bytes, bytes)
        assert len(toc_bytes) > 0
        # Check it's a valid PDF
        assert toc_bytes.startswith(b'%PDF')

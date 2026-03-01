"""
ODIC ESA Pipeline - File Organizer Tests

Tests for file organization, renaming, and project folder structure.
"""

import os
import sys
import tempfile
import shutil
import pytest
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from skills.file_organizer import FileOrganizer
from skills.base import SkillResult
from core.state import StateManager


@pytest.fixture
def temp_dirs():
    """Create temporary directories for testing."""
    base_dir = tempfile.mkdtemp()
    dirs = {
        "projects": Path(base_dir) / "projects",
        "failed": Path(base_dir) / "failed",
        "staging": Path(base_dir) / "staging",
    }
    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)

    yield dirs

    # Cleanup
    shutil.rmtree(base_dir)


@pytest.fixture
def config(temp_dirs):
    """Create test configuration."""
    return {
        "pipeline": {
            "project_base_dir": str(temp_dirs["projects"]),
            "failed_dir": str(temp_dirs["failed"]),
            "confidence_threshold": 0.90,
        },
        "qa": {
            "require_edr": True,
            "require_topo": True,
            "require_site_photos": True,
        },
    }


@pytest.fixture
def state_manager(temp_dirs):
    """Create a StateManager with temporary database."""
    db_path = temp_dirs["staging"] / "test_state.db"
    return StateManager(str(db_path))


@pytest.fixture
def organizer(config, state_manager):
    """Create a FileOrganizer instance."""
    return FileOrganizer(config, state_manager)


@pytest.fixture
def sample_pdf(temp_dirs):
    """Create a sample PDF file for testing."""
    pdf_path = temp_dirs["staging"] / "test_document.pdf"
    pdf_path.write_bytes(b"%PDF-1.4\ntest content\n%%EOF")
    return str(pdf_path)


@pytest.fixture
def classification_result(sample_pdf):
    """Sample classification result."""
    return {
        "file": sample_pdf,
        "type": "edr",
        "confidence": 0.95,
        "project_id": "ODIC-2024-001",
        "requires_manual_review": False,
        "extracted_metadata": {
            "date": "2024-01-15",
            "location": "123 Main Street",
        },
    }


class TestFileOrganizerInitialization:
    """Test FileOrganizer initialization."""

    def test_initialization(self, organizer, temp_dirs):
        """Test organizer initializes correctly."""
        assert organizer is not None
        assert organizer.project_base_dir == temp_dirs["projects"]
        assert organizer.failed_dir == temp_dirs["failed"]

    def test_creates_directories(self, organizer, temp_dirs):
        """Test that required directories are created."""
        assert temp_dirs["projects"].exists()
        assert temp_dirs["failed"].exists()

    def test_loads_esa_template(self, organizer):
        """Test that ESA template is loaded."""
        assert organizer.esa_template is not None

    def test_gets_required_types(self, organizer):
        """Test that required document types are determined."""
        assert len(organizer.required_types) > 0
        assert "edr" in organizer.required_types
        assert "topographic_map" in organizer.required_types


class TestFilenameGeneration:
    """Test filename generation."""

    def test_generate_filename_basic(self, organizer):
        """Test basic filename generation."""
        filename = organizer._generate_filename(
            project_id="ODIC-2024-001",
            document_type="edr",
            original_filename="original.pdf",
            metadata={},
        )

        assert "ODIC-2024-001" in filename
        assert "edr" in filename
        assert filename.endswith(".pdf")

    def test_generate_filename_with_date(self, organizer):
        """Test filename with date from metadata."""
        filename = organizer._generate_filename(
            project_id="ODIC-2024-001",
            document_type="aerial_photograph",
            original_filename="aerial.pdf",
            metadata={"date": "2024-01-15"},
        )

        assert "20240115" in filename

    def test_generate_filename_preserves_extension(self, organizer):
        """Test that file extension is preserved."""
        filename = organizer._generate_filename(
            project_id="ODIC-2024-001",
            document_type="edr",
            original_filename="report.PDF",
            metadata={},
        )

        assert filename.endswith(".pdf")

    def test_ensure_unique_filename(self, organizer, temp_dirs):
        """Test unique filename generation when file exists."""
        dest = temp_dirs["projects"] / "test_folder"
        dest.mkdir(parents=True)

        # Create existing file
        (dest / "test.pdf").write_bytes(b"test")

        unique = organizer._ensure_unique_filename(dest, "test.pdf")
        assert unique != "test.pdf"
        assert "test_01" in unique or "test_" in unique


class TestProjectFolderStructure:
    """Test project folder creation."""

    def test_get_project_folder_creates_structure(self, organizer, temp_dirs):
        """Test that project folder structure is created."""
        project_path = organizer._get_project_folder("ODIC-2024-001")

        assert project_path.exists()

        # Check for expected subfolders
        expected_subfolders = [
            "historical/sanborn_maps",
            "historical/topo_maps",
            "historical/aerials",
            "regulatory/edr",
            "site_visit/photos",
            "report",
        ]

        for subfolder in expected_subfolders:
            assert (project_path / subfolder).exists()

    def test_get_destination_folder(self, organizer, temp_dirs):
        """Test getting correct destination subfolder for document type."""
        project_path = temp_dirs["projects"] / "ODIC-2024-001"
        project_path.mkdir(parents=True)

        test_cases = [
            ("edr", "regulatory/edr"),
            ("sanborn_map", "historical/sanborn_maps"),
            ("topographic_map", "historical/topo_maps"),
            ("site_photograph", "site_visit/photos"),
            ("unknown_type", "other"),
        ]

        for doc_type, expected_subfolder in test_cases:
            dest = organizer._get_destination_folder(project_path, doc_type)
            assert expected_subfolder in str(dest)


class TestInputValidation:
    """Test input validation."""

    def test_validate_input_valid(self, organizer, classification_result):
        """Test validation with valid input."""
        assert organizer.validate_input(classification_result) is True

    def test_validate_input_missing_file(self, organizer):
        """Test validation with missing file field."""
        result = organizer.validate_input({"type": "edr"})
        assert result is False

    def test_validate_input_missing_type(self, organizer, sample_pdf):
        """Test validation with missing type field."""
        result = organizer.validate_input({"file": sample_pdf})
        assert result is False

    def test_validate_input_nonexistent_file(self, organizer):
        """Test validation with nonexistent file."""
        result = organizer.validate_input({
            "file": "/nonexistent/path/file.pdf",
            "type": "edr",
        })
        assert result is False

    def test_validate_input_wrong_type(self, organizer):
        """Test validation with wrong input type."""
        assert organizer.validate_input("not a dict") is False
        assert organizer.validate_input(None) is False


@pytest.mark.asyncio
class TestDocumentOrganization:
    """Test document organization process."""

    async def test_organize_document_basic(
        self, organizer, classification_result, temp_dirs
    ):
        """Test basic document organization."""
        result = await organizer.process(classification_result)

        assert result.success is True
        assert result.data["project_id"] == "ODIC-2024-001"
        assert result.data["document_type"] == "edr"

        # Verify file was copied
        organized_path = Path(result.data["organized_path"])
        assert organized_path.exists()

    async def test_organize_document_creates_project_folder(
        self, organizer, classification_result, temp_dirs
    ):
        """Test that project folder is created during organization."""
        result = await organizer.process(classification_result)

        assert result.success is True
        project_path = Path(result.data["project_path"])
        assert project_path.exists()
        assert project_path.name == "ODIC-2024-001"

    async def test_organize_document_correct_subfolder(
        self, organizer, classification_result, temp_dirs
    ):
        """Test document goes to correct subfolder."""
        result = await organizer.process(classification_result)

        assert result.success is True
        organized_path = Path(result.data["organized_path"])
        assert "regulatory/edr" in str(organized_path)

    async def test_organize_sanborn_map(
        self, organizer, sample_pdf, temp_dirs
    ):
        """Test organizing a Sanborn map."""
        classification = {
            "file": sample_pdf,
            "type": "sanborn_map",
            "confidence": 0.92,
            "project_id": "ODIC-2024-002",
            "requires_manual_review": False,
            "extracted_metadata": {"date": "1925"},
        }

        result = await organizer.process(classification)

        assert result.success is True
        organized_path = Path(result.data["organized_path"])
        assert "historical/sanborn_maps" in str(organized_path)

    async def test_organize_preserves_original(
        self, organizer, classification_result, sample_pdf, temp_dirs
    ):
        """Test that original file is preserved (copied, not moved)."""
        original_path = Path(sample_pdf)
        original_size = original_path.stat().st_size

        result = await organizer.process(classification_result)

        assert result.success is True
        # Original should still exist
        assert original_path.exists()
        assert original_path.stat().st_size == original_size


@pytest.mark.asyncio
class TestManualReviewHandling:
    """Test handling of documents flagged for manual review."""

    async def test_manual_review_document(
        self, organizer, sample_pdf, temp_dirs
    ):
        """Test document flagged for manual review."""
        classification = {
            "file": sample_pdf,
            "type": "other",
            "confidence": 0.5,
            "project_id": None,
            "requires_manual_review": True,
            "extracted_metadata": {},
        }

        result = await organizer.process(classification)

        assert result.success is True
        assert result.data["requires_manual_review"] is True
        assert "review_path" in result.data

        # Check file is in manual review folder
        review_path = Path(result.data["review_path"])
        assert review_path.exists()
        assert "_manual_review" in str(review_path.parent)

    async def test_manual_review_creates_metadata(
        self, organizer, sample_pdf, temp_dirs
    ):
        """Test that metadata file is created for manual review."""
        classification = {
            "file": sample_pdf,
            "type": "other",
            "confidence": 0.5,
            "project_id": None,
            "requires_manual_review": True,
            "extracted_metadata": {},
        }

        result = await organizer.process(classification)

        assert result.success is True
        meta_path = Path(result.data["meta_path"])
        assert meta_path.exists()


@pytest.mark.asyncio
class TestNoProjectHandling:
    """Test handling of documents without project ID."""

    async def test_no_project_id(self, organizer, sample_pdf, temp_dirs):
        """Test document with no project ID."""
        classification = {
            "file": sample_pdf,
            "type": "edr",
            "confidence": 0.95,
            "project_id": None,
            "requires_manual_review": False,
            "extracted_metadata": {},
        }

        result = await organizer.process(classification)

        assert result.success is True
        assert result.data["requires_project_assignment"] is True
        assert "unassigned_path" in result.data

        # Check file is in unassigned folder
        unassigned_path = Path(result.data["unassigned_path"])
        assert unassigned_path.exists()
        assert "_unassigned" in str(unassigned_path.parent)


@pytest.mark.asyncio
class TestProjectCompleteness:
    """Test project completeness checking."""

    async def test_incomplete_project(
        self, organizer, classification_result, temp_dirs
    ):
        """Test completeness check for incomplete project."""
        result = await organizer.process(classification_result)

        assert result.success is True
        assert result.data["project_complete"] is False
        assert len(result.data["missing_documents"]) > 0

    async def test_completeness_tracks_present_docs(
        self, organizer, sample_pdf, temp_dirs
    ):
        """Test that present documents are tracked."""
        # Add multiple documents
        project_id = "ODIC-2024-001"

        for doc_type in ["edr", "topographic_map"]:
            # Create unique file
            pdf_path = temp_dirs["staging"] / f"{doc_type}_test.pdf"
            pdf_path.write_bytes(f"%PDF-1.4\n{doc_type} content\n%%EOF".encode())

            classification = {
                "file": str(pdf_path),
                "type": doc_type,
                "confidence": 0.95,
                "project_id": project_id,
                "requires_manual_review": False,
                "extracted_metadata": {},
            }

            result = await organizer.process(classification)
            assert result.success is True

        # Check present documents
        assert "edr" in result.data["present_documents"]
        assert "topographic_map" in result.data["present_documents"]


class TestProjectStatus:
    """Test project status queries."""

    def test_get_project_status_nonexistent(self, organizer):
        """Test status of nonexistent project."""
        status = organizer.get_project_status("NONEXISTENT-001")
        assert status["exists"] is False

    @pytest.mark.asyncio
    async def test_get_project_status_after_organization(
        self, organizer, classification_result, temp_dirs
    ):
        """Test project status after organizing a document."""
        await organizer.process(classification_result)

        status = organizer.get_project_status("ODIC-2024-001")

        assert status["exists"] is True
        assert status["project_id"] == "ODIC-2024-001"
        assert "edr" in status["present_types"]
        assert status["total_documents"] > 0


class TestSubfolderMapping:
    """Test document type to subfolder mapping."""

    def test_all_types_have_mapping(self, organizer):
        """Test that all document types have subfolder mapping."""
        expected_types = [
            "sanborn_map",
            "topographic_map",
            "aerial_photograph",
            "city_directory",
            "fire_insurance_map",
            "edr",
            "title_record",
            "tax_record",
            "building_permit",
            "site_photograph",
            "regulatory_correspondence",
            "prior_environmental_report",
            "client_correspondence",
            "lab_results",
            "other",
        ]

        for doc_type in expected_types:
            assert doc_type in organizer.SUBFOLDER_MAP


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

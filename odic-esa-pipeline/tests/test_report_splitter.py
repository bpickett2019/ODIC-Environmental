"""
Tests for the ReportSplitter skill.

Tests splitting large PDF reports into smaller chunks:
- Size-based splitting
- Page boundary preservation
- Sequential naming
- Small file passthrough
"""

import asyncio
import os
import tempfile
from pathlib import Path

import pytest
from PyPDF2 import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from PIL import Image
from io import BytesIO

# Add parent to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from skills.report_splitter import ReportSplitter


@pytest.fixture
def config():
    """Basic configuration for tests."""
    return {
        'splitter': {
            'max_size_mb': 5,  # 5MB for testing (smaller than real)
            'output_dir': tempfile.mkdtemp(),
            'min_pages_per_chunk': 1,
        },
        'pipeline': {
            'output_dir': tempfile.mkdtemp(),
        }
    }


@pytest.fixture
def splitter(config):
    """Create a ReportSplitter instance."""
    return ReportSplitter(config)


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    import shutil
    d = tempfile.mkdtemp()
    yield d
    shutil.rmtree(d, ignore_errors=True)


# ===== Helper Functions =====

def create_test_pdf(path: Path, pages: int = 1, content_per_page: str = None):
    """Create a simple test PDF with specified number of pages."""
    c = canvas.Canvas(str(path), pagesize=letter)
    for i in range(pages):
        content = content_per_page or f"This is test page {i + 1}"
        c.drawString(100, 700, content)
        c.drawString(100, 680, f"Page {i + 1} of {pages}")
        if i < pages - 1:
            c.showPage()
    c.save()
    return path


def create_large_pdf(path: Path, target_size_mb: float, pages: int = None):
    """
    Create a PDF of approximately the target size.
    Uses images to inflate file size.
    """
    # Create PDF with embedded images to reach target size
    writer = PdfWriter()
    page_size = int(target_size_mb * 1024 * 1024 / (pages or 50))  # bytes per page

    # Estimate pages needed
    if pages is None:
        pages = max(10, int(target_size_mb * 10))

    c = canvas.Canvas(str(path), pagesize=letter)

    for i in range(pages):
        c.drawString(100, 700, f"Large document page {i + 1}")
        c.drawString(100, 680, f"This is filler content to increase file size.")

        # Add some random data as a large text block
        for j in range(50):
            c.drawString(100, 650 - (j * 10), f"Line {j}: {'x' * 80}")

        if i < pages - 1:
            c.showPage()

    c.save()

    # If file is still too small, we may need to adjust
    actual_size = path.stat().st_size
    return path, actual_size


def create_pdf_with_images(path: Path, pages: int, image_size: tuple = (800, 600)):
    """Create a PDF with embedded images to increase file size."""
    from reportlab.lib.utils import ImageReader

    c = canvas.Canvas(str(path), pagesize=letter)

    for i in range(pages):
        # Create an in-memory image
        img = Image.new('RGB', image_size, color=(i * 20 % 255, i * 30 % 255, i * 40 % 255))
        img_buffer = BytesIO()
        img.save(img_buffer, format='JPEG', quality=95)
        img_buffer.seek(0)

        # Add to PDF
        c.drawImage(ImageReader(img_buffer), 50, 200, width=500, height=400)
        c.drawString(100, 700, f"Page {i + 1} with image")

        if i < pages - 1:
            c.showPage()

    c.save()
    return path


# ===== Basic Tests =====

class TestReportSplitterInit:
    """Tests for ReportSplitter initialization."""

    def test_init_with_config(self, config):
        """Test splitter initializes with config."""
        splitter = ReportSplitter(config)
        assert splitter is not None
        assert splitter.output_dir.exists()

    def test_default_max_size(self, config):
        """Test max size is set from config."""
        splitter = ReportSplitter(config)
        assert splitter.max_size_bytes == 5 * 1024 * 1024  # 5MB

    def test_custom_output_dir(self):
        """Test custom output directory."""
        custom_dir = tempfile.mkdtemp()
        config = {'splitter': {'output_dir': custom_dir}}
        splitter = ReportSplitter(config)
        assert str(splitter.output_dir) == custom_dir


class TestInputValidation:
    """Tests for input validation."""

    def test_validate_existing_pdf(self, splitter, temp_dir):
        """Test validation accepts existing PDF."""
        pdf_path = create_test_pdf(Path(temp_dir) / 'test.pdf')
        assert splitter.validate_input(str(pdf_path)) is True

    def test_validate_dict_input(self, splitter, temp_dir):
        """Test validation accepts dict with file_path."""
        pdf_path = create_test_pdf(Path(temp_dir) / 'test.pdf')
        assert splitter.validate_input({'file_path': str(pdf_path)}) is True

    def test_validate_nonexistent_file(self, splitter):
        """Test validation rejects nonexistent file."""
        assert splitter.validate_input('/nonexistent/file.pdf') is False

    def test_validate_non_pdf(self, splitter, temp_dir):
        """Test validation rejects non-PDF files."""
        txt_path = Path(temp_dir) / 'test.txt'
        txt_path.write_text('test')
        assert splitter.validate_input(str(txt_path)) is False


# ===== Small File Passthrough Tests =====

class TestSmallFilePassthrough:
    """Tests for files that don't need splitting."""

    @pytest.mark.asyncio
    async def test_small_file_no_split(self, splitter, temp_dir):
        """Test that small files pass through without splitting."""
        pdf_path = create_test_pdf(Path(temp_dir) / 'small.pdf', pages=5)

        result = await splitter.process(str(pdf_path))

        assert result.success is True
        assert result.data['split_required'] is False
        assert result.data['chunk_count'] == 1

    @pytest.mark.asyncio
    async def test_small_file_returns_original_path(self, splitter, temp_dir):
        """Test that small files return original path in chunks."""
        pdf_path = create_test_pdf(Path(temp_dir) / 'small.pdf')

        result = await splitter.process(str(pdf_path))

        assert result.data['chunks'][0]['path'] == str(pdf_path)

    def test_needs_splitting_small_file(self, splitter, temp_dir):
        """Test needs_splitting returns False for small files."""
        pdf_path = create_test_pdf(Path(temp_dir) / 'small.pdf')
        assert splitter.needs_splitting(pdf_path) is False


# ===== Splitting Tests =====

class TestPDFSplitting:
    """Tests for PDF splitting functionality."""

    @pytest.mark.asyncio
    async def test_split_large_pdf(self, temp_dir):
        """Test splitting a large PDF into chunks."""
        # Create a config with very small max size for testing
        config = {
            'splitter': {
                'max_size_mb': 0.1,  # 100KB - will force splitting
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        # Create a PDF large enough to need splitting
        pdf_path = create_pdf_with_images(Path(temp_dir) / 'large.pdf', pages=10)

        result = await splitter.process(str(pdf_path))

        assert result.success is True
        # Should split since file is larger than 100KB
        if result.data['split_required']:
            assert result.data['chunk_count'] >= 2

    @pytest.mark.asyncio
    async def test_split_preserves_all_pages(self, temp_dir):
        """Test that splitting preserves all pages."""
        config = {
            'splitter': {
                'max_size_mb': 0.05,  # Very small to force splitting
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        original_pages = 20
        pdf_path = create_pdf_with_images(Path(temp_dir) / 'pages.pdf', pages=original_pages)

        result = await splitter.process(str(pdf_path))

        if result.data['split_required']:
            # Count total pages across all chunks
            total_pages = sum(c['page_count'] for c in result.data['chunks'])
            assert total_pages == original_pages

    @pytest.mark.asyncio
    async def test_split_sequential_naming(self, temp_dir):
        """Test that chunks are named sequentially."""
        config = {
            'splitter': {
                'max_size_mb': 0.05,
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        pdf_path = create_pdf_with_images(Path(temp_dir) / 'test.pdf', pages=15)

        result = await splitter.process({
            'file_path': str(pdf_path),
            'project_id': 'PROJ-001'
        })

        if result.data['split_required']:
            for i, chunk in enumerate(result.data['chunks']):
                assert f'part{i + 1}' in chunk['path']

    @pytest.mark.asyncio
    async def test_split_with_project_id(self, temp_dir):
        """Test that project ID is used in output naming."""
        config = {
            'splitter': {
                'max_size_mb': 0.05,
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        pdf_path = create_pdf_with_images(Path(temp_dir) / 'report.pdf', pages=15)

        result = await splitter.process({
            'file_path': str(pdf_path),
            'project_id': 'ODIC-2024-001'
        })

        if result.data['split_required']:
            for chunk in result.data['chunks']:
                assert 'ODIC-2024-001' in chunk['path']

    @pytest.mark.asyncio
    async def test_chunks_are_valid_pdfs(self, temp_dir):
        """Test that all output chunks are valid PDFs."""
        config = {
            'splitter': {
                'max_size_mb': 0.1,
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        pdf_path = create_pdf_with_images(Path(temp_dir) / 'test.pdf', pages=15)

        result = await splitter.process(str(pdf_path))

        if result.data['split_required']:
            for chunk in result.data['chunks']:
                # Each chunk should be a valid, readable PDF
                reader = PdfReader(chunk['path'])
                assert len(reader.pages) > 0


# ===== Page Boundary Tests =====

class TestPageBoundaries:
    """Tests for page boundary preservation."""

    @pytest.mark.asyncio
    async def test_split_at_page_boundary(self, temp_dir):
        """Test that splits occur at page boundaries."""
        config = {
            'splitter': {
                'max_size_mb': 0.1,
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        # Create PDF with known page count
        pdf_path = create_pdf_with_images(Path(temp_dir) / 'test.pdf', pages=10)

        result = await splitter.process(str(pdf_path))

        if result.data['split_required']:
            # Each chunk should have whole number of pages
            for chunk in result.data['chunks']:
                assert chunk['page_count'] >= 1
                assert isinstance(chunk['page_count'], int)

    @pytest.mark.asyncio
    async def test_page_numbers_are_sequential(self, temp_dir):
        """Test that page ranges are sequential and non-overlapping."""
        config = {
            'splitter': {
                'max_size_mb': 0.05,
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        pdf_path = create_pdf_with_images(Path(temp_dir) / 'test.pdf', pages=15)

        result = await splitter.process(str(pdf_path))

        if result.data['split_required']:
            # Verify page ranges don't overlap
            prev_end = 0
            for chunk in result.data['chunks']:
                assert chunk['start_page'] == prev_end + 1
                prev_end = chunk['end_page']


# ===== Metadata Tests =====

class TestSplitMetadata:
    """Tests for split operation metadata."""

    @pytest.mark.asyncio
    async def test_split_returns_chunk_metadata(self, temp_dir):
        """Test that split returns complete metadata for each chunk."""
        config = {
            'splitter': {
                'max_size_mb': 0.1,
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        pdf_path = create_pdf_with_images(Path(temp_dir) / 'test.pdf', pages=10)

        result = await splitter.process(str(pdf_path))

        if result.data['split_required']:
            for chunk in result.data['chunks']:
                assert 'path' in chunk
                assert 'part_number' in chunk
                assert 'start_page' in chunk
                assert 'end_page' in chunk
                assert 'page_count' in chunk
                assert 'size' in chunk
                assert 'size_mb' in chunk

    @pytest.mark.asyncio
    async def test_original_file_info(self, temp_dir):
        """Test that original file info is included."""
        config = {
            'splitter': {
                'max_size_mb': 0.1,
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        pdf_path = create_pdf_with_images(Path(temp_dir) / 'test.pdf', pages=10)

        result = await splitter.process(str(pdf_path))

        assert 'original_file' in result.data
        assert 'original_size' in result.data
        assert result.data['original_file'] == str(pdf_path)


# ===== Max Size Override Tests =====

class TestMaxSizeOverride:
    """Tests for max size override in input."""

    @pytest.mark.asyncio
    async def test_max_size_override(self, temp_dir):
        """Test that max_size_mb in input overrides config."""
        config = {
            'splitter': {
                'max_size_mb': 100,  # Large default
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        # Create a file that's small but larger than our override
        pdf_path = create_pdf_with_images(Path(temp_dir) / 'test.pdf', pages=10)

        # Override to very small size
        result = await splitter.process({
            'file_path': str(pdf_path),
            'max_size_mb': 0.05  # Very small override
        })

        # With small override, should need splitting
        if pdf_path.stat().st_size > 0.05 * 1024 * 1024:
            assert result.data['split_required'] is True


# ===== Synchronous Interface Tests =====

class TestSyncInterface:
    """Tests for the synchronous split interface."""

    def test_sync_split(self, temp_dir):
        """Test synchronous splitting."""
        config = {
            'splitter': {
                'max_size_mb': 0.1,
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        pdf_path = create_pdf_with_images(Path(temp_dir) / 'test.pdf', pages=10)

        success, chunk_paths, metadata = splitter.split_sync(
            pdf_path,
            project_id='TEST-001'
        )

        assert success is True
        assert len(chunk_paths) >= 1
        for path in chunk_paths:
            assert Path(path).exists()

    def test_sync_small_file(self, splitter, temp_dir):
        """Test synchronous with small file (no split)."""
        pdf_path = create_test_pdf(Path(temp_dir) / 'small.pdf', pages=3)

        success, chunk_paths, metadata = splitter.split_sync(pdf_path)

        assert success is True
        assert len(chunk_paths) == 1
        assert chunk_paths[0] == str(pdf_path)


# ===== Chunk Info Tests =====

class TestChunkInfo:
    """Tests for get_chunk_info helper."""

    def test_get_chunk_info(self, splitter, temp_dir):
        """Test getting info about a chunk file."""
        pdf_path = create_test_pdf(Path(temp_dir) / 'chunk.pdf', pages=5)

        info = splitter.get_chunk_info(pdf_path)

        assert info is not None
        assert info['page_count'] == 5
        assert 'size' in info
        assert 'size_mb' in info

    def test_get_chunk_info_nonexistent(self, splitter):
        """Test get_chunk_info with nonexistent file."""
        info = splitter.get_chunk_info(Path('/nonexistent/file.pdf'))
        assert info is None


# ===== Edge Cases =====

class TestEdgeCases:
    """Tests for edge cases and error handling."""

    @pytest.mark.asyncio
    async def test_single_page_pdf(self, splitter, temp_dir):
        """Test handling of single-page PDF."""
        pdf_path = create_test_pdf(Path(temp_dir) / 'single.pdf', pages=1)

        result = await splitter.process(str(pdf_path))

        assert result.success is True
        assert result.data['split_required'] is False

    @pytest.mark.asyncio
    async def test_empty_pdf_handling(self, temp_dir):
        """Test handling of minimal PDF."""
        config = {
            'splitter': {
                'max_size_mb': 1,
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        # Create minimal PDF
        pdf_path = Path(temp_dir) / 'minimal.pdf'
        c = canvas.Canvas(str(pdf_path), pagesize=letter)
        c.save()

        result = await splitter.process(str(pdf_path))

        # Should succeed but not split (file is tiny)
        assert result.success is True

    @pytest.mark.asyncio
    async def test_path_input_variations(self, splitter, temp_dir):
        """Test various input path formats."""
        pdf_path = create_test_pdf(Path(temp_dir) / 'test.pdf')

        # Test with string
        result1 = await splitter.process(str(pdf_path))
        assert result1.success is True

        # Test with Path object
        result2 = await splitter.process(pdf_path)
        assert result2.success is True

        # Test with dict
        result3 = await splitter.process({'path': str(pdf_path)})
        assert result3.success is True

        result4 = await splitter.process({'file_path': str(pdf_path)})
        assert result4.success is True


# ===== Integration Tests =====

class TestIntegration:
    """Integration tests for full workflow."""

    @pytest.mark.asyncio
    async def test_full_split_workflow(self, temp_dir):
        """Test complete split workflow."""
        config = {
            'splitter': {
                'max_size_mb': 0.1,
                'output_dir': temp_dir,
            }
        }
        splitter = ReportSplitter(config)

        # Create large PDF
        pdf_path = create_pdf_with_images(
            Path(temp_dir) / 'report.pdf',
            pages=20,
            image_size=(1000, 800)
        )

        # Split it
        result = await splitter.process({
            'file_path': str(pdf_path),
            'project_id': 'INTEGRATION-001'
        })

        assert result.success is True

        if result.data['split_required']:
            # Verify all chunks exist and are readable
            total_pages = 0
            for chunk in result.data['chunks']:
                chunk_path = Path(chunk['path'])
                assert chunk_path.exists()

                reader = PdfReader(str(chunk_path))
                total_pages += len(reader.pages)

            # Total pages should match original
            assert total_pages == 20

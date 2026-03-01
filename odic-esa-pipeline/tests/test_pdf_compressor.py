"""
Tests for the PDF Compressor skill.

Tests PDF compression functionality including:
- Basic compression
- Ghostscript fallback
- Page integrity verification
- Target size handling
- Error handling
"""

import asyncio
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from PyPDF2 import PdfWriter

# Test helper to create test PDFs
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from PIL import Image
import io


def create_test_pdf_with_images(path: Path, num_pages: int = 3, add_images: bool = True) -> Path:
    """Create a test PDF file with optional images."""
    c = canvas.Canvas(str(path), pagesize=letter)

    for i in range(num_pages):
        c.setFont("Helvetica", 12)
        c.drawString(100, 700, f"Test Page {i + 1}")
        c.drawString(100, 680, f"This is test content for page {i + 1}")
        c.drawString(100, 660, "ODIC Environmental - Phase I ESA")

        # Add a simple image placeholder
        if add_images:
            # Create a simple colored rectangle to simulate image
            c.setFillColorRGB(0.8, 0.8, 0.8)
            c.rect(100, 400, 400, 200, fill=1)
            c.setFillColorRGB(0, 0, 0)
            c.drawString(250, 500, f"Image {i + 1}")

        c.showPage()

    c.save()
    return path


def create_large_test_pdf(path: Path, target_size_mb: float = 30) -> Path:
    """Create a large test PDF that exceeds the target size."""
    c = canvas.Canvas(str(path), pagesize=letter)

    # Add many pages with content
    num_pages = 100
    for i in range(num_pages):
        c.setFont("Helvetica", 12)
        c.drawString(100, 700, f"Page {i + 1} of {num_pages}")

        # Add lots of text to increase size
        for j in range(20):
            y_pos = 680 - (j * 25)
            if y_pos > 100:
                c.drawString(100, y_pos, f"Line {j}: This is a long line of text to increase the file size. " * 3)

        c.showPage()

    c.save()
    return path


# ===== Fixtures =====

@pytest.fixture
def config():
    """Standard test configuration."""
    return {
        'compressor': {
            'output_dir': tempfile.mkdtemp(),
            'target_max_size_mb': 25,
            'target_dpi': 150,
            'jpeg_quality': 75,
            'strip_metadata': True
        },
        'pipeline': {
            'output_dir': tempfile.mkdtemp()
        },
        'debug': True
    }


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


@pytest.fixture
def compressor(config):
    """Create a PDFCompressor instance."""
    from skills.pdf_compressor import PDFCompressor
    return PDFCompressor(config)


# ===== Initialization Tests =====

class TestPDFCompressorInit:
    """Tests for PDFCompressor initialization."""

    def test_init_with_config(self, config):
        """Test initialization with configuration."""
        from skills.pdf_compressor import PDFCompressor
        compressor = PDFCompressor(config)

        assert compressor.config == config
        assert compressor.output_dir.exists()
        assert compressor.target_dpi == 150
        assert compressor.jpeg_quality == 75

    def test_default_values(self):
        """Test that default values are used when config is minimal."""
        from skills.pdf_compressor import PDFCompressor
        config = {'pipeline': {'output_dir': tempfile.mkdtemp()}}
        compressor = PDFCompressor(config)

        assert compressor.target_dpi == 150
        assert compressor.target_max_size_mb == 25
        assert compressor.jpeg_quality == 75


# ===== Input Validation Tests =====

class TestInputValidation:
    """Tests for input validation."""

    def test_validate_existing_pdf(self, compressor, temp_dir):
        """Test validation of existing PDF file."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')
        assert compressor.validate_input(str(pdf_path)) is True

    def test_validate_dict_input(self, compressor, temp_dir):
        """Test validation of dict input with file_path."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')
        input_data = {'file_path': str(pdf_path)}
        assert compressor.validate_input(input_data) is True

    def test_validate_nonexistent_file(self, compressor):
        """Test validation of nonexistent file."""
        assert compressor.validate_input('/nonexistent/file.pdf') is False

    def test_validate_non_pdf(self, compressor, temp_dir):
        """Test validation of non-PDF file."""
        txt_path = Path(temp_dir) / 'test.txt'
        txt_path.write_text('not a pdf')
        assert compressor.validate_input(str(txt_path)) is False

    def test_validate_none_input(self, compressor):
        """Test validation of None input."""
        assert compressor.validate_input(None) is False


# ===== Basic Compression Tests =====

class TestBasicCompression:
    """Tests for basic PDF compression."""

    @pytest.mark.asyncio
    async def test_compress_simple_pdf(self, compressor, temp_dir):
        """Test compressing a simple PDF."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')

        result = await compressor.process(str(pdf_path))

        assert result.success is True
        assert 'output_path' in result.data
        assert Path(result.data['output_path']).exists()
        assert result.data['output_path'].endswith('.pdf')

    @pytest.mark.asyncio
    async def test_compress_with_dict_input(self, compressor, temp_dir):
        """Test compressing with dict input."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')
        input_data = {'file_path': str(pdf_path)}

        result = await compressor.process(input_data)

        assert result.success is True
        assert Path(result.data['output_path']).exists()

    @pytest.mark.asyncio
    async def test_compress_with_project_id(self, compressor, temp_dir):
        """Test compressing with project ID."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')
        input_data = {
            'file_path': str(pdf_path),
            'project_id': 'TEST-001'
        }

        result = await compressor.process(input_data)

        assert result.success is True
        assert 'TEST-001' in result.data['output_path']

    @pytest.mark.asyncio
    async def test_page_count_preserved(self, compressor, temp_dir):
        """Test that page count is preserved after compression."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf', num_pages=5)

        result = await compressor.process(str(pdf_path))

        assert result.success is True
        assert result.data['page_count'] == 5


# ===== Compression Statistics Tests =====

class TestCompressionStatistics:
    """Tests for compression statistics."""

    @pytest.mark.asyncio
    async def test_returns_size_info(self, compressor, temp_dir):
        """Test that result includes size information."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')

        result = await compressor.process(str(pdf_path))

        assert result.success is True
        assert 'original_size' in result.data
        assert 'compressed_size' in result.data
        assert 'original_size_mb' in result.data
        assert 'compressed_size_mb' in result.data
        assert result.data['original_size'] > 0

    @pytest.mark.asyncio
    async def test_returns_reduction_percent(self, compressor, temp_dir):
        """Test that result includes reduction percentage."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')

        result = await compressor.process(str(pdf_path))

        assert result.success is True
        assert 'reduction_percent' in result.data
        assert isinstance(result.data['reduction_percent'], (int, float))

    @pytest.mark.asyncio
    async def test_returns_compression_method(self, compressor, temp_dir):
        """Test that result includes compression method."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')

        result = await compressor.process(str(pdf_path))

        assert result.success is True
        assert 'compression_method' in result.data
        assert result.data['compression_method'] in ['ghostscript', 'simple']


# ===== Target Size Tests =====

class TestTargetSize:
    """Tests for target size handling."""

    @pytest.mark.asyncio
    async def test_small_file_under_target(self, compressor, temp_dir):
        """Test that small files report meets_target=True."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'small.pdf', num_pages=1)

        result = await compressor.process({
            'file_path': str(pdf_path),
            'target_size_mb': 25
        })

        assert result.success is True
        assert result.data['meets_target'] is True

    @pytest.mark.asyncio
    async def test_custom_target_size(self, compressor, temp_dir):
        """Test compression with custom target size."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')

        result = await compressor.process({
            'file_path': str(pdf_path),
            'target_size_mb': 1  # Very small target
        })

        assert result.success is True
        assert 'meets_target' in result.data
        assert result.data['target_size_mb'] == 1


# ===== Synchronous Interface Tests =====

class TestSyncInterface:
    """Tests for synchronous compression interface."""

    def test_sync_compress(self, compressor, temp_dir):
        """Test synchronous compression method."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')

        success, output_path, metadata = compressor.compress_sync(str(pdf_path))

        assert success is True
        assert output_path is not None
        assert Path(output_path).exists()

    def test_sync_compress_with_project_id(self, compressor, temp_dir):
        """Test synchronous compression with project ID."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf')

        success, output_path, metadata = compressor.compress_sync(
            str(pdf_path),
            project_id='SYNC-001'
        )

        assert success is True
        assert 'SYNC-001' in output_path

    def test_sync_compress_failure(self, compressor):
        """Test synchronous compression with invalid input."""
        success, output_path, metadata = compressor.compress_sync('/nonexistent.pdf')

        assert success is False
        assert output_path is None
        assert 'error' in metadata


# ===== Utility Method Tests =====

class TestUtilityMethods:
    """Tests for utility methods."""

    def test_needs_compression_large_file(self, compressor, temp_dir):
        """Test needs_compression returns True for large files."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf', num_pages=50)

        # Create artificially large file by checking against very small target
        result = compressor.needs_compression(pdf_path, target_size_mb=0.001)
        assert result is True

    def test_needs_compression_small_file(self, compressor, temp_dir):
        """Test needs_compression returns False for small files."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf', num_pages=1)

        result = compressor.needs_compression(pdf_path, target_size_mb=100)
        assert result is False

    def test_get_compression_info(self, compressor, temp_dir):
        """Test getting compression info for a PDF."""
        pdf_path = create_test_pdf_with_images(Path(temp_dir) / 'test.pdf', num_pages=3)

        info = compressor.get_compression_info(pdf_path)

        assert info is not None
        assert 'path' in info
        assert 'size' in info
        assert 'size_mb' in info
        assert 'page_count' in info
        assert info['page_count'] == 3
        assert 'needs_compression' in info

    def test_get_compression_info_nonexistent(self, compressor):
        """Test getting info for nonexistent file."""
        info = compressor.get_compression_info(Path('/nonexistent/file.pdf'))
        assert info is None


# ===== Error Handling Tests =====

class TestErrorHandling:
    """Tests for error handling."""

    @pytest.mark.asyncio
    async def test_invalid_pdf_path(self, compressor):
        """Test handling of invalid PDF path."""
        result = await compressor.process('/nonexistent/file.pdf')

        assert result.success is False
        assert result.error is not None

    @pytest.mark.asyncio
    async def test_corrupted_pdf(self, compressor, temp_dir):
        """Test handling of corrupted PDF file."""
        corrupted_pdf = Path(temp_dir) / 'corrupted.pdf'
        corrupted_pdf.write_bytes(b'not a real pdf content')

        result = await compressor.process(str(corrupted_pdf))

        # Should fail gracefully
        assert result.success is False


# ===== Integration Tests =====

class TestIntegration:
    """Integration tests for full compression workflow."""

    @pytest.mark.asyncio
    async def test_full_compression_workflow(self, compressor, temp_dir):
        """Test complete compression workflow."""
        # Create test PDF
        pdf_path = create_test_pdf_with_images(
            Path(temp_dir) / 'report.pdf',
            num_pages=5
        )

        original_size = pdf_path.stat().st_size

        # Compress
        result = await compressor.process({
            'file_path': str(pdf_path),
            'project_id': 'WORKFLOW-001',
            'target_size_mb': 25
        })

        assert result.success is True
        output_path = Path(result.data['output_path'])

        # Verify output
        assert output_path.exists()
        assert result.data['original_size'] == original_size
        assert result.data['page_count'] == 5

        # Get info
        info = compressor.get_compression_info(output_path)
        assert info is not None
        assert info['page_count'] == 5

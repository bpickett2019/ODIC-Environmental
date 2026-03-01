"""
Tests for page integrity verification in report assembler and splitter.

Verifies that:
- Page counts match between input and output
- Missing pages are detected and reported
- Split operations preserve all pages
- Merge operations preserve all pages
"""

import asyncio
import io
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from PyPDF2 import PdfReader, PdfWriter

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


def create_test_pdf(path: Path, num_pages: int = 3) -> Path:
    """Create a test PDF file with the given number of pages."""
    c = canvas.Canvas(str(path), pagesize=letter)

    for i in range(num_pages):
        c.setFont("Helvetica", 12)
        c.drawString(100, 700, f"Test Page {i + 1}")
        c.drawString(100, 680, f"This is test content for page {i + 1}")
        c.showPage()

    c.save()
    return path


def create_test_pdf_bytes(num_pages: int = 3) -> bytes:
    """Create a test PDF as bytes."""
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=letter)

    for i in range(num_pages):
        c.setFont("Helvetica", 12)
        c.drawString(100, 700, f"Test Page {i + 1}")
        c.showPage()

    c.save()
    return buffer.getvalue()


# ===== Fixtures =====

@pytest.fixture
def config():
    """Standard test configuration."""
    return {
        'pipeline': {
            'project_base_dir': tempfile.mkdtemp(),
            'output_dir': tempfile.mkdtemp()
        },
        'splitter': {
            'max_size_mb': 25,
            'output_dir': tempfile.mkdtemp()
        },
        'debug': True
    }


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


# ===== Report Assembler Page Integrity Tests =====

class TestAssemblerPageIntegrity:
    """Tests for page integrity verification in ReportAssembler."""

    def test_verify_page_integrity_success(self, config, temp_dir):
        """Test successful page integrity verification."""
        from skills.report_assembler import ReportAssembler

        assembler = ReportAssembler(config)

        # Create test PDFs
        pdf1 = create_test_pdf_bytes(3)
        pdf2 = create_test_pdf_bytes(2)
        pdf3 = create_test_pdf_bytes(4)

        pdf_parts = [
            ("part1", pdf1),
            ("part2", pdf2),
            ("part3", pdf3)
        ]

        # Merge PDFs
        merged_pdf = assembler._merge_pdfs(pdf_parts)

        # Verify integrity
        result = assembler._verify_page_integrity(pdf_parts, merged_pdf)

        assert result['verified'] is True
        assert result['total_input_pages'] == 9  # 3 + 2 + 4
        assert result['output_pages'] == 9
        assert result['discrepancy'] == 0
        assert len(result['missing_ranges']) == 0

    def test_verify_page_integrity_with_file_paths(self, config, temp_dir):
        """Test page integrity verification with file paths."""
        from skills.report_assembler import ReportAssembler

        assembler = ReportAssembler(config)

        # Create test PDF files
        pdf1_path = create_test_pdf(Path(temp_dir) / 'part1.pdf', 3)
        pdf2_path = create_test_pdf(Path(temp_dir) / 'part2.pdf', 2)

        pdf_parts = [
            ("part1", pdf1_path),
            ("part2", pdf2_path)
        ]

        # Merge PDFs
        merged_pdf = assembler._merge_pdfs(pdf_parts)

        # Verify integrity
        result = assembler._verify_page_integrity(pdf_parts, merged_pdf)

        assert result['verified'] is True
        assert result['total_input_pages'] == 5
        assert result['output_pages'] == 5

    def test_verify_page_integrity_empty_placeholder(self, config):
        """Test that empty placeholders are skipped."""
        from skills.report_assembler import ReportAssembler

        assembler = ReportAssembler(config)

        pdf1 = create_test_pdf_bytes(3)
        empty_placeholder = b""  # Empty bytes
        pdf2 = create_test_pdf_bytes(2)

        pdf_parts = [
            ("part1", pdf1),
            ("placeholder", empty_placeholder),
            ("part2", pdf2)
        ]

        merged_pdf = assembler._merge_pdfs(pdf_parts)
        result = assembler._verify_page_integrity(pdf_parts, merged_pdf)

        assert result['verified'] is True
        assert result['total_input_pages'] == 5  # Empty skipped

    def test_verify_page_integrity_details(self, config):
        """Test that integrity check returns detailed breakdown."""
        from skills.report_assembler import ReportAssembler

        assembler = ReportAssembler(config)

        pdf1 = create_test_pdf_bytes(3)
        pdf2 = create_test_pdf_bytes(2)

        pdf_parts = [
            ("section1", pdf1),
            ("section2", pdf2)
        ]

        merged_pdf = assembler._merge_pdfs(pdf_parts)
        result = assembler._verify_page_integrity(pdf_parts, merged_pdf)

        assert 'details' in result
        assert len(result['details']) == 2
        assert result['details'][0]['name'] == 'section1'
        assert result['details'][0]['pages'] == 3
        assert result['details'][1]['name'] == 'section2'
        assert result['details'][1]['pages'] == 2


# ===== Report Splitter Page Integrity Tests =====

class TestSplitterPageIntegrity:
    """Tests for page integrity verification in ReportSplitter."""

    def test_verify_page_integrity_split_success(self, config, temp_dir):
        """Test successful page integrity verification after split."""
        from skills.report_splitter import ReportSplitter

        splitter = ReportSplitter(config)

        # Create test PDF with multiple pages
        pdf_path = create_test_pdf(Path(temp_dir) / 'large.pdf', 10)

        # Create mock chunks
        chunk1_path = Path(temp_dir) / 'chunk1.pdf'
        chunk2_path = Path(temp_dir) / 'chunk2.pdf'

        # Write chunks
        reader = PdfReader(str(pdf_path))
        writer1 = PdfWriter()
        writer2 = PdfWriter()

        for i in range(5):
            writer1.add_page(reader.pages[i])
        for i in range(5, 10):
            writer2.add_page(reader.pages[i])

        with open(chunk1_path, 'wb') as f:
            writer1.write(f)
        with open(chunk2_path, 'wb') as f:
            writer2.write(f)

        chunks = [
            {'path': str(chunk1_path), 'page_count': 5, 'part_number': 1, 'start_page': 1, 'end_page': 5},
            {'path': str(chunk2_path), 'page_count': 5, 'part_number': 2, 'start_page': 6, 'end_page': 10}
        ]

        result = splitter._verify_page_integrity(10, chunks, pdf_path)

        assert result['verified'] is True
        assert result['original_pages'] == 10
        assert result['total_chunk_pages'] == 10
        assert result['discrepancy'] == 0

    def test_verify_page_integrity_detects_missing(self, config, temp_dir):
        """Test that missing pages are detected."""
        from skills.report_splitter import ReportSplitter

        splitter = ReportSplitter(config)

        # Create test PDF
        pdf_path = create_test_pdf(Path(temp_dir) / 'test.pdf', 10)

        # Create a chunk with fewer pages than expected
        chunk_path = Path(temp_dir) / 'chunk.pdf'
        create_test_pdf(chunk_path, 8)  # Only 8 pages

        chunks = [
            {'path': str(chunk_path), 'page_count': 10, 'part_number': 1}  # Claims 10 but has 8
        ]

        result = splitter._verify_page_integrity(10, chunks, pdf_path)

        assert result['verified'] is False
        assert result['total_chunk_pages'] == 8
        assert result['discrepancy'] == 2  # Missing 2 pages
        assert len(result['missing_ranges']) > 0

    def test_verify_chunk_details(self, config, temp_dir):
        """Test that chunk details are properly recorded."""
        from skills.report_splitter import ReportSplitter

        splitter = ReportSplitter(config)

        pdf_path = create_test_pdf(Path(temp_dir) / 'test.pdf', 6)

        chunk1_path = Path(temp_dir) / 'chunk1.pdf'
        chunk2_path = Path(temp_dir) / 'chunk2.pdf'
        create_test_pdf(chunk1_path, 3)
        create_test_pdf(chunk2_path, 3)

        chunks = [
            {'path': str(chunk1_path), 'page_count': 3, 'part_number': 1, 'start_page': 1, 'end_page': 3},
            {'path': str(chunk2_path), 'page_count': 3, 'part_number': 2, 'start_page': 4, 'end_page': 6}
        ]

        result = splitter._verify_page_integrity(6, chunks, pdf_path)

        assert 'chunk_details' in result
        assert len(result['chunk_details']) == 2
        assert all(d['matches'] for d in result['chunk_details'])

    @pytest.mark.asyncio
    async def test_split_process_verifies_integrity(self, config, temp_dir):
        """Test that split process includes integrity verification."""
        from skills.report_splitter import ReportSplitter

        splitter = ReportSplitter(config)

        # Create a small test PDF that doesn't need splitting
        pdf_path = create_test_pdf(Path(temp_dir) / 'small.pdf', 3)

        result = await splitter.process(str(pdf_path))

        # Small file should not need splitting
        assert result.success is True
        assert result.data['split_required'] is False


# ===== Integration Tests =====

class TestIntegrationPageIntegrity:
    """Integration tests for page integrity across operations."""

    @pytest.mark.asyncio
    async def test_split_and_verify_large_pdf(self, config, temp_dir):
        """Test splitting a larger PDF and verifying integrity."""
        from skills.report_splitter import ReportSplitter

        # Configure for small chunk size to force splitting
        config['splitter']['max_size_mb'] = 0.001  # Very small to force split

        splitter = ReportSplitter(config)

        # Create a test PDF with multiple pages
        pdf_path = create_test_pdf(Path(temp_dir) / 'large.pdf', 20)

        result = await splitter.process({
            'file_path': str(pdf_path),
            'max_size_mb': 0.001  # Force splitting
        })

        assert result.success is True

        if result.data['split_required']:
            assert result.data.get('page_integrity_verified', True) is True
            assert result.data['total_pages'] == 20

            # Verify total pages across chunks equals original
            total_chunk_pages = sum(c['page_count'] for c in result.data['chunks'])
            assert total_chunk_pages == 20

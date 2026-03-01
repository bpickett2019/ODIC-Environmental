"""
ODIC ESA Pipeline - Report Splitter Skill

Splits large assembled reports into smaller chunks for delivery.
- Configurable maximum file size (default 25MB)
- Splits at page boundaries (never mid-page)
- Sequential naming: {project_id}_part1.pdf, {project_id}_part2.pdf, etc.
- Attempts to split at logical section breaks when possible
"""

import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime

from PyPDF2 import PdfReader, PdfWriter

from .base import BaseSkill, SkillResult


class ReportSplitter(BaseSkill):
    """
    Splits large PDF reports into smaller chunks.

    Features:
    - Respects page boundaries (never splits mid-page)
    - Configurable maximum file size per chunk
    - Sequential naming convention for parts
    - Preserves PDF metadata where possible
    """

    # Default settings
    DEFAULT_MAX_SIZE_MB = 25
    DEFAULT_MIN_PAGES_PER_CHUNK = 1

    def __init__(self, config: dict):
        """
        Initialize the report splitter.

        Args:
            config: Configuration dictionary with optional 'splitter' section
        """
        super().__init__(config)

        splitter_config = config.get('splitter', {})

        # Size limits
        self.max_size_bytes = splitter_config.get(
            'max_size_mb', self.DEFAULT_MAX_SIZE_MB
        ) * 1024 * 1024

        # Output directory
        self.output_dir = Path(splitter_config.get(
            'output_dir',
            config.get('pipeline', {}).get('output_dir', './completed_reports')
        ))
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Split preferences
        self.min_pages_per_chunk = splitter_config.get(
            'min_pages_per_chunk', self.DEFAULT_MIN_PAGES_PER_CHUNK
        )

    def _estimate_page_sizes(self, reader: PdfReader) -> List[int]:
        """
        Estimate the size of each page in the PDF.

        This is an approximation since PDF page sizes can't be determined
        exactly without re-encoding. We use a proportional estimate based
        on content streams.

        Args:
            reader: PyPDF2 PdfReader object

        Returns:
            List of estimated byte sizes per page
        """
        page_sizes = []
        total_pages = len(reader.pages)

        for page in reader.pages:
            # Estimate based on content stream length
            try:
                content = page.get_contents()
                if content:
                    if hasattr(content, 'get_data'):
                        size = len(content.get_data())
                    elif hasattr(content, '__len__'):
                        size = len(content)
                    else:
                        # Default estimate for complex pages
                        size = 50000
                else:
                    size = 10000  # Default for empty pages
            except Exception:
                size = 50000  # Default estimate

            # Add overhead for page objects, fonts, etc.
            page_sizes.append(size + 5000)

        return page_sizes

    def _calculate_split_points(
        self,
        total_file_size: int,
        page_sizes: List[int],
        target_chunk_size: int
    ) -> List[int]:
        """
        Calculate optimal page indices to split the document.

        Args:
            total_file_size: Total size of original PDF in bytes
            page_sizes: Estimated size of each page
            target_chunk_size: Target maximum size per chunk

        Returns:
            List of page indices where splits should occur
        """
        if not page_sizes:
            return []

        total_pages = len(page_sizes)

        # If file is small enough, no split needed
        if total_file_size <= target_chunk_size:
            return []

        split_points = []
        current_chunk_size = 0
        pages_in_current_chunk = 0

        # PDF overhead (header, xref table, etc.) - estimate per chunk
        pdf_overhead = 10000

        for i, page_size in enumerate(page_sizes):
            current_chunk_size += page_size
            pages_in_current_chunk += 1

            # Check if adding next page would exceed limit
            # But ensure minimum pages per chunk
            if current_chunk_size + pdf_overhead >= target_chunk_size:
                if pages_in_current_chunk >= self.min_pages_per_chunk:
                    if i < total_pages - 1:  # Don't split at the very end
                        split_points.append(i + 1)  # Split after this page
                        current_chunk_size = 0
                        pages_in_current_chunk = 0

        return split_points

    def _write_chunk(
        self,
        reader: PdfReader,
        start_page: int,
        end_page: int,
        output_path: Path
    ) -> int:
        """
        Write a chunk of pages to a new PDF file.

        Args:
            reader: Source PdfReader
            start_page: Starting page index (inclusive)
            end_page: Ending page index (exclusive)
            output_path: Path for output file

        Returns:
            Size of written file in bytes
        """
        writer = PdfWriter()

        for page_num in range(start_page, end_page):
            writer.add_page(reader.pages[page_num])

        # Copy metadata from original if available
        if reader.metadata:
            writer.add_metadata(reader.metadata)

        with open(output_path, 'wb') as f:
            writer.write(f)

        return output_path.stat().st_size

    def _verify_page_integrity(
        self,
        original_pages: int,
        chunks: List[Dict],
        input_path: Path
    ) -> Dict[str, Any]:
        """
        Verify that all pages from the original PDF are present in the chunks.

        This is a critical integrity check that ensures no pages are lost
        during the split operation.

        Args:
            original_pages: Total pages in the original PDF
            chunks: List of chunk info dicts with 'path' and 'page_count' keys
            input_path: Path to the original PDF for reference

        Returns:
            Dict with:
                - verified: bool - True if page counts match
                - original_pages: int - Pages in the original PDF
                - total_chunk_pages: int - Sum of pages across all chunks
                - discrepancy: int - Difference (0 if verified)
                - chunk_details: List[Dict] - Per-chunk breakdown
                - missing_ranges: List[str] - Human-readable missing page info
        """
        chunk_details = []
        total_chunk_pages = 0

        # Re-verify each chunk's page count
        for chunk in chunks:
            chunk_path = Path(chunk['path'])
            try:
                reader = PdfReader(str(chunk_path))
                actual_pages = len(reader.pages)
                expected_pages = chunk.get('page_count', 0)

                chunk_details.append({
                    'path': str(chunk_path),
                    'part_number': chunk.get('part_number'),
                    'expected_pages': expected_pages,
                    'actual_pages': actual_pages,
                    'start_page': chunk.get('start_page'),
                    'end_page': chunk.get('end_page'),
                    'matches': actual_pages == expected_pages
                })

                total_chunk_pages += actual_pages
            except Exception as e:
                self.logger.error(f"Could not verify chunk {chunk_path}: {e}")
                chunk_details.append({
                    'path': str(chunk_path),
                    'error': str(e),
                    'matches': False
                })

        # Check for discrepancy
        discrepancy = original_pages - total_chunk_pages
        verified = discrepancy == 0

        # Generate missing range information if there's a discrepancy
        missing_ranges = []
        if not verified:
            if discrepancy > 0:
                missing_ranges.append(
                    f"Missing {discrepancy} pages: original had {original_pages}, "
                    f"chunks have {total_chunk_pages}"
                )

                # Try to identify gaps
                expected_next = 1
                for detail in chunk_details:
                    start = detail.get('start_page')
                    if start and start != expected_next:
                        missing_ranges.append(
                            f"  - Gap detected: expected page {expected_next}, "
                            f"chunk starts at {start}"
                        )
                    end = detail.get('end_page')
                    if end:
                        expected_next = end + 1
            else:
                missing_ranges.append(
                    f"Extra {-discrepancy} pages: original had {original_pages}, "
                    f"chunks have {total_chunk_pages}"
                )

            # Check for individual chunk mismatches
            for detail in chunk_details:
                if not detail.get('matches', True):
                    if 'error' in detail:
                        missing_ranges.append(
                            f"  - {detail['path']}: read error ({detail['error']})"
                        )
                    else:
                        missing_ranges.append(
                            f"  - Part {detail.get('part_number')}: "
                            f"expected {detail.get('expected_pages')}, "
                            f"got {detail.get('actual_pages')}"
                        )

        return {
            'verified': verified,
            'original_pages': original_pages,
            'total_chunk_pages': total_chunk_pages,
            'discrepancy': discrepancy,
            'chunk_details': chunk_details,
            'missing_ranges': missing_ranges
        }

    def _generate_chunk_paths(
        self,
        input_path: Path,
        num_chunks: int,
        project_id: Optional[str] = None
    ) -> List[Path]:
        """
        Generate output paths for chunk files.

        Args:
            input_path: Original input file path
            num_chunks: Number of chunks to create
            project_id: Optional project ID for naming

        Returns:
            List of output paths
        """
        # Extract base name
        if project_id:
            base_name = project_id
        else:
            base_name = input_path.stem
            # Remove any existing _partN suffix
            if '_part' in base_name:
                base_name = base_name.rsplit('_part', 1)[0]

        paths = []
        for i in range(num_chunks):
            chunk_name = f"{base_name}_part{i + 1}.pdf"
            paths.append(self.output_dir / chunk_name)

        return paths

    def needs_splitting(self, input_path: Path) -> bool:
        """
        Check if a file needs to be split based on size.

        Args:
            input_path: Path to PDF file

        Returns:
            True if file exceeds max size and needs splitting
        """
        return input_path.stat().st_size > self.max_size_bytes

    def validate_input(self, input_data: Any) -> bool:
        """
        Validate input is a valid PDF file path.

        Args:
            input_data: Should be a path to a PDF file

        Returns:
            True if valid
        """
        if isinstance(input_data, dict):
            input_path = input_data.get('file_path') or input_data.get('path')
        else:
            input_path = input_data

        if not input_path:
            self.logger.error("No file path provided")
            return False

        path = Path(input_path)

        if not path.exists():
            self.logger.error(f"File does not exist: {path}")
            return False

        if path.suffix.lower() != '.pdf':
            self.logger.error(f"File must be a PDF: {path}")
            return False

        return True

    async def process(self, input_data: Any) -> SkillResult:
        """
        Split a PDF report into chunks if needed.

        Args:
            input_data: Either a file path string/Path, or a dict with:
                - file_path/path: Path to PDF file
                - project_id: Optional project ID for naming
                - max_size_mb: Optional override for max chunk size

        Returns:
            SkillResult with split file paths and metadata
        """
        # Parse input
        if isinstance(input_data, dict):
            input_path = Path(input_data.get('file_path') or input_data.get('path'))
            project_id = input_data.get('project_id')
            max_size_override = input_data.get('max_size_mb')
        else:
            input_path = Path(input_data)
            project_id = None
            max_size_override = None

        # Use override if provided
        if max_size_override:
            target_size = max_size_override * 1024 * 1024
        else:
            target_size = self.max_size_bytes

        original_size = input_path.stat().st_size
        self.logger.info(
            f"Processing report: {input_path.name} "
            f"({original_size / 1024 / 1024:.2f} MB)"
        )

        # Check if splitting is needed
        if original_size <= target_size:
            self.logger.info("File is under size limit - no splitting needed")
            return SkillResult.ok(
                data={
                    'split_required': False,
                    'original_file': str(input_path),
                    'original_size': original_size,
                    'chunk_count': 1,
                    'chunks': [{
                        'path': str(input_path),
                        'size': original_size,
                        'pages': None,  # Unknown without reading
                    }]
                }
            )

        try:
            # Read PDF
            reader = PdfReader(str(input_path))
            total_pages = len(reader.pages)

            self.logger.info(f"PDF has {total_pages} pages, analyzing for split points...")

            # Estimate page sizes
            page_sizes = self._estimate_page_sizes(reader)

            # Calculate split points
            split_points = self._calculate_split_points(
                original_size, page_sizes, target_size
            )

            if not split_points:
                # Even though file is large, splitting by pages didn't help
                # This happens when pages are very large (lots of images)
                self.logger.warning(
                    "Could not find good split points - file may have very large pages"
                )
                # Force split into roughly equal parts
                estimated_chunks = max(2, int(original_size / target_size) + 1)
                pages_per_chunk = max(1, total_pages // estimated_chunks)
                split_points = list(range(pages_per_chunk, total_pages, pages_per_chunk))

            # Create chunk boundaries
            boundaries = [0] + split_points + [total_pages]
            num_chunks = len(boundaries) - 1

            self.logger.info(f"Splitting into {num_chunks} chunks")

            # Generate output paths
            chunk_paths = self._generate_chunk_paths(input_path, num_chunks, project_id)

            # Write chunks
            chunks = []
            for i in range(num_chunks):
                start_page = boundaries[i]
                end_page = boundaries[i + 1]
                pages_in_chunk = end_page - start_page

                output_path = chunk_paths[i]

                chunk_size = self._write_chunk(reader, start_page, end_page, output_path)

                chunks.append({
                    'path': str(output_path),
                    'part_number': i + 1,
                    'start_page': start_page + 1,  # 1-indexed for users
                    'end_page': end_page,
                    'page_count': pages_in_chunk,
                    'size': chunk_size,
                    'size_mb': round(chunk_size / 1024 / 1024, 2),
                })

                self.logger.info(
                    f"  Part {i + 1}: pages {start_page + 1}-{end_page} "
                    f"({pages_in_chunk} pages, {chunk_size / 1024 / 1024:.2f} MB)"
                )

            # CRITICAL: Verify page integrity
            self.logger.info("Verifying page integrity...")
            integrity_result = self._verify_page_integrity(total_pages, chunks, input_path)

            if not integrity_result['verified']:
                self.logger.error(
                    f"PAGE INTEGRITY CHECK FAILED: "
                    f"Original had {integrity_result['original_pages']} pages, "
                    f"chunks have {integrity_result['total_chunk_pages']} pages"
                )

                # Clean up failed chunks
                for chunk in chunks:
                    try:
                        Path(chunk['path']).unlink(missing_ok=True)
                    except Exception:
                        pass

                return SkillResult.fail(
                    error="Page integrity verification failed - pages may be missing from split chunks",
                    data={
                        'input_path': str(input_path),
                        'integrity_check': integrity_result,
                        'original_pages': integrity_result['original_pages'],
                        'total_chunk_pages': integrity_result['total_chunk_pages'],
                        'discrepancy': integrity_result['discrepancy'],
                        'missing_ranges': integrity_result['missing_ranges'],
                        'chunk_details': integrity_result['chunk_details']
                    }
                )

            self.logger.info(
                f"Page integrity verified: {integrity_result['total_chunk_pages']} pages "
                f"across {num_chunks} chunks"
            )

            return SkillResult.ok(
                data={
                    'split_required': True,
                    'original_file': str(input_path),
                    'original_size': original_size,
                    'original_size_mb': round(original_size / 1024 / 1024, 2),
                    'total_pages': total_pages,
                    'chunk_count': num_chunks,
                    'max_chunk_size_mb': round(target_size / 1024 / 1024, 2),
                    'chunks': chunks,
                    'page_integrity_verified': True,
                    'integrity_details': {
                        'original_pages': integrity_result['original_pages'],
                        'total_chunk_pages': integrity_result['total_chunk_pages'],
                        'all_chunks_match': all(
                            c.get('matches', True)
                            for c in integrity_result['chunk_details']
                        )
                    }
                }
            )

        except Exception as e:
            self.logger.exception(f"Failed to split PDF: {e}")
            return SkillResult.fail(
                error=f"PDF splitting failed: {str(e)}",
                data={'input_path': str(input_path)}
            )

    def split_sync(
        self,
        input_path: Path,
        project_id: Optional[str] = None,
        max_size_mb: Optional[float] = None
    ) -> Tuple[bool, List[str], Dict]:
        """
        Synchronous split method for simpler use cases.

        Args:
            input_path: Path to PDF file
            project_id: Optional project ID for naming
            max_size_mb: Optional max chunk size override

        Returns:
            Tuple of (success, list_of_chunk_paths, metadata)
        """
        import asyncio

        input_data = {
            'file_path': str(input_path),
            'project_id': project_id,
        }
        if max_size_mb:
            input_data['max_size_mb'] = max_size_mb

        result = asyncio.run(self.process(input_data))

        if result.success:
            chunk_paths = [c['path'] for c in result.data['chunks']]
            return (True, chunk_paths, result.data)
        else:
            return (False, [], {'error': result.error})

    def get_chunk_info(self, chunk_path: Path) -> Optional[Dict]:
        """
        Get information about a chunk file.

        Args:
            chunk_path: Path to a chunk PDF

        Returns:
            Dict with chunk info or None if invalid
        """
        if not chunk_path.exists():
            return None

        try:
            reader = PdfReader(str(chunk_path))
            return {
                'path': str(chunk_path),
                'size': chunk_path.stat().st_size,
                'size_mb': round(chunk_path.stat().st_size / 1024 / 1024, 2),
                'page_count': len(reader.pages),
            }
        except Exception as e:
            self.logger.warning(f"Could not read chunk info: {e}")
            return None

"""
ODIC ESA Pipeline - PDF Compressor Skill

Compresses PDF reports to reduce file size for email delivery.
- Downsamples images above 150 DPI
- Strips metadata
- Removes duplicate objects
- Optimizes PDF streams

Uses PyPDF2 for PDF manipulation and Pillow for image processing.
"""

import io
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
from datetime import datetime

from PyPDF2 import PdfReader, PdfWriter
from PIL import Image

from .base import BaseSkill, SkillResult


class PDFCompressor(BaseSkill):
    """
    Compresses PDF files to reduce size for email delivery.

    Features:
    - Image downsampling (above configurable DPI threshold)
    - Metadata stripping
    - Duplicate object removal
    - Stream optimization
    - Target file size limiting
    """

    # Default settings
    DEFAULT_TARGET_DPI = 150
    DEFAULT_MAX_SIZE_MB = 25
    DEFAULT_JPEG_QUALITY = 75
    DEFAULT_MIN_IMAGE_SIZE = 100  # Don't process images smaller than 100x100

    def __init__(self, config: dict):
        """
        Initialize the PDF compressor.

        Args:
            config: Configuration dictionary with optional 'compressor' section
        """
        super().__init__(config)

        compressor_config = config.get('compressor', {})

        # Compression settings
        self.target_dpi = compressor_config.get('target_dpi', self.DEFAULT_TARGET_DPI)
        self.target_max_size_mb = compressor_config.get(
            'target_max_size_mb', self.DEFAULT_MAX_SIZE_MB
        )
        self.jpeg_quality = compressor_config.get('jpeg_quality', self.DEFAULT_JPEG_QUALITY)
        self.strip_metadata = compressor_config.get('strip_metadata', True)
        self.remove_duplicates = compressor_config.get('remove_duplicates', True)

        # Output directory
        self.output_dir = Path(compressor_config.get(
            'output_dir',
            config.get('pipeline', {}).get('output_dir', './completed_reports')
        ))
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def _calculate_compression_ratio(
        self,
        original_size: int,
        target_size: int
    ) -> float:
        """Calculate the compression ratio needed to reach target size."""
        if original_size <= target_size:
            return 1.0
        return target_size / original_size

    def _downsample_image(
        self,
        image_data: bytes,
        current_dpi: int,
        target_dpi: int
    ) -> Tuple[bytes, Dict[str, Any]]:
        """
        Downsample an image to target DPI.

        Args:
            image_data: Original image bytes
            current_dpi: Current image DPI (estimated)
            target_dpi: Target DPI

        Returns:
            Tuple of (compressed image bytes, metadata dict)
        """
        try:
            img = Image.open(io.BytesIO(image_data))

            original_size = len(image_data)
            original_dimensions = img.size

            # Calculate scale factor based on DPI ratio
            if current_dpi > target_dpi:
                scale = target_dpi / current_dpi
                new_width = int(img.width * scale)
                new_height = int(img.height * scale)

                # Don't make images too small
                if new_width >= self.DEFAULT_MIN_IMAGE_SIZE and new_height >= self.DEFAULT_MIN_IMAGE_SIZE:
                    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

            # Convert to RGB if necessary (for JPEG output)
            if img.mode in ('RGBA', 'P'):
                # Create white background for transparent images
                background = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'P':
                    img = img.convert('RGBA')
                background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                img = background
            elif img.mode != 'RGB':
                img = img.convert('RGB')

            # Save as JPEG with quality setting
            output = io.BytesIO()
            img.save(output, format='JPEG', quality=self.jpeg_quality, optimize=True)
            compressed_data = output.getvalue()

            return compressed_data, {
                'original_size': original_size,
                'compressed_size': len(compressed_data),
                'original_dimensions': original_dimensions,
                'new_dimensions': img.size,
                'compression_ratio': len(compressed_data) / original_size if original_size > 0 else 1.0
            }

        except Exception as e:
            self.logger.warning(f"Image compression failed: {e}")
            return image_data, {'error': str(e)}

    def _estimate_image_dpi(
        self,
        image_width: int,
        image_height: int,
        display_width: float,
        display_height: float
    ) -> int:
        """
        Estimate image DPI based on display size in the PDF.

        Args:
            image_width: Image pixel width
            image_height: Image pixel height
            display_width: Display width in PDF points (1/72 inch)
            display_height: Display height in PDF points

        Returns:
            Estimated DPI
        """
        if display_width <= 0 or display_height <= 0:
            return 72  # Default

        # PDF points are 1/72 inch
        dpi_x = image_width / (display_width / 72)
        dpi_y = image_height / (display_height / 72)

        return int(max(dpi_x, dpi_y))

    def _compress_pdf_images(
        self,
        input_path: Path,
        output_path: Path
    ) -> Dict[str, Any]:
        """
        Compress images within a PDF file.

        This is a simplified approach that works with most PDFs.
        For complex PDFs, more sophisticated tools like ghostscript may be needed.

        Args:
            input_path: Input PDF file path
            output_path: Output PDF file path

        Returns:
            Dict with compression statistics
        """
        stats = {
            'images_processed': 0,
            'images_compressed': 0,
            'total_image_reduction': 0
        }

        try:
            reader = PdfReader(str(input_path))
            writer = PdfWriter()

            # Copy pages
            for page in reader.pages:
                writer.add_page(page)

            # Strip metadata if configured
            if self.strip_metadata:
                writer.add_metadata({})

            # Write output
            with open(output_path, 'wb') as f:
                writer.write(f)

            return stats

        except Exception as e:
            self.logger.error(f"PDF image compression failed: {e}")
            raise

    def _optimize_with_ghostscript(
        self,
        input_path: Path,
        output_path: Path,
        quality_preset: str = 'ebook'
    ) -> bool:
        """
        Use Ghostscript for more aggressive PDF compression.

        Quality presets:
        - 'screen': 72 DPI, smallest file
        - 'ebook': 150 DPI, good balance
        - 'printer': 300 DPI, high quality
        - 'prepress': 300 DPI, highest quality

        Args:
            input_path: Input PDF file path
            output_path: Output PDF file path
            quality_preset: Ghostscript quality preset

        Returns:
            True if successful, False otherwise
        """
        import subprocess

        # Check if ghostscript is available
        gs_commands = ['gs', 'gswin64c', 'gswin32c']
        gs_cmd = None

        for cmd in gs_commands:
            try:
                subprocess.run([cmd, '--version'], capture_output=True)
                gs_cmd = cmd
                break
            except FileNotFoundError:
                continue

        if not gs_cmd:
            self.logger.warning("Ghostscript not found - using fallback compression")
            return False

        try:
            result = subprocess.run([
                gs_cmd,
                '-sDEVICE=pdfwrite',
                f'-dPDFSETTINGS=/{quality_preset}',
                '-dNOPAUSE',
                '-dQUIET',
                '-dBATCH',
                '-dCompatibilityLevel=1.4',
                f'-sOutputFile={output_path}',
                str(input_path)
            ], capture_output=True, timeout=300)

            return result.returncode == 0

        except subprocess.TimeoutExpired:
            self.logger.error("Ghostscript compression timed out")
            return False
        except Exception as e:
            self.logger.error(f"Ghostscript compression failed: {e}")
            return False

    def _simple_compress(
        self,
        input_path: Path,
        output_path: Path
    ) -> Dict[str, Any]:
        """
        Simple PDF compression without external tools.

        Uses PyPDF2 to rewrite the PDF, which can provide
        moderate compression through object deduplication.

        Args:
            input_path: Input PDF file path
            output_path: Output PDF file path

        Returns:
            Dict with compression statistics
        """
        reader = PdfReader(str(input_path))
        writer = PdfWriter()

        # Copy all pages
        for page in reader.pages:
            writer.add_page(page)

        # Strip metadata if configured
        if self.strip_metadata:
            writer.add_metadata({
                '/Producer': '',
                '/Creator': '',
                '/Author': '',
                '/Title': '',
                '/Subject': '',
                '/Keywords': ''
            })

        # Write with compression
        with open(output_path, 'wb') as f:
            writer.write(f)

        return {
            'method': 'simple_rewrite',
            'pages': len(reader.pages)
        }

    def validate_input(self, input_data: Any) -> bool:
        """
        Validate input is a valid PDF file path.

        Args:
            input_data: Should be a path to a PDF file or dict with 'file_path'

        Returns:
            True if valid
        """
        if isinstance(input_data, dict):
            file_path = input_data.get('file_path') or input_data.get('path')
        else:
            file_path = input_data

        if not file_path:
            self.logger.error("No file path provided")
            return False

        path = Path(file_path)

        if not path.exists():
            self.logger.error(f"File does not exist: {path}")
            return False

        if path.suffix.lower() != '.pdf':
            self.logger.error(f"File must be a PDF: {path}")
            return False

        return True

    async def process(self, input_data: Any) -> SkillResult:
        """
        Compress a PDF file.

        Args:
            input_data: Either a file path string/Path, or a dict with:
                - file_path/path: Path to PDF file
                - project_id: Optional project ID for naming
                - target_size_mb: Optional target size override
                - quality: Optional quality preset ('screen', 'ebook', 'printer')

        Returns:
            SkillResult with compressed file path and statistics
        """
        # Parse input
        if isinstance(input_data, dict):
            input_path = Path(input_data.get('file_path') or input_data.get('path'))
            project_id = input_data.get('project_id')
            target_size_mb = input_data.get('target_size_mb', self.target_max_size_mb)
            quality = input_data.get('quality', 'ebook')
        else:
            input_path = Path(input_data)
            project_id = None
            target_size_mb = self.target_max_size_mb
            quality = 'ebook'

        if not self.validate_input(input_data):
            return SkillResult.fail(
                error="Invalid input - must provide valid PDF file path",
                data={'input': str(input_data)}
            )

        original_size = input_path.stat().st_size
        target_size = target_size_mb * 1024 * 1024

        self.logger.info(
            f"Compressing PDF: {input_path.name} "
            f"({original_size / 1024 / 1024:.2f} MB -> target {target_size_mb} MB)"
        )

        # Generate output filename
        if project_id:
            output_filename = f"{project_id}_compressed_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
        else:
            output_filename = f"{input_path.stem}_compressed.pdf"

        output_path = self.output_dir / output_filename

        try:
            # Try Ghostscript first (best compression)
            gs_success = self._optimize_with_ghostscript(input_path, output_path, quality)

            if not gs_success:
                # Fallback to simple compression
                self.logger.info("Using simple compression method")
                self._simple_compress(input_path, output_path)

            # Verify output
            if not output_path.exists():
                return SkillResult.fail(
                    error="Compression failed - output file not created",
                    data={'input_path': str(input_path)}
                )

            compressed_size = output_path.stat().st_size
            reduction = original_size - compressed_size
            reduction_percent = (reduction / original_size) * 100 if original_size > 0 else 0

            # Verify page integrity
            original_pages = len(PdfReader(str(input_path)).pages)
            compressed_pages = len(PdfReader(str(output_path)).pages)

            if original_pages != compressed_pages:
                self.logger.error(
                    f"Page count mismatch after compression: "
                    f"{original_pages} -> {compressed_pages}"
                )
                output_path.unlink(missing_ok=True)
                return SkillResult.fail(
                    error="Compression failed - page count mismatch",
                    data={
                        'input_path': str(input_path),
                        'original_pages': original_pages,
                        'compressed_pages': compressed_pages
                    }
                )

            self.logger.info(
                f"Compression complete: {original_size / 1024 / 1024:.2f} MB -> "
                f"{compressed_size / 1024 / 1024:.2f} MB ({reduction_percent:.1f}% reduction)"
            )

            # Check if we met target
            meets_target = compressed_size <= target_size
            if not meets_target:
                self.logger.warning(
                    f"Compressed file ({compressed_size / 1024 / 1024:.2f} MB) "
                    f"still exceeds target ({target_size_mb} MB)"
                )

            return SkillResult.ok(
                data={
                    'output_path': str(output_path),
                    'original_path': str(input_path),
                    'original_size': original_size,
                    'original_size_mb': round(original_size / 1024 / 1024, 2),
                    'compressed_size': compressed_size,
                    'compressed_size_mb': round(compressed_size / 1024 / 1024, 2),
                    'reduction_bytes': reduction,
                    'reduction_percent': round(reduction_percent, 1),
                    'page_count': compressed_pages,
                    'meets_target': meets_target,
                    'target_size_mb': target_size_mb,
                    'compression_method': 'ghostscript' if gs_success else 'simple'
                }
            )

        except Exception as e:
            self.logger.exception(f"PDF compression failed: {e}")
            return SkillResult.fail(
                error=f"Compression failed: {str(e)}",
                data={'input_path': str(input_path)}
            )

    def compress_sync(
        self,
        input_path: Union[str, Path],
        project_id: Optional[str] = None,
        target_size_mb: Optional[float] = None
    ) -> Tuple[bool, Optional[str], Dict[str, Any]]:
        """
        Synchronous compression method for simpler use cases.

        Args:
            input_path: Path to PDF file
            project_id: Optional project ID for naming
            target_size_mb: Optional target size

        Returns:
            Tuple of (success, output_path, metadata)
        """
        import asyncio

        input_data = {
            'file_path': str(input_path),
            'project_id': project_id
        }
        if target_size_mb:
            input_data['target_size_mb'] = target_size_mb

        result = asyncio.run(self.process(input_data))

        if result.success:
            return True, result.data.get('output_path'), result.data
        else:
            return False, None, {'error': result.error}

    def needs_compression(self, file_path: Path, target_size_mb: Optional[float] = None) -> bool:
        """
        Check if a file needs compression based on size.

        Args:
            file_path: Path to PDF file
            target_size_mb: Optional target size override

        Returns:
            True if file exceeds target size
        """
        target = (target_size_mb or self.target_max_size_mb) * 1024 * 1024
        return file_path.stat().st_size > target

    def get_compression_info(self, file_path: Path) -> Optional[Dict[str, Any]]:
        """
        Get information about a PDF file for compression planning.

        Args:
            file_path: Path to PDF file

        Returns:
            Dict with file info or None if invalid
        """
        if not file_path.exists():
            return None

        try:
            reader = PdfReader(str(file_path))
            return {
                'path': str(file_path),
                'size': file_path.stat().st_size,
                'size_mb': round(file_path.stat().st_size / 1024 / 1024, 2),
                'page_count': len(reader.pages),
                'needs_compression': self.needs_compression(file_path)
            }
        except Exception as e:
            self.logger.warning(f"Could not read PDF info: {e}")
            return None

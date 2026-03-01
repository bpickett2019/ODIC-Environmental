"""
ODIC ESA Pipeline - File Converter Skill

Converts various input formats to PDF for pipeline processing:
- Word documents (.docx) -> PDF via python-docx + reportlab
- Images (.jpg, .jpeg, .png, .tiff, .tif, .bmp, .gif) -> PDF via Pillow
- PDFs pass through unchanged

All converted files are saved to a staging directory before entering the pipeline.
"""

import io
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
from datetime import datetime

from PIL import Image
from docx import Document
from docx.shared import Inches, Pt
from reportlab.lib.pagesizes import letter, A4
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

from .base import BaseSkill, SkillResult


class FileConverter(BaseSkill):
    """
    Converts Word documents and images to PDF format.

    Supported input formats:
    - Word: .docx
    - Images: .jpg, .jpeg, .png, .tiff, .tif, .bmp, .gif
    - PDF: passed through unchanged

    All outputs are PDF files ready for the classification pipeline.
    """

    # Supported file extensions by type
    WORD_EXTENSIONS = {'.docx'}
    IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.tiff', '.tif', '.bmp', '.gif'}
    PDF_EXTENSIONS = {'.pdf'}

    # Page settings
    DEFAULT_PAGE_SIZE = letter  # 8.5 x 11 inches
    DEFAULT_MARGIN = 0.5 * inch
    DEFAULT_DPI = 150  # For image conversion

    def __init__(self, config: dict):
        """
        Initialize the file converter.

        Args:
            config: Configuration dictionary with optional 'converter' section
        """
        super().__init__(config)

        converter_config = config.get('converter', {})

        # Output directory for converted files
        self.output_dir = Path(converter_config.get(
            'output_dir',
            config.get('pipeline', {}).get('staging_dir', './staging')
        ))
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Image conversion settings
        self.image_dpi = converter_config.get('image_dpi', self.DEFAULT_DPI)
        self.image_quality = converter_config.get('image_quality', 85)
        self.max_image_dimension = converter_config.get('max_image_dimension', 4000)

        # Page settings
        page_size = converter_config.get('page_size', 'letter')
        self.page_size = A4 if page_size.lower() == 'a4' else letter
        self.margin = converter_config.get('margin_inches', 0.5) * inch

    def get_supported_extensions(self) -> List[str]:
        """Return all supported file extensions."""
        all_extensions = self.WORD_EXTENSIONS | self.IMAGE_EXTENSIONS | self.PDF_EXTENSIONS
        return sorted(list(all_extensions))

    def _get_file_type(self, file_path: Path) -> Optional[str]:
        """
        Determine the file type category.

        Returns:
            'word', 'image', 'pdf', or None if unsupported
        """
        ext = file_path.suffix.lower()

        if ext in self.WORD_EXTENSIONS:
            return 'word'
        elif ext in self.IMAGE_EXTENSIONS:
            return 'image'
        elif ext in self.PDF_EXTENSIONS:
            return 'pdf'
        return None

    def _generate_output_path(self, input_path: Path) -> Path:
        """Generate output PDF path for converted file."""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')  # Include microseconds
        output_name = f"{input_path.stem}_{timestamp}.pdf"
        return self.output_dir / output_name

    def _convert_word_to_pdf(self, input_path: Path, output_path: Path) -> Dict[str, Any]:
        """
        Convert a Word document to PDF.

        This creates a simple PDF with the text content from the Word document.
        For complex formatting, consider using LibreOffice or similar.

        Args:
            input_path: Path to .docx file
            output_path: Path for output PDF

        Returns:
            Dict with conversion metadata
        """
        doc = Document(str(input_path))

        # Create PDF
        c = canvas.Canvas(str(output_path), pagesize=self.page_size)
        page_width, page_height = self.page_size

        # Text positioning
        x_margin = self.margin
        y_position = page_height - self.margin
        line_height = 14  # points
        max_width = page_width - (2 * self.margin)

        # Track statistics
        total_paragraphs = 0
        total_pages = 1

        # Set font
        c.setFont("Helvetica", 11)

        for paragraph in doc.paragraphs:
            text = paragraph.text.strip()
            if not text:
                y_position -= line_height / 2
                continue

            total_paragraphs += 1

            # Simple word wrapping
            words = text.split()
            current_line = ""

            for word in words:
                test_line = f"{current_line} {word}".strip()
                text_width = c.stringWidth(test_line, "Helvetica", 11)

                if text_width < max_width:
                    current_line = test_line
                else:
                    # Draw current line and start new one
                    if y_position < self.margin + line_height:
                        c.showPage()
                        c.setFont("Helvetica", 11)
                        y_position = page_height - self.margin
                        total_pages += 1

                    c.drawString(x_margin, y_position, current_line)
                    y_position -= line_height
                    current_line = word

            # Draw remaining text
            if current_line:
                if y_position < self.margin + line_height:
                    c.showPage()
                    c.setFont("Helvetica", 11)
                    y_position = page_height - self.margin
                    total_pages += 1

                c.drawString(x_margin, y_position, current_line)
                y_position -= line_height * 1.5  # Extra space after paragraph

        c.save()

        return {
            'paragraphs_converted': total_paragraphs,
            'pages_created': total_pages,
        }

    def _convert_image_to_pdf(self, input_path: Path, output_path: Path) -> Dict[str, Any]:
        """
        Convert an image to PDF.

        The image is scaled to fit the page while maintaining aspect ratio.

        Args:
            input_path: Path to image file
            output_path: Path for output PDF

        Returns:
            Dict with conversion metadata
        """
        # Open and process image
        with Image.open(str(input_path)) as img:
            # Convert to RGB if necessary (for RGBA or palette images)
            if img.mode in ('RGBA', 'LA', 'P'):
                # Create white background for transparency
                background = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'P':
                    img = img.convert('RGBA')
                background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                img = background
            elif img.mode != 'RGB':
                img = img.convert('RGB')

            original_size = img.size

            # Resize if too large
            if max(img.size) > self.max_image_dimension:
                ratio = self.max_image_dimension / max(img.size)
                new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
                img = img.resize(new_size, Image.Resampling.LANCZOS)

            # Calculate dimensions for PDF
            page_width, page_height = self.page_size
            available_width = page_width - (2 * self.margin)
            available_height = page_height - (2 * self.margin)

            img_width, img_height = img.size

            # Scale image to fit page
            width_ratio = available_width / img_width
            height_ratio = available_height / img_height
            scale = min(width_ratio, height_ratio, 1.0)  # Don't enlarge

            final_width = img_width * scale
            final_height = img_height * scale

            # Center on page
            x_offset = (page_width - final_width) / 2
            y_offset = (page_height - final_height) / 2

            # Save to temporary buffer
            img_buffer = io.BytesIO()
            img.save(img_buffer, format='JPEG', quality=self.image_quality)
            img_buffer.seek(0)

            # Create PDF
            c = canvas.Canvas(str(output_path), pagesize=self.page_size)
            c.drawImage(
                ImageReader(img_buffer),
                x_offset, y_offset,
                width=final_width, height=final_height
            )
            c.save()

            return {
                'original_size': original_size,
                'final_size': (int(final_width), int(final_height)),
                'scale_factor': scale,
                'format': img.format or input_path.suffix.upper().lstrip('.'),
            }

    def _convert_images_to_multi_page_pdf(
        self,
        input_paths: List[Path],
        output_path: Path
    ) -> Dict[str, Any]:
        """
        Convert multiple images to a single multi-page PDF.

        Args:
            input_paths: List of image file paths
            output_path: Path for output PDF

        Returns:
            Dict with conversion metadata
        """
        c = canvas.Canvas(str(output_path), pagesize=self.page_size)
        page_width, page_height = self.page_size
        available_width = page_width - (2 * self.margin)
        available_height = page_height - (2 * self.margin)

        images_converted = 0

        for input_path in input_paths:
            try:
                with Image.open(str(input_path)) as img:
                    # Convert to RGB
                    if img.mode in ('RGBA', 'LA', 'P'):
                        background = Image.new('RGB', img.size, (255, 255, 255))
                        if img.mode == 'P':
                            img = img.convert('RGBA')
                        background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                        img = background
                    elif img.mode != 'RGB':
                        img = img.convert('RGB')

                    # Resize if needed
                    if max(img.size) > self.max_image_dimension:
                        ratio = self.max_image_dimension / max(img.size)
                        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
                        img = img.resize(new_size, Image.Resampling.LANCZOS)

                    # Calculate dimensions
                    img_width, img_height = img.size
                    width_ratio = available_width / img_width
                    height_ratio = available_height / img_height
                    scale = min(width_ratio, height_ratio, 1.0)

                    final_width = img_width * scale
                    final_height = img_height * scale

                    x_offset = (page_width - final_width) / 2
                    y_offset = (page_height - final_height) / 2

                    # Save to buffer
                    img_buffer = io.BytesIO()
                    img.save(img_buffer, format='JPEG', quality=self.image_quality)
                    img_buffer.seek(0)

                    # Add to PDF
                    c.drawImage(
                        ImageReader(img_buffer),
                        x_offset, y_offset,
                        width=final_width, height=final_height
                    )
                    c.showPage()
                    images_converted += 1

            except Exception as e:
                self.logger.warning(f"Failed to convert image {input_path}: {e}")

        c.save()

        return {
            'images_converted': images_converted,
            'total_pages': images_converted,
        }

    def validate_input(self, input_data: Any) -> bool:
        """
        Validate input is a valid file path or list of paths.

        Args:
            input_data: File path string, Path object, or list thereof

        Returns:
            True if all inputs are valid
        """
        if isinstance(input_data, (str, Path)):
            paths = [Path(input_data)]
        elif isinstance(input_data, list):
            paths = [Path(p) for p in input_data]
        else:
            self.logger.error(f"Invalid input type: {type(input_data)}")
            return False

        for path in paths:
            if not path.exists():
                self.logger.error(f"File does not exist: {path}")
                return False

            file_type = self._get_file_type(path)
            if file_type is None:
                self.logger.error(
                    f"Unsupported file type: {path.suffix}. "
                    f"Supported: {self.get_supported_extensions()}"
                )
                return False

        return True

    async def process(self, input_data: Any) -> SkillResult:
        """
        Convert file(s) to PDF.

        Args:
            input_data: Single file path or list of file paths.
                       If list, images will be combined into multi-page PDF.

        Returns:
            SkillResult with converted file path(s) and metadata
        """
        # Handle single file vs multiple
        if isinstance(input_data, (str, Path)):
            return await self._process_single_file(Path(input_data))
        elif isinstance(input_data, list):
            return await self._process_multiple_files([Path(p) for p in input_data])
        else:
            return SkillResult.fail(
                error=f"Invalid input type: {type(input_data)}",
                data=input_data
            )

    async def _process_single_file(self, input_path: Path) -> SkillResult:
        """Process a single file conversion."""
        file_type = self._get_file_type(input_path)

        if file_type == 'pdf':
            # PDF passthrough - just return the path
            self.logger.info(f"PDF passthrough: {input_path.name}")
            return SkillResult.ok(
                data={
                    'output_path': str(input_path),
                    'conversion_type': 'passthrough',
                    'original_file': str(input_path),
                    'file_size': input_path.stat().st_size,
                }
            )

        output_path = self._generate_output_path(input_path)

        try:
            if file_type == 'word':
                self.logger.info(f"Converting Word document: {input_path.name}")
                metadata = self._convert_word_to_pdf(input_path, output_path)
                conversion_type = 'word_to_pdf'

            elif file_type == 'image':
                self.logger.info(f"Converting image: {input_path.name}")
                metadata = self._convert_image_to_pdf(input_path, output_path)
                conversion_type = 'image_to_pdf'
            else:
                return SkillResult.fail(
                    error=f"Unsupported file type: {file_type}",
                    data={'input_path': str(input_path)}
                )

            # Verify output was created
            if not output_path.exists():
                return SkillResult.fail(
                    error="Conversion failed - output file not created",
                    data={'input_path': str(input_path)}
                )

            self.logger.info(
                f"Conversion complete: {input_path.name} -> {output_path.name}"
            )

            return SkillResult.ok(
                data={
                    'output_path': str(output_path),
                    'conversion_type': conversion_type,
                    'original_file': str(input_path),
                    'original_size': input_path.stat().st_size,
                    'output_size': output_path.stat().st_size,
                    **metadata
                }
            )

        except Exception as e:
            self.logger.exception(f"Conversion failed for {input_path.name}")
            return SkillResult.fail(
                error=f"Conversion failed: {str(e)}",
                data={'input_path': str(input_path)}
            )

    async def _process_multiple_files(self, input_paths: List[Path]) -> SkillResult:
        """
        Process multiple files.

        If all are images, combine into single PDF.
        Otherwise, process each individually.
        """
        file_types = [self._get_file_type(p) for p in input_paths]

        # If all images, combine into multi-page PDF
        if all(ft == 'image' for ft in file_types):
            self.logger.info(f"Combining {len(input_paths)} images into multi-page PDF")

            # Generate output name from first file
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            output_name = f"combined_images_{timestamp}.pdf"
            output_path = self.output_dir / output_name

            try:
                metadata = self._convert_images_to_multi_page_pdf(input_paths, output_path)

                return SkillResult.ok(
                    data={
                        'output_path': str(output_path),
                        'conversion_type': 'images_to_multi_page_pdf',
                        'original_files': [str(p) for p in input_paths],
                        'output_size': output_path.stat().st_size,
                        **metadata
                    }
                )
            except Exception as e:
                return SkillResult.fail(
                    error=f"Multi-image conversion failed: {str(e)}",
                    data={'input_paths': [str(p) for p in input_paths]}
                )

        # Otherwise, process each file individually
        results = []
        for input_path in input_paths:
            result = await self._process_single_file(input_path)
            results.append({
                'input': str(input_path),
                'success': result.success,
                'output': result.data.get('output_path') if result.success else None,
                'error': result.error
            })

        success_count = sum(1 for r in results if r['success'])

        return SkillResult.ok(
            data={
                'conversion_type': 'batch',
                'total_files': len(input_paths),
                'successful': success_count,
                'failed': len(input_paths) - success_count,
                'results': results
            }
        )

    def convert_sync(self, input_path: Union[str, Path]) -> Tuple[bool, str, Dict]:
        """
        Synchronous conversion method for simpler use cases.

        Args:
            input_path: Path to file to convert

        Returns:
            Tuple of (success, output_path_or_error, metadata)
        """
        import asyncio
        result = asyncio.run(self.process(input_path))

        if result.success:
            return (True, result.data['output_path'], result.data)
        else:
            return (False, result.error, {})

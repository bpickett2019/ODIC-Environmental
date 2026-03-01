"""
Enhanced PDF Processor for ESA Pipeline Demo

Extracts text page-by-page using PyMuPDF (fitz) and streams progress.
This provides the visible "PDF processing" experience in the demo.
"""

import os
import logging
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Optional, AsyncGenerator
from datetime import datetime

logger = logging.getLogger(__name__)

try:
    import fitz  # PyMuPDF
    PYMUPDF_AVAILABLE = True
except ImportError:
    PYMUPDF_AVAILABLE = False
    logger.warning("PyMuPDF not available - install with: pip install PyMuPDF")


@dataclass
class PageInfo:
    """Information about a single PDF page."""
    page_number: int  # 1-indexed
    text_content: str
    text_preview: str  # First 500 chars
    word_count: int
    char_count: int
    has_images: bool
    image_count: int

    def to_dict(self):
        return asdict(self)


@dataclass
class PDFManifest:
    """Complete manifest of a processed PDF."""
    filename: str
    total_pages: int
    file_size_bytes: int
    title: Optional[str]
    author: Optional[str]
    creation_date: Optional[str]
    pages: List[PageInfo]
    total_words: int
    total_chars: int
    processing_time_ms: int

    def to_dict(self):
        return {
            **asdict(self),
            "pages": [p.to_dict() for p in self.pages]
        }


@dataclass
class ProcessingEvent:
    """Event sent during PDF processing."""
    type: str  # "start", "page", "complete", "error"
    page_number: Optional[int]
    total_pages: int
    message: str
    data: Optional[Dict[str, Any]] = None

    def to_dict(self):
        result = {
            "type": self.type,
            "total_pages": self.total_pages,
            "message": self.message
        }
        if self.page_number is not None:
            result["page_number"] = self.page_number
        if self.data:
            result["data"] = self.data
        return result


class EnhancedPDFProcessor:
    """
    Processes PDFs with page-by-page extraction and streaming.

    Key features:
    - Extracts text from each page
    - Counts words and characters
    - Extracts metadata
    - Streams progress via async generator
    """

    def __init__(self):
        if not PYMUPDF_AVAILABLE:
            raise RuntimeError("PyMuPDF is required. Install with: pip install PyMuPDF")

    async def process_pdf_streaming(
        self,
        file_path: str,
        event_callback: callable = None
    ) -> PDFManifest:
        """
        Process a PDF file with streaming progress updates.

        Args:
            file_path: Path to the PDF file
            event_callback: Async function to receive progress events

        Returns:
            PDFManifest with all extracted information
        """
        start_time = datetime.now()

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"PDF not found: {file_path}")

        filename = os.path.basename(file_path)
        file_size = os.path.getsize(file_path)

        try:
            doc = fitz.open(file_path)
            total_pages = len(doc)

            # Send start event
            if event_callback:
                await event_callback(ProcessingEvent(
                    type="start",
                    page_number=None,
                    total_pages=total_pages,
                    message=f"Starting PDF processing: {filename} ({total_pages} pages)",
                    data={"filename": filename, "size_bytes": file_size}
                ))

            # Extract metadata
            metadata = doc.metadata or {}
            title = metadata.get("title") or None
            author = metadata.get("author") or None
            creation_date = metadata.get("creationDate") or None

            pages: List[PageInfo] = []
            total_words = 0
            total_chars = 0

            # Process each page
            for page_num in range(total_pages):
                page = doc[page_num]
                page_number = page_num + 1  # 1-indexed for display

                # Extract text
                text = page.get_text()
                text_preview = text[:500] if text else ""

                # Count words and chars
                word_count = len(text.split()) if text else 0
                char_count = len(text) if text else 0

                total_words += word_count
                total_chars += char_count

                # Check for images
                images = page.get_images()
                has_images = len(images) > 0
                image_count = len(images)

                page_info = PageInfo(
                    page_number=page_number,
                    text_content=text,
                    text_preview=text_preview,
                    word_count=word_count,
                    char_count=char_count,
                    has_images=has_images,
                    image_count=image_count
                )
                pages.append(page_info)

                # Send page processed event
                if event_callback:
                    await event_callback(ProcessingEvent(
                        type="page",
                        page_number=page_number,
                        total_pages=total_pages,
                        message=f"Processed page {page_number}/{total_pages}: {word_count} words",
                        data={
                            "text_preview": text_preview[:200],
                            "word_count": word_count,
                            "has_images": has_images
                        }
                    ))

            doc.close()

            # Calculate processing time
            processing_time = int((datetime.now() - start_time).total_seconds() * 1000)

            manifest = PDFManifest(
                filename=filename,
                total_pages=total_pages,
                file_size_bytes=file_size,
                title=title,
                author=author,
                creation_date=creation_date,
                pages=pages,
                total_words=total_words,
                total_chars=total_chars,
                processing_time_ms=processing_time
            )

            # Send complete event
            if event_callback:
                await event_callback(ProcessingEvent(
                    type="complete",
                    page_number=None,
                    total_pages=total_pages,
                    message=f"PDF processing complete: {total_pages} pages, {total_words} words",
                    data={
                        "total_pages": total_pages,
                        "total_words": total_words,
                        "processing_time_ms": processing_time
                    }
                ))

            return manifest

        except Exception as e:
            logger.exception(f"PDF processing failed: {e}")

            if event_callback:
                await event_callback(ProcessingEvent(
                    type="error",
                    page_number=None,
                    total_pages=0,
                    message=f"PDF processing failed: {str(e)}",
                    data={"error": str(e)}
                ))

            raise

    def process_pdf_sync(self, file_path: str) -> PDFManifest:
        """
        Synchronous PDF processing (for non-streaming use cases).
        """
        import asyncio
        return asyncio.run(self.process_pdf_streaming(file_path))

    def get_page_range_text(
        self,
        file_path: str,
        start_page: int,
        end_page: int
    ) -> str:
        """
        Extract text from a range of pages.

        Args:
            file_path: Path to PDF
            start_page: Start page (1-indexed)
            end_page: End page (1-indexed, inclusive)

        Returns:
            Combined text from the page range
        """
        try:
            doc = fitz.open(file_path)
            text_parts = []

            for page_num in range(start_page - 1, min(end_page, len(doc))):
                page = doc[page_num]
                text = page.get_text()
                text_parts.append(f"--- Page {page_num + 1} ---\n{text}")

            doc.close()
            return "\n\n".join(text_parts)

        except Exception as e:
            logger.exception(f"Failed to extract page range: {e}")
            return ""

    def get_document_chunks(
        self,
        manifest: PDFManifest,
        chunk_size: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Split document into chunks for classification.

        Args:
            manifest: PDFManifest from processing
            chunk_size: Number of pages per chunk

        Returns:
            List of chunks with page ranges and combined text
        """
        chunks = []
        total_pages = manifest.total_pages

        for start in range(0, total_pages, chunk_size):
            end = min(start + chunk_size, total_pages)
            chunk_pages = manifest.pages[start:end]

            combined_text = "\n\n".join([
                f"--- Page {p.page_number} ---\n{p.text_content}"
                for p in chunk_pages
            ])

            chunks.append({
                "chunk_id": len(chunks) + 1,
                "page_start": start + 1,
                "page_end": end,
                "page_count": end - start,
                "text_content": combined_text,
                "word_count": sum(p.word_count for p in chunk_pages)
            })

        return chunks


# Singleton instance
_processor = None


def get_pdf_processor() -> EnhancedPDFProcessor:
    """Get singleton PDF processor instance."""
    global _processor
    if _processor is None:
        _processor = EnhancedPDFProcessor()
    return _processor

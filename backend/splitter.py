"""PDF splitter — split assembled reports into email-sized parts."""

from __future__ import annotations

import logging
from pathlib import Path

from pypdf import PdfReader, PdfWriter

logger = logging.getLogger(__name__)


def split_pdf(input_path: Path, max_size_mb: float = 20.0) -> list[dict]:
    """Split a PDF into parts that are each under max_size_mb.

    Returns list of dicts:
        [{part_number, filename, start_page, end_page, page_count, file_size, path}]
    """
    reader = PdfReader(str(input_path))
    total_pages = len(reader.pages)
    file_size = input_path.stat().st_size
    max_size_bytes = int(max_size_mb * 1024 * 1024)

    # If already under limit, return single part
    if file_size <= max_size_bytes:
        return [{
            "part_number": 1,
            "filename": input_path.name,
            "start_page": 1,
            "end_page": total_pages,
            "page_count": total_pages,
            "file_size": file_size,
            "path": str(input_path),
        }]

    # Estimate pages per part based on average page size
    avg_page_size = file_size / total_pages
    pages_per_part = max(1, int(max_size_bytes / avg_page_size * 0.9))  # 90% safety margin

    parts = []
    stem = input_path.stem
    suffix = input_path.suffix
    output_dir = input_path.parent / "split"
    output_dir.mkdir(exist_ok=True)

    page_idx = 0
    part_num = 0

    while page_idx < total_pages:
        part_num += 1
        writer = PdfWriter()
        start_page = page_idx

        # Add pages until we hit the estimated limit
        end_page = min(page_idx + pages_per_part, total_pages)
        for i in range(page_idx, end_page):
            writer.add_page(reader.pages[i])

        # Write part
        part_filename = f"{stem}_part{part_num}{suffix}"
        part_path = output_dir / part_filename
        with open(part_path, "wb") as f:
            writer.write(f)

        part_size = part_path.stat().st_size

        # If this part is too large and has more than 1 page, binary search for correct split
        if part_size > max_size_bytes and (end_page - start_page) > 1:
            # Reduce pages until under limit
            while part_size > max_size_bytes and (end_page - start_page) > 1:
                end_page -= max(1, (end_page - start_page) // 4)
                writer = PdfWriter()
                for i in range(start_page, end_page):
                    writer.add_page(reader.pages[i])
                with open(part_path, "wb") as f:
                    writer.write(f)
                part_size = part_path.stat().st_size

        parts.append({
            "part_number": part_num,
            "filename": part_filename,
            "start_page": start_page + 1,  # 1-indexed
            "end_page": end_page,
            "page_count": end_page - start_page,
            "file_size": part_size,
            "path": str(part_path),
        })

        page_idx = end_page

    logger.info(f"Split {input_path.name} into {len(parts)} parts (max {max_size_mb}MB each)")
    return parts

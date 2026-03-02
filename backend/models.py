from __future__ import annotations

import enum
from datetime import datetime
from typing import Optional

from pydantic import BaseModel


# --- Enums ---

class SectionCategory(str, enum.Enum):
    RELIANCE_LETTER = "RELIANCE_LETTER"
    EO_INSURANCE = "EO_INSURANCE"
    COVER_WRITEUP = "COVER_WRITEUP"
    APPENDIX_A = "APPENDIX_A"
    APPENDIX_B = "APPENDIX_B"
    APPENDIX_C = "APPENDIX_C"
    APPENDIX_D = "APPENDIX_D"
    APPENDIX_E = "APPENDIX_E"
    REPORTS_AFTER_E = "REPORTS_AFTER_E"
    APPENDIX_F = "APPENDIX_F"
    UNCLASSIFIED = "UNCLASSIFIED"


class AppendixDSubcategory(str, enum.Enum):
    SANBORN = "sanborn"
    AERIALS = "aerials"
    TOPOS = "topos"
    CITY_DIRECTORY = "city_directory"


class ReportStatus(str, enum.Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    DONE = "done"


class DocumentStatus(str, enum.Enum):
    UPLOADED = "uploaded"
    CLASSIFYING = "classifying"
    CLASSIFIED = "classified"
    CONVERTING = "converting"
    READY = "ready"
    ERROR = "error"


# --- Section display info ---

SECTION_DISPLAY = {
    SectionCategory.RELIANCE_LETTER: "Reliance Letter",
    SectionCategory.EO_INSURANCE: "E&O Insurance",
    SectionCategory.COVER_WRITEUP: "Cover / Write-Up",
    SectionCategory.APPENDIX_A: "APPENDIX A - Property Location Map & Plot Plan",
    SectionCategory.APPENDIX_B: "APPENDIX B - Property & Vicinity Photographs",
    SectionCategory.APPENDIX_C: "APPENDIX C - Database Report",
    SectionCategory.APPENDIX_D: "APPENDIX D - Historical Records Research",
    SectionCategory.APPENDIX_E: "APPENDIX E - Public Agency Records / Other Documents",
    SectionCategory.REPORTS_AFTER_E: "Supporting Reports (after Appendix E)",
    SectionCategory.APPENDIX_F: "APPENDIX F - Qualifications of Environmental Professional",
    SectionCategory.UNCLASSIFIED: "Unclassified Documents",
}


# --- Pydantic schemas ---

class ClassificationResult(BaseModel):
    category: SectionCategory
    subcategory: Optional[str] = None
    confidence: float
    reasoning: str
    sort_order: Optional[int] = None  # Override default sort_order (e.g. -1 for cover pages)


class DocumentCreate(BaseModel):
    original_filename: str
    original_path: Optional[str] = None


class DocumentResponse(BaseModel):
    id: int
    report_id: int
    original_filename: str
    original_path: Optional[str] = None
    stored_filename: str
    pdf_filename: Optional[str] = None
    file_size: int
    page_count: Optional[int] = None
    category: SectionCategory
    subcategory: Optional[str] = None
    confidence: Optional[float] = None
    reasoning: Optional[str] = None
    sort_order: int
    status: DocumentStatus
    is_included: bool
    has_docx_source: bool = False
    created_at: datetime

    class Config:
        from_attributes = True


class DocumentUpdate(BaseModel):
    category: Optional[SectionCategory] = None
    subcategory: Optional[str] = None
    sort_order: Optional[int] = None
    is_included: Optional[bool] = None


class ReportCreate(BaseModel):
    name: str
    address: Optional[str] = None
    project_number: Optional[str] = None
    has_reliance_letter: bool = True


class ReportResponse(BaseModel):
    id: int
    name: str
    address: Optional[str] = None
    project_number: Optional[str] = None
    has_reliance_letter: bool
    status: ReportStatus
    document_count: int = 0
    assembled_filename: Optional[str] = None
    assembled_size: Optional[int] = None
    compressed_size: Optional[int] = None
    pipeline_duration: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ReportUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    project_number: Optional[str] = None
    has_reliance_letter: Optional[bool] = None
    status: Optional[ReportStatus] = None


class ReorderRequest(BaseModel):
    document_ids: list[int]  # ordered list of doc IDs within a section
    category: SectionCategory


class AssembleRequest(BaseModel):
    compression: Optional[str] = None  # "email", "standard", "high", or None


class CompressRequest(BaseModel):
    quality: str = "standard"  # "email", "standard", "high"
    target_size_mb: Optional[float] = None


class ProgressEvent(BaseModel):
    stage: str
    message: str
    progress: float  # 0.0 to 1.0
    detail: Optional[str] = None


class ChatAction(BaseModel):
    action: str  # move, exclude, include, assemble, compress, split, search, undo, info, text_replace, delete_pages
    params: dict = {}


class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []  # Previous messages for context


class ChatResponse(BaseModel):
    message: str
    actions: list[ChatAction] = []
    results: list[dict] = []  # Results of executed actions
    needs_confirmation: bool = False
    affected_count: int = 0


class BatchUpdateRequest(BaseModel):
    document_ids: list[int]
    category: Optional[SectionCategory] = None
    is_included: Optional[bool] = None


class TextReplaceRequest(BaseModel):
    find: str
    replace: str


class DeletePagesRequest(BaseModel):
    pages: list[int]  # 0-indexed page numbers to remove


class SplitResult(BaseModel):
    parts: list[dict]  # [{part_number, filename, start_page, end_page, page_count, file_size}]
    total_parts: int


# --- DOCX Editing ---

class DocxRun(BaseModel):
    text: str
    bold: Optional[bool] = None
    italic: Optional[bool] = None

class DocxParagraph(BaseModel):
    text: str
    style: Optional[str] = None
    runs: list[DocxRun] = []

class DocxContentResponse(BaseModel):
    is_docx: bool
    paragraphs: list[DocxParagraph] = []

class DocxContentUpdateRequest(BaseModel):
    paragraphs: list[DocxParagraph]

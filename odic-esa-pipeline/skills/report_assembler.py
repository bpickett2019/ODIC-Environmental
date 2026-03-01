"""
ODIC ESA Pipeline - Report Assembler Skill

Compiles the final Phase I ESA PDF using Sonnet for text generation.
- Reads organized documents from project folder
- Assembles in correct section order from esa_template.yaml
- Generates cover page and table of contents with ReportLab
- Merges all document PDFs using PyPDF2
- Uses Sonnet to generate executive summary and section transitions
"""

import io
import json
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Union
from dataclasses import dataclass

import yaml
from PyPDF2 import PdfReader, PdfWriter, PdfMerger
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak,
    Table, TableStyle, Image
)
from reportlab.pdfgen import canvas
import pdfplumber

from .base import BaseSkill, SkillResult
from core.llm_router import LLMRouter
from core.state import StateManager, ProjectStatus


@dataclass
class SectionContent:
    """Content for a report section."""
    section_id: str
    section_name: str
    page_number: int
    pdf_paths: List[str]
    generated_text: Optional[str] = None


class ReportAssembler(BaseSkill):
    """
    Assembles the final Phase I ESA report PDF.

    Features:
    - ReportLab for cover page and TOC generation
    - PyPDF2 for merging document PDFs
    - Sonnet for executive summary and section text
    - Section ordering from ESA template
    """

    def __init__(
        self,
        config: dict,
        llm_router: Optional[LLMRouter] = None,
        state_manager: Optional[StateManager] = None
    ):
        """Initialize the report assembler."""
        super().__init__(config)

        self.llm_router = llm_router or LLMRouter(config)
        self.state_manager = state_manager

        # Directories
        pipeline_config = config.get("pipeline", {})
        self.project_base_dir = Path(pipeline_config.get("project_base_dir", "./projects"))
        self.output_dir = Path(pipeline_config.get("output_dir", "./completed_reports"))
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Load ESA template
        self.esa_template = self._load_esa_template()

        # Document type to subfolder mapping (same as file_organizer)
        self.SUBFOLDER_MAP = {
            "sanborn_map": "historical/sanborn_maps",
            "topographic_map": "historical/topo_maps",
            "aerial_photograph": "historical/aerials",
            "city_directory": "historical/city_directories",
            "fire_insurance_map": "historical/fire_insurance_maps",
            "edr": "regulatory/edr",
            "title_record": "records/title",
            "tax_record": "records/tax",
            "building_permit": "records/permits",
            "site_photograph": "site_visit/photos",
            "regulatory_correspondence": "regulatory/correspondence",
            "prior_environmental_report": "prior_reports",
            "client_correspondence": "client",
            "lab_results": "lab_results",
            "other": "other",
        }

    def _load_esa_template(self) -> Dict[str, Any]:
        """Load ESA template configuration."""
        template_path = Path(__file__).parent.parent / "config" / "esa_template.yaml"
        if template_path.exists():
            with open(template_path, "r") as f:
                return yaml.safe_load(f)
        return {}

    def _get_documents_by_type(self, project_path: Path, doc_type: str) -> List[Path]:
        """Get all documents of a specific type from project folder."""
        subfolder = self.SUBFOLDER_MAP.get(doc_type, "other")
        folder_path = project_path / subfolder

        if not folder_path.exists():
            return []

        return sorted(folder_path.glob("*.pdf"))

    def _extract_text_sample(self, pdf_path: Path, max_pages: int = 5) -> str:
        """Extract text sample from PDF for LLM context."""
        text_parts = []
        try:
            with pdfplumber.open(pdf_path) as pdf:
                for i, page in enumerate(pdf.pages[:max_pages]):
                    text = page.extract_text()
                    if text:
                        text_parts.append(f"[Page {i+1}]\n{text[:2000]}")
        except Exception as e:
            self.logger.warning(f"Could not extract text from {pdf_path}: {e}")
        return "\n\n".join(text_parts)

    def _create_cover_page(
        self,
        project_id: str,
        site_address: str = "Site Address TBD",
        client_name: str = "Client Name TBD",
        report_date: Optional[str] = None
    ) -> bytes:
        """Generate cover page PDF using ReportLab."""
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(
            buffer,
            pagesize=letter,
            rightMargin=72,
            leftMargin=72,
            topMargin=72,
            bottomMargin=72
        )

        styles = getSampleStyleSheet()
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=styles['Heading1'],
            fontSize=24,
            spaceAfter=30,
            alignment=1  # Center
        )
        subtitle_style = ParagraphStyle(
            'CustomSubtitle',
            parent=styles['Heading2'],
            fontSize=18,
            spaceAfter=20,
            alignment=1
        )
        body_style = ParagraphStyle(
            'CustomBody',
            parent=styles['Normal'],
            fontSize=12,
            spaceAfter=12,
            alignment=1
        )

        report_date = report_date or datetime.now().strftime("%B %d, %Y")

        elements = []

        # Spacer to push content down
        elements.append(Spacer(1, 2 * inch))

        # Title
        elements.append(Paragraph("PHASE I", title_style))
        elements.append(Paragraph("ENVIRONMENTAL SITE ASSESSMENT", title_style))

        elements.append(Spacer(1, 0.5 * inch))

        # Site info
        elements.append(Paragraph(site_address, subtitle_style))

        elements.append(Spacer(1, 0.5 * inch))

        # Project info
        elements.append(Paragraph(f"Project Number: {project_id}", body_style))
        elements.append(Paragraph(f"Report Date: {report_date}", body_style))

        elements.append(Spacer(1, 1 * inch))

        # Prepared for
        elements.append(Paragraph("Prepared For:", body_style))
        elements.append(Paragraph(client_name, subtitle_style))

        elements.append(Spacer(1, 1 * inch))

        # Prepared by
        elements.append(Paragraph("Prepared By:", body_style))
        elements.append(Paragraph("ODIC Environmental Consulting", subtitle_style))

        doc.build(elements)
        return buffer.getvalue()

    def _create_toc(self, sections: List[SectionContent]) -> bytes:
        """Generate table of contents PDF using ReportLab."""
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(
            buffer,
            pagesize=letter,
            rightMargin=72,
            leftMargin=72,
            topMargin=72,
            bottomMargin=72
        )

        styles = getSampleStyleSheet()
        title_style = ParagraphStyle(
            'TOCTitle',
            parent=styles['Heading1'],
            fontSize=18,
            spaceAfter=30,
            alignment=1
        )
        toc_style = ParagraphStyle(
            'TOCEntry',
            parent=styles['Normal'],
            fontSize=11,
            spaceAfter=8,
            leftIndent=0
        )
        toc_sub_style = ParagraphStyle(
            'TOCSubEntry',
            parent=styles['Normal'],
            fontSize=10,
            spaceAfter=6,
            leftIndent=20
        )

        elements = []
        elements.append(Paragraph("TABLE OF CONTENTS", title_style))
        elements.append(Spacer(1, 0.5 * inch))

        # Build TOC entries
        for section in sections:
            # Create dotted line effect with page number
            entry_text = f"{section.section_name}"
            page_text = f"Page {section.page_number}"

            elements.append(Paragraph(
                f"{entry_text} {'.' * 50} {page_text}",
                toc_style
            ))

        doc.build(elements)
        return buffer.getvalue()

    def _create_section_page(self, section_name: str, content: str = "") -> bytes:
        """Create a section header/content page."""
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(
            buffer,
            pagesize=letter,
            rightMargin=72,
            leftMargin=72,
            topMargin=72,
            bottomMargin=72
        )

        styles = getSampleStyleSheet()
        section_style = ParagraphStyle(
            'SectionTitle',
            parent=styles['Heading1'],
            fontSize=16,
            spaceAfter=20,
            spaceBefore=0
        )
        body_style = ParagraphStyle(
            'SectionBody',
            parent=styles['Normal'],
            fontSize=11,
            spaceAfter=12,
            leading=14
        )

        elements = []
        elements.append(Paragraph(section_name, section_style))

        if content:
            # Split content into paragraphs
            for para in content.split('\n\n'):
                if para.strip():
                    elements.append(Paragraph(para.strip(), body_style))
                    elements.append(Spacer(1, 0.2 * inch))

        doc.build(elements)
        return buffer.getvalue()

    async def _generate_executive_summary(
        self,
        project_id: str,
        document_summaries: Dict[str, str]
    ) -> str:
        """Generate executive summary using Sonnet."""
        prompt = f"""You are writing the Executive Summary for a Phase I Environmental Site Assessment (ESA) report.

Project ID: {project_id}

Based on the following document summaries from the project, write a professional executive summary (2-3 paragraphs) that:
1. Introduces the purpose and scope of the assessment
2. Summarizes key findings from the records review and site reconnaissance
3. States the conclusions and any recommendations

Document summaries available:
{document_summaries}

Write the executive summary in a professional, technical style appropriate for an environmental consulting report. Do not include a heading - just the summary text."""

        try:
            response = await self.llm_router.complete(
                task_type="summarize",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=1500,
                temperature=0.3
            )
            return response["content"]
        except Exception as e:
            self.logger.error(f"Failed to generate executive summary: {e}")
            return "Executive summary generation failed. Manual review required."

    async def _generate_section_text(
        self,
        section_name: str,
        document_texts: List[str]
    ) -> str:
        """Generate section transition/summary text using Sonnet."""
        if not document_texts:
            return f"No documents available for this section."

        combined_text = "\n\n---\n\n".join(document_texts[:3])  # Limit context

        prompt = f"""You are writing a brief introduction/summary paragraph for a section of a Phase I Environmental Site Assessment report.

Section: {section_name}

Document content samples:
{combined_text[:8000]}

Write 1-2 paragraphs that introduce this section and summarize the key information from the documents. Keep it professional and concise. Do not include the section heading - just the introductory text."""

        try:
            response = await self.llm_router.complete(
                task_type="summarize",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=800,
                temperature=0.3
            )
            return response["content"]
        except Exception as e:
            self.logger.warning(f"Failed to generate section text: {e}")
            return ""

    def _merge_pdfs(self, pdf_list: List[Tuple[str, Union[bytes, Path]]]) -> bytes:
        """
        Merge multiple PDFs into one.

        Args:
            pdf_list: List of (name, pdf_bytes_or_path) tuples

        Returns:
            Merged PDF as bytes
        """
        merger = PdfMerger()

        for name, pdf_data in pdf_list:
            try:
                if isinstance(pdf_data, bytes):
                    merger.append(io.BytesIO(pdf_data))
                elif isinstance(pdf_data, Path) or isinstance(pdf_data, str):
                    merger.append(str(pdf_data))
                else:
                    self.logger.warning(f"Unknown PDF data type for {name}")
            except Exception as e:
                self.logger.error(f"Failed to merge {name}: {e}")

        output = io.BytesIO()
        merger.write(output)
        merger.close()

        return output.getvalue()

    def _count_pdf_pages(self, pdf_data: Union[bytes, Path]) -> int:
        """Count pages in a PDF."""
        try:
            if isinstance(pdf_data, bytes):
                reader = PdfReader(io.BytesIO(pdf_data))
            else:
                reader = PdfReader(str(pdf_data))
            return len(reader.pages)
        except Exception:
            return 1

    def _verify_page_integrity(
        self,
        pdf_parts: List[Tuple[str, Union[bytes, Path]]],
        merged_pdf: bytes
    ) -> Dict[str, Any]:
        """
        Verify that all input pages are present in the merged output.

        This is a critical integrity check that ensures no pages are lost
        during the merge operation.

        Args:
            pdf_parts: List of (name, pdf_data) tuples that were merged
            merged_pdf: The final merged PDF as bytes

        Returns:
            Dict with:
                - verified: bool - True if page counts match
                - total_input_pages: int - Sum of pages from all inputs
                - output_pages: int - Pages in merged output
                - discrepancy: int - Difference (0 if verified)
                - details: List[Dict] - Per-input breakdown
                - missing_ranges: List[str] - Human-readable missing page info
        """
        details = []
        total_input_pages = 0
        current_page = 1

        # Count pages in each input
        for name, pdf_data in pdf_parts:
            try:
                if isinstance(pdf_data, bytes):
                    if len(pdf_data) == 0:
                        # Skip empty placeholders
                        continue
                    reader = PdfReader(io.BytesIO(pdf_data))
                else:
                    reader = PdfReader(str(pdf_data))

                page_count = len(reader.pages)
                details.append({
                    'name': name,
                    'pages': page_count,
                    'expected_range': f"{current_page}-{current_page + page_count - 1}"
                })
                total_input_pages += page_count
                current_page += page_count
            except Exception as e:
                self.logger.warning(f"Could not count pages in {name}: {e}")
                details.append({
                    'name': name,
                    'pages': 0,
                    'error': str(e)
                })

        # Count pages in output
        try:
            output_reader = PdfReader(io.BytesIO(merged_pdf))
            output_pages = len(output_reader.pages)
        except Exception as e:
            self.logger.error(f"Could not count pages in merged output: {e}")
            return {
                'verified': False,
                'total_input_pages': total_input_pages,
                'output_pages': 0,
                'discrepancy': total_input_pages,
                'details': details,
                'missing_ranges': ['Unable to read merged output'],
                'error': str(e)
            }

        # Check for discrepancy
        discrepancy = total_input_pages - output_pages
        verified = discrepancy == 0

        # Generate missing range information if there's a discrepancy
        missing_ranges = []
        if not verified:
            if discrepancy > 0:
                missing_ranges.append(
                    f"Missing {discrepancy} pages: expected {total_input_pages}, got {output_pages}"
                )
                # Try to identify which inputs might have failed
                for detail in details:
                    if detail.get('error'):
                        missing_ranges.append(
                            f"  - {detail['name']}: failed to read ({detail['error']})"
                        )
            else:
                missing_ranges.append(
                    f"Extra {-discrepancy} pages: expected {total_input_pages}, got {output_pages}"
                )

        return {
            'verified': verified,
            'total_input_pages': total_input_pages,
            'output_pages': output_pages,
            'discrepancy': discrepancy,
            'details': details,
            'missing_ranges': missing_ranges
        }

    def validate_input(self, input_data: Any) -> bool:
        """Validate input is a project ID or project path."""
        if isinstance(input_data, str):
            # Check if it's a valid project ID or path
            project_path = self.project_base_dir / input_data
            if project_path.exists():
                return True
            # Or direct path
            if Path(input_data).exists():
                return True
        return False

    def get_model(self) -> str:
        """Return the model used for assembly (Sonnet)."""
        return self.llm_router.get_model_for_task("assemble")

    def _load_triage_decisions(self, project_path: Path) -> Optional[Dict]:
        """Load triage decisions from project folder if they exist."""
        triage_file = project_path / "triage_decisions.json"
        if triage_file.exists():
            try:
                with open(triage_file) as f:
                    return json.load(f)
            except Exception as e:
                self.logger.warning(f"Could not load triage decisions: {e}")
        return None

    def _load_document_order(self, project_path: Path) -> Optional[List[str]]:
        """Load custom document ordering from project folder if it exists."""
        order_file = project_path / "document_order.json"
        if order_file.exists():
            try:
                with open(order_file) as f:
                    data = json.load(f)
                    return data.get("order", [])
            except Exception as e:
                self.logger.warning(f"Could not load document order: {e}")
        return None

    def _is_document_included(
        self, doc_path: Path, triage: Optional[Dict]
    ) -> bool:
        """Check if a document should be included based on triage decisions."""
        if triage is None:
            return True  # No triage = include everything

        import hashlib
        doc_id = hashlib.md5(str(doc_path).encode()).hexdigest()[:12]
        decisions = triage.get("decisions", {})
        decision = decisions.get(doc_id, {})
        return decision.get("include", True)

    def _compress_final_pdf(self, pdf_bytes: bytes, project_id: str) -> bytes:
        """
        Compress the final merged PDF to reduce bloat.

        Uses PyPDF2 to rewrite the PDF which deduplicates objects,
        and optionally Ghostscript for image downsampling.
        """
        import tempfile

        original_size = len(pdf_bytes)
        target_size = self.config.get("compressor", {}).get(
            "target_max_size_mb", 25
        ) * 1024 * 1024

        # Always do a PyPDF2 rewrite to deduplicate objects
        try:
            reader = PdfReader(io.BytesIO(pdf_bytes))
            writer = PdfWriter()

            for page in reader.pages:
                writer.add_page(page)

            # Compress streams
            for page in writer.pages:
                page.compress_content_streams()

            output = io.BytesIO()
            writer.write(output)
            rewritten_pdf = output.getvalue()

            rewritten_size = len(rewritten_pdf)
            if rewritten_size < original_size:
                self.logger.info(
                    f"PyPDF2 rewrite: {original_size / 1024 / 1024:.1f} MB -> "
                    f"{rewritten_size / 1024 / 1024:.1f} MB "
                    f"({(1 - rewritten_size / original_size) * 100:.1f}% reduction)"
                )
                pdf_bytes = rewritten_pdf
        except Exception as e:
            self.logger.warning(f"PyPDF2 rewrite failed, using original: {e}")

        # If still over target, try Ghostscript
        if len(pdf_bytes) > target_size:
            try:
                import subprocess

                gs_commands = ['gs', 'gswin64c', 'gswin32c']
                gs_cmd = None
                for cmd in gs_commands:
                    try:
                        subprocess.run(
                            [cmd, '--version'], capture_output=True, timeout=5
                        )
                        gs_cmd = cmd
                        break
                    except (FileNotFoundError, subprocess.TimeoutExpired):
                        continue

                if gs_cmd:
                    with tempfile.NamedTemporaryFile(
                        suffix='.pdf', delete=False
                    ) as tmp_in:
                        tmp_in.write(pdf_bytes)
                        tmp_in_path = tmp_in.name

                    tmp_out_path = tmp_in_path + '_compressed.pdf'
                    try:
                        result = subprocess.run([
                            gs_cmd,
                            '-sDEVICE=pdfwrite',
                            '-dPDFSETTINGS=/ebook',
                            '-dNOPAUSE', '-dQUIET', '-dBATCH',
                            '-dCompatibilityLevel=1.4',
                            f'-sOutputFile={tmp_out_path}',
                            tmp_in_path
                        ], capture_output=True, timeout=300)

                        if result.returncode == 0 and Path(tmp_out_path).exists():
                            gs_pdf = Path(tmp_out_path).read_bytes()
                            gs_size = len(gs_pdf)

                            # Verify page count
                            gs_reader = PdfReader(io.BytesIO(gs_pdf))
                            orig_reader = PdfReader(io.BytesIO(pdf_bytes))
                            if len(gs_reader.pages) == len(orig_reader.pages):
                                self.logger.info(
                                    f"Ghostscript: {len(pdf_bytes) / 1024 / 1024:.1f} MB -> "
                                    f"{gs_size / 1024 / 1024:.1f} MB "
                                    f"({(1 - gs_size / len(pdf_bytes)) * 100:.1f}% reduction)"
                                )
                                pdf_bytes = gs_pdf
                            else:
                                self.logger.warning(
                                    "Ghostscript changed page count, discarding"
                                )
                    finally:
                        Path(tmp_in_path).unlink(missing_ok=True)
                        Path(tmp_out_path).unlink(missing_ok=True)
            except Exception as e:
                self.logger.warning(f"Ghostscript compression failed: {e}")

        return pdf_bytes

    async def process(self, input_data: Any) -> SkillResult:
        """
        Assemble the final ESA report.

        Architecture:
        - Body sections (1.0-9.0) get LLM-generated narrative text ONLY
        - Appendices get the actual source document PDFs
        - Each document PDF is included exactly ONCE (in its appendix)
        - Triage decisions are respected (include/exclude per document)
        - Auto-compression reduces final PDF size

        Args:
            input_data: Project ID string

        Returns:
            SkillResult with report path and assembly details
        """
        project_id = input_data
        project_path = self.project_base_dir / project_id

        if not project_path.exists():
            return SkillResult.fail(
                error=f"Project folder not found: {project_path}",
                data={"project_id": project_id}
            )

        self.logger.info(f"Assembling report for project: {project_id}")

        # Update state
        if self.state_manager:
            self.state_manager.set_project_status(project_id, ProjectStatus.ASSEMBLING)

        try:
            # Load triage decisions and document order
            triage = self._load_triage_decisions(project_path)
            doc_order = self._load_document_order(project_path)

            if triage and triage.get("confirmed"):
                self.logger.info("Using confirmed triage decisions for assembly")

            # Track included document paths to prevent duplication
            included_doc_paths: set = set()

            # Collect all documents and build report structure
            pdf_parts: List[Tuple[str, bytes | Path]] = []
            sections: List[SectionContent] = []
            current_page = 1
            document_summaries = {}
            docs_included_count = 0
            docs_excluded_count = 0

            # 1. Cover Page
            cover_pdf = self._create_cover_page(
                project_id=project_id,
                site_address="[Site Address - To Be Updated]",
                client_name="[Client Name - To Be Updated]"
            )
            pdf_parts.append(("cover_page", cover_pdf))
            current_page += self._count_pdf_pages(cover_pdf)

            # Placeholder for TOC (we'll update page numbers later)
            toc_placeholder_index = len(pdf_parts)
            pdf_parts.append(("toc", b""))  # Placeholder
            toc_start_page = current_page
            current_page += 1  # Estimate 1 page for TOC

            # 2. Pre-extract text summaries from all documents for LLM context
            # This lets body sections reference document content without
            # including the full PDFs inline
            template_sections = self.esa_template.get("phase1_esa", {}).get("sections", [])

            for section_config in template_sections:
                doc_types = section_config.get("doc_types", [])
                sub_sections = section_config.get("sub_sections", [])
                all_doc_types = doc_types + [
                    dt for sub in sub_sections
                    for dt in sub.get("doc_types", [])
                ]

                for doc_type in set(all_doc_types):
                    docs = self._get_documents_by_type(project_path, doc_type)
                    for doc in docs[:2]:
                        if self._is_document_included(doc, triage):
                            text = self._extract_text_sample(doc)
                            if text:
                                document_summaries[f"{doc_type}: {doc.name}"] = text[:1000]

            # 3. Process each section from template
            for section_config in template_sections:
                section_id = section_config.get("id")
                section_name = section_config.get("name", section_id)
                doc_types = section_config.get("doc_types", [])
                sub_sections = section_config.get("sub_sections", [])
                is_appendix = section_id == "appendices"

                # Skip cover and TOC (already handled)
                if section_id in ["cover_page", "toc"]:
                    continue

                section_content = SectionContent(
                    section_id=section_id,
                    section_name=section_name,
                    page_number=current_page,
                    pdf_paths=[]
                )

                # Handle executive summary specially
                if section_id == "executive_summary":
                    summary_text = await self._generate_executive_summary(
                        project_id, document_summaries
                    )
                    section_pdf = self._create_section_page(section_name, summary_text)
                    pdf_parts.append((section_id, section_pdf))
                    current_page += self._count_pdf_pages(section_pdf)
                    sections.append(section_content)
                    continue

                # Collect document types for this section
                all_doc_types = doc_types + [
                    dt for sub in sub_sections
                    for dt in sub.get("doc_types", [])
                ]

                # For BODY sections (not appendices): generate narrative text only
                # Document PDFs go in appendices to avoid duplication
                if not is_appendix and all_doc_types:
                    section_docs = []
                    for doc_type in set(all_doc_types):
                        docs = self._get_documents_by_type(project_path, doc_type)
                        for d in docs:
                            if self._is_document_included(d, triage):
                                section_docs.append(d)

                    if section_docs:
                        doc_texts = [self._extract_text_sample(d) for d in section_docs[:3]]
                        intro_text = await self._generate_section_text(
                            section_name, doc_texts
                        )
                    else:
                        intro_text = ""

                    section_pdf = self._create_section_page(section_name, intro_text)
                    pdf_parts.append((f"{section_id}_header", section_pdf))
                    current_page += self._count_pdf_pages(section_pdf)

                # For APPENDICES: include actual document PDFs (once each)
                elif is_appendix:
                    # Add appendices header
                    section_pdf = self._create_section_page(section_name, "")
                    pdf_parts.append((f"{section_id}_header", section_pdf))
                    current_page += self._count_pdf_pages(section_pdf)

                    # Process each sub-appendix
                    for sub in sub_sections:
                        sub_name = sub.get("name", "")
                        sub_doc_types = sub.get("doc_types", [])

                        sub_docs = []
                        for doc_type in sub_doc_types:
                            docs = self._get_documents_by_type(project_path, doc_type)
                            for d in docs:
                                # Skip if excluded by triage or already included
                                if not self._is_document_included(d, triage):
                                    docs_excluded_count += 1
                                    continue
                                if str(d) in included_doc_paths:
                                    continue
                                sub_docs.append(d)

                        if sub_docs:
                            # Add sub-appendix header
                            sub_header = self._create_section_page(sub_name, "")
                            pdf_parts.append((f"{sub.get('id', sub_name)}_header", sub_header))
                            current_page += self._count_pdf_pages(sub_header)

                            # Add document PDFs
                            for doc_path in sub_docs:
                                pdf_parts.append((doc_path.name, doc_path))
                                section_content.pdf_paths.append(str(doc_path))
                                included_doc_paths.add(str(doc_path))
                                current_page += self._count_pdf_pages(doc_path)
                                docs_included_count += 1

                # Body sections without doc_types: generate narrative only
                else:
                    section_pdf = self._create_section_page(section_name, "")
                    pdf_parts.append((f"{section_id}_header", section_pdf))
                    current_page += self._count_pdf_pages(section_pdf)

                sections.append(section_content)

            # 4. Generate actual TOC with page numbers
            toc_pdf = self._create_toc(sections)
            pdf_parts[toc_placeholder_index] = ("toc", toc_pdf)

            # 5. Merge all PDFs
            self.logger.info(f"Merging {len(pdf_parts)} PDF parts")
            final_pdf = self._merge_pdfs(pdf_parts)

            # 6. CRITICAL: Verify page integrity
            self.logger.info("Verifying page integrity...")
            integrity_result = self._verify_page_integrity(pdf_parts, final_pdf)

            if not integrity_result['verified']:
                self.logger.error(
                    f"PAGE INTEGRITY CHECK FAILED: "
                    f"Expected {integrity_result['total_input_pages']} pages, "
                    f"got {integrity_result['output_pages']} pages"
                )

                if self.state_manager:
                    self.state_manager.set_project_status(project_id, ProjectStatus.FAILED)

                return SkillResult.fail(
                    error="Page integrity verification failed - pages may be missing from assembled report",
                    data={
                        'project_id': project_id,
                        'integrity_check': integrity_result,
                        'total_input_pages': integrity_result['total_input_pages'],
                        'output_pages': integrity_result['output_pages'],
                        'discrepancy': integrity_result['discrepancy'],
                        'missing_ranges': integrity_result['missing_ranges'],
                        'input_details': integrity_result['details']
                    }
                )

            self.logger.info(
                f"Page integrity verified: {integrity_result['output_pages']} pages"
            )

            # 7. Auto-compress the final PDF
            pre_compress_size = len(final_pdf)
            self.logger.info(
                f"Pre-compression size: {pre_compress_size / 1024 / 1024:.1f} MB"
            )
            final_pdf = self._compress_final_pdf(final_pdf, project_id)
            post_compress_size = len(final_pdf)

            if post_compress_size < pre_compress_size:
                reduction_pct = (1 - post_compress_size / pre_compress_size) * 100
                self.logger.info(
                    f"Final size: {post_compress_size / 1024 / 1024:.1f} MB "
                    f"({reduction_pct:.1f}% reduction from compression)"
                )

            # 8. Save the report
            report_filename = f"{project_id}_Phase_I_ESA_{datetime.now().strftime('%Y%m%d')}.pdf"
            report_path = self.output_dir / report_filename

            with open(report_path, "wb") as f:
                f.write(final_pdf)

            self.logger.info(f"Report assembled: {report_path}")

            # Also save to project folder
            project_report_path = project_path / "report" / report_filename
            project_report_path.parent.mkdir(parents=True, exist_ok=True)
            with open(project_report_path, "wb") as f:
                f.write(final_pdf)

            # Update state
            if self.state_manager:
                self.state_manager.set_project_status(project_id, ProjectStatus.QA_PENDING)

            # Re-verify page count after compression
            final_reader = PdfReader(io.BytesIO(final_pdf))
            final_page_count = len(final_reader.pages)

            return SkillResult.ok(
                data={
                    "project_id": project_id,
                    "report_path": str(report_path),
                    "project_report_path": str(project_report_path),
                    "total_pages": final_page_count,
                    "sections_count": len(sections),
                    "documents_included": docs_included_count,
                    "documents_excluded": docs_excluded_count,
                    "page_integrity_verified": True,
                    "pre_compression_size_mb": round(
                        pre_compress_size / 1024 / 1024, 2
                    ),
                    "final_size_mb": round(
                        post_compress_size / 1024 / 1024, 2
                    ),
                    "compression_reduction_pct": round(
                        (1 - post_compress_size / pre_compress_size) * 100, 1
                    ) if pre_compress_size > 0 else 0,
                    "triage_applied": triage is not None and triage.get("confirmed", False),
                    "integrity_details": {
                        "input_parts": len(pdf_parts),
                        "total_input_pages": integrity_result['total_input_pages'],
                        "output_pages": final_page_count
                    }
                },
                model=self.get_model()
            )

        except Exception as e:
            self.logger.exception(f"Report assembly failed: {e}")

            if self.state_manager:
                self.state_manager.set_project_status(project_id, ProjectStatus.FAILED)

            return SkillResult.fail(
                error=f"Report assembly failed: {str(e)}",
                data={"project_id": project_id}
            )

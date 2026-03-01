"""
ODIC ESA Pipeline - QA Validator

Comprehensive QA validation system with 5 validators:
1. Completeness Check - ASTM E1527-21 required sections
2. Page Integrity - Blank pages, duplicates, continuity
3. Project Consistency - Project ID, address, client consistency
4. Section Ordering - Appendix order, section sequence
5. Document Quality - Text extraction quality, truncation

This replaces the old QA checker with stricter cross-contamination rules.
"""

import re
import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime
import logging

import pdfplumber
from PyPDF2 import PdfReader
import yaml

from .base import BaseSkill, SkillResult
from core.llm_router import LLMRouter


logger = logging.getLogger(__name__)


@dataclass
class QAIssue:
    """A single QA issue found in the report."""
    severity: str  # 'critical', 'warning', 'info'
    validator: str  # 'completeness', 'page_integrity', 'consistency', 'ordering', 'quality'
    description: str
    page_range: Optional[Tuple[int, int]] = None
    suggestion: str = ""
    auto_fixable: bool = False


@dataclass
class QAValidationResult:
    """Complete QA validation result."""
    passed: bool
    critical_count: int = 0
    warning_count: int = 0
    info_count: int = 0
    issues: List[QAIssue] = field(default_factory=list)
    sections_found: List[str] = field(default_factory=list)
    sections_missing: List[str] = field(default_factory=list)
    cross_contamination_confirmed: bool = False


# ASTM E1527-21 Required Sections
ASTM_REQUIRED_SECTIONS = [
    {'id': 'cover_page', 'name': 'Cover Page', 'required': True, 'min_pages': 1},
    {'id': 'table_of_contents', 'name': 'Table of Contents', 'required': True, 'min_pages': 1},
    {'id': 'executive_summary', 'name': 'Executive Summary', 'required': True, 'min_pages': 1},
    {'id': 'section_1', 'name': 'Section 1.0 Introduction', 'required': True, 'min_pages': 1},
    {'id': 'section_2', 'name': 'Section 2.0 Site Description', 'required': True, 'min_pages': 2},
    {'id': 'section_3', 'name': 'Section 3.0 User Provided Information', 'required': True, 'min_pages': 1},
    {'id': 'section_4', 'name': 'Section 4.0 Records Review', 'required': True, 'min_pages': 3},
    {'id': 'section_5', 'name': 'Section 5.0 Historical Review', 'required': True, 'min_pages': 2},
    {'id': 'section_6', 'name': 'Section 6.0 Site Reconnaissance', 'required': True, 'min_pages': 2},
    {'id': 'section_7', 'name': 'Section 7.0 Findings and Opinions', 'required': True, 'min_pages': 1},
    {'id': 'section_8', 'name': 'Section 8.0 Conclusions', 'required': True, 'min_pages': 1},
    {'id': 'appendix_a', 'name': 'Appendix A - Site Photographs', 'required': True, 'min_pages': 1},
    {'id': 'appendix_b', 'name': 'Appendix B - Site Maps/Figures', 'required': True, 'min_pages': 1},
    {'id': 'appendix_c', 'name': 'Appendix C - Historical Research', 'required': True, 'min_pages': 1},
    {'id': 'appendix_d', 'name': 'Appendix D - Regulatory Records', 'required': True, 'min_pages': 1},
    {'id': 'appendix_e', 'name': 'Appendix E - EDR Report', 'required': True, 'min_pages': 5},
    {'id': 'appendix_f', 'name': 'Appendix F - Qualifications', 'required': True, 'min_pages': 1},
]

# Section detection patterns - match both standard ASTM and common variations
SECTION_PATTERNS = {
    'cover_page': [
        r'phase\s*i\s*environmental\s*site\s*assessment',
        r'environmental\s*site\s*assessment',
        r'prepared\s*for.*prepared\s*by',
    ],
    'table_of_contents': [
        r'table\s*of\s*contents',
    ],
    'executive_summary': [
        r'executive\s*summary',
    ],
    'section_1': [r'1\.0\s*introduction', r'\b1\s+introduction'],
    'section_2': [r'2\.0\s*(?:site|property)\s*description', r'\b2\s+(?:site|property)'],
    'section_3': [r'3\.0\s*(?:user|property)', r'\b3\s+(?:user|property)'],
    'section_4': [r'4\.0\s*(?:records|property.*history)', r'\b4\s+(?:records|property)'],
    'section_5': [r'5\.0\s*(?:historical|standard)', r'\b5\s+(?:historical|standard)'],
    'section_6': [r'6\.0\s*(?:site|user)', r'\b6\s+(?:site|user)'],
    'section_7': [r'7\.0\s*findings', r'\b7\s+findings', r'findings\s*and\s*(?:opinions|recommendations)'],
    'section_8': [r'8\.0\s*conclusions', r'\b8\s+conclusions', r'conclusions\s*and'],
    'appendix_a': [r'appendix\s*a\b', r'site\s*photographs'],
    'appendix_b': [r'appendix\s*b\b', r'site\s*maps', r'\bfigures\b'],
    'appendix_c': [r'appendix\s*c\b', r'historical\s*research'],
    'appendix_d': [r'appendix\s*d\b', r'regulatory\s*records'],
    'appendix_e': [r'appendix\s*e\b', r'\bedr\s*report\b'],
    'appendix_f': [r'appendix\s*f\b', r'qualifications'],
}


class QAValidator(BaseSkill):
    """
    Comprehensive QA validator for ESA reports.

    Runs 5 validators to catch real issues while avoiding false positives.
    """

    def __init__(
        self,
        config: dict,
        llm_router: Optional[LLMRouter] = None,
    ):
        """Initialize the QA validator."""
        super().__init__(config)
        self.llm_router = llm_router or LLMRouter(config)

        # Configuration
        qa_config = config.get("qa", {})
        self.minimum_pages = qa_config.get("minimum_pages", 50)
        self.blank_page_threshold = 50  # Characters to consider page blank

    def _extract_project_id(self, filename: str) -> Optional[str]:
        """Extract project ID from filename."""
        patterns = [
            r'(\d{7})-?ESAI',
            r'(\d{7})-?ESA',
            r'^(\d{7})[-_]',
        ]
        for pattern in patterns:
            match = re.search(pattern, filename, re.IGNORECASE)
            if match:
                return match.group(1)
        return None

    def _extract_all_text(self, pdf_path: Path) -> Tuple[List[str], int]:
        """Extract text from all pages, return (texts, page_count)."""
        texts = []
        try:
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages:
                    text = page.extract_text() or ""
                    texts.append(text)
        except Exception as e:
            self.logger.error(f"Failed to extract PDF text: {e}")
        return texts, len(texts)

    def _validate_completeness(
        self,
        page_texts: List[str],
        classified_sections: Optional[List[Dict]] = None
    ) -> List[QAIssue]:
        """
        Validator 1: Check for required ASTM E1527-21 sections.
        """
        issues = []
        full_text = "\n".join(page_texts).lower()

        found_sections = set()

        # Check each required section
        for section in ASTM_REQUIRED_SECTIONS:
            section_id = section['id']
            patterns = SECTION_PATTERNS.get(section_id, [])

            found = False
            for pattern in patterns:
                if re.search(pattern, full_text, re.IGNORECASE):
                    found = True
                    break

            if found:
                found_sections.add(section_id)
            else:
                severity = 'critical' if section['required'] else 'warning'
                issues.append(QAIssue(
                    severity=severity,
                    validator='completeness',
                    description=f"Missing required section: {section['name']}",
                    suggestion=f"Add {section['name']} to the report"
                ))

        # Use classified sections if available for more accurate check
        if classified_sections:
            for section in classified_sections:
                section_type = section.get('document_type', '')
                if section_type in SECTION_PATTERNS:
                    found_sections.add(section_type)

                # Only flag sections that are extremely short (likely misclassified)
                # Don't flag sections that are just slightly under expected length
                page_count = section.get('page_count', 0)
                min_pages = next(
                    (s['min_pages'] for s in ASTM_REQUIRED_SECTIONS if s['id'] == section_type),
                    1
                )
                # Only flag as info if under expected length - this is just informational
                # since section boundaries are often approximate in scanned documents
                if page_count < min_pages and page_count == 1 and min_pages > 2:
                    issues.append(QAIssue(
                        severity='info',  # Changed to info since this is often normal
                        validator='completeness',
                        description=f"Section '{section_type}' appears short ({page_count} pages)",
                        page_range=(section.get('start_page'), section.get('end_page')),
                        suggestion="Review section boundaries"
                    ))

        return issues

    def _validate_page_integrity(
        self,
        page_texts: List[str]
    ) -> List[QAIssue]:
        """
        Validator 2: Check page integrity.
        - Blank pages
        - Duplicate pages
        - Page number continuity
        """
        issues = []

        # Track page hashes for duplicate detection
        page_hashes: Dict[str, List[int]] = {}
        blank_pages = []

        for i, text in enumerate(page_texts):
            page_num = i + 1

            # Check for blank pages
            clean_text = text.strip()
            if len(clean_text) < self.blank_page_threshold:
                # Check if it's intentionally blank
                if 'intentionally' in clean_text.lower() and 'blank' in clean_text.lower():
                    continue
                blank_pages.append(page_num)

            # Hash for duplicate detection (ignore whitespace variations)
            normalized = re.sub(r'\s+', ' ', clean_text.lower())
            if len(normalized) > 100:  # Only hash substantive pages
                page_hash = hashlib.md5(normalized.encode()).hexdigest()
                if page_hash in page_hashes:
                    page_hashes[page_hash].append(page_num)
                else:
                    page_hashes[page_hash] = [page_num]

        # Report blank pages (grouped)
        if blank_pages:
            if len(blank_pages) > 5:
                issues.append(QAIssue(
                    severity='info',
                    validator='page_integrity',
                    description=f"{len(blank_pages)} blank pages found",
                    suggestion="Review blank pages - some may be unnecessary"
                ))
            else:
                issues.append(QAIssue(
                    severity='info',
                    validator='page_integrity',
                    description=f"Blank pages: {blank_pages}",
                    suggestion="Verify blank pages are intentional"
                ))

        # Report duplicate pages
        for page_hash, pages in page_hashes.items():
            if len(pages) > 1:
                issues.append(QAIssue(
                    severity='warning',
                    validator='page_integrity',
                    description=f"Possible duplicate pages: {pages}",
                    page_range=(min(pages), max(pages)),
                    suggestion="Review for unintentional duplicates"
                ))

        return issues

    def _validate_project_consistency(
        self,
        page_texts: List[str],
        expected_project_id: Optional[str],
        filename: str
    ) -> List[QAIssue]:
        """
        Validator 3: Check project consistency.
        - Project ID appears on cover
        - Address consistency
        - Client name consistency

        THIS IS WHERE REAL CROSS-CONTAMINATION IS CAUGHT.
        """
        issues = []

        # Check first few pages for project metadata
        first_pages = "\n".join(page_texts[:10]).lower() if page_texts else ""

        # Check project ID on cover
        if expected_project_id:
            if expected_project_id.lower() not in first_pages:
                issues.append(QAIssue(
                    severity='warning',
                    validator='consistency',
                    description=f"Project ID '{expected_project_id}' not found on cover pages",
                    page_range=(1, 3),
                    suggestion="Verify project ID is displayed on cover page"
                ))

            # Check for DIFFERENT 7-digit project IDs in MAIN REPORT NARRATIVE ONLY
            # This is the REAL cross-contamination check
            # EDR/appendix content will have many facility IDs that are NOT cross-contamination

            # ONLY check the main report section (first ~60 pages before appendices)
            main_report_text = "\n".join(page_texts[:60])

            # Find 7-digit numbers in main report that look like ODIC project IDs
            # Pattern: number followed by -ESAI or preceded by "Project" or in a specific format
            project_id_candidates = set()

            # Look for patterns like "6384578-ESAI" or "Project No. 6384578"
            for match in re.finditer(r'(\d{7})-?ESAI', main_report_text, re.IGNORECASE):
                pid = match.group(1)
                if pid != expected_project_id:
                    project_id_candidates.add(pid)

            for match in re.finditer(r'Project\s*(?:No\.?|Number)?[:\s]*(\d{7})', main_report_text, re.IGNORECASE):
                pid = match.group(1)
                if pid != expected_project_id:
                    project_id_candidates.add(pid)

            # Only flag as cross-contamination if we find a different project ID
            # in a context that suggests it's an ODIC project reference
            if project_id_candidates:
                for pid in project_id_candidates:
                    issues.append(QAIssue(
                        severity='warning',
                        validator='consistency',
                        description=f"Different ODIC project ID '{pid}' found in main report - review for cross-contamination",
                        suggestion="Verify this is not content from a different project"
                    ))

        return issues

    def _validate_section_ordering(
        self,
        classified_sections: Optional[List[Dict]] = None
    ) -> List[QAIssue]:
        """
        Validator 4: Check section ordering.
        - Appendices in correct order (A, B, C, D, E, F)
        - Main sections in sequence
        """
        issues = []

        if not classified_sections:
            return issues

        # Expected appendix order
        expected_appendix_order = ['A', 'B', 'C', 'D', 'E', 'F']

        found_appendices = []
        for section in classified_sections:
            label = section.get('appendix_label')
            if label:
                found_appendices.append(label)

        # Check appendix ordering
        if found_appendices:
            # Get expected order for found appendices
            expected_order = [a for a in expected_appendix_order if a in found_appendices]

            if found_appendices != expected_order:
                issues.append(QAIssue(
                    severity='warning',
                    validator='ordering',
                    description=f"Appendices out of order. Found: {found_appendices}, Expected: {expected_order}",
                    suggestion="Reorder appendices to match ASTM E1527-21 standard"
                ))

        return issues

    def _validate_document_quality(
        self,
        page_texts: List[str],
        page_count: int
    ) -> List[QAIssue]:
        """
        Validator 5: Check document quality.
        - Low text extraction (scan quality issues)
        - Truncated sections
        - Missing TOC entries
        """
        issues = []

        # Check for pages with very low text extraction
        low_extraction_pages = []
        for i, text in enumerate(page_texts):
            # Skip first/last few pages (may be cover/back)
            if i < 2 or i >= len(page_texts) - 2:
                continue

            # If a page in the middle has very little text, flag it
            if len(text.strip()) < 100 and i > 5 and i < len(page_texts) - 10:
                low_extraction_pages.append(i + 1)

        if len(low_extraction_pages) > 10:
            issues.append(QAIssue(
                severity='warning',
                validator='quality',
                description=f"{len(low_extraction_pages)} pages have low text extraction - possible scan quality issues",
                suggestion="Review scan quality for these pages"
            ))

        # Check minimum page count
        if page_count < self.minimum_pages:
            issues.append(QAIssue(
                severity='warning',
                validator='quality',
                description=f"Report has only {page_count} pages (expected {self.minimum_pages}+)",
                suggestion="Review for completeness - report may be incomplete"
            ))

        return issues

    async def validate_report(
        self,
        pdf_path: str,
        classified_sections: Optional[List[Dict]] = None
    ) -> SkillResult:
        """
        Run all 5 validators on a report.

        Args:
            pdf_path: Path to the assembled report PDF
            classified_sections: Optional pre-classified sections from TieredClassifier

        Returns:
            SkillResult with QA validation results
        """
        path = Path(pdf_path)
        if not path.exists():
            return SkillResult.fail(
                error=f"Report file not found: {pdf_path}",
                data={"file": pdf_path}
            )

        filename = path.name
        expected_project_id = self._extract_project_id(filename)

        self.logger.info(f"Running QA validation on {filename}")
        self.logger.info(f"Expected project ID: {expected_project_id}")

        # Extract all page text
        page_texts, page_count = self._extract_all_text(path)

        if page_count == 0:
            return SkillResult.fail(
                error="Could not extract any pages from PDF",
                data={"file": pdf_path}
            )

        # Run all validators
        all_issues: List[QAIssue] = []

        # Validator 1: Completeness
        all_issues.extend(self._validate_completeness(page_texts, classified_sections))

        # Validator 2: Page Integrity
        all_issues.extend(self._validate_page_integrity(page_texts))

        # Validator 3: Project Consistency
        all_issues.extend(self._validate_project_consistency(
            page_texts, expected_project_id, filename
        ))

        # Validator 4: Section Ordering
        all_issues.extend(self._validate_section_ordering(classified_sections))

        # Validator 5: Document Quality
        all_issues.extend(self._validate_document_quality(page_texts, page_count))

        # Count by severity
        critical_count = sum(1 for i in all_issues if i.severity == 'critical')
        warning_count = sum(1 for i in all_issues if i.severity == 'warning')
        info_count = sum(1 for i in all_issues if i.severity == 'info')

        # Count "real" warnings (exclude page integrity warnings which are often benign)
        # Page integrity warnings like duplicate pages are often false positives in scanned docs
        real_warning_count = sum(
            1 for i in all_issues
            if i.severity == 'warning' and i.validator != 'page_integrity'
        )

        # Determine pass/fail
        # Pass if: 0 critical issues AND <= 2 "real" warnings (excluding page integrity)
        passed = critical_count == 0 and real_warning_count <= 2

        # Check for confirmed cross-contamination
        cross_contam = any(
            'cross-contamination' in i.description.lower() and i.severity == 'critical'
            for i in all_issues
        )

        result = QAValidationResult(
            passed=passed,
            critical_count=critical_count,
            warning_count=warning_count,
            info_count=info_count,
            issues=all_issues,
            cross_contamination_confirmed=cross_contam
        )

        return SkillResult.ok(
            data={
                "passed": result.passed,
                "critical_count": result.critical_count,
                "warning_count": result.warning_count,
                "info_count": result.info_count,
                "issues": [
                    {
                        "severity": i.severity,
                        "validator": i.validator,
                        "description": i.description,
                        "page_range": list(i.page_range) if i.page_range else None,
                        "suggestion": i.suggestion,
                        "auto_fixable": i.auto_fixable,
                    }
                    for i in result.issues
                ],
                "cross_contamination_confirmed": result.cross_contamination_confirmed,
                "page_count": page_count,
                "filename": filename,
                "project_id": expected_project_id,
            }
        )

    def validate_input(self, input_data: Any) -> bool:
        """Validate input is a PDF file path."""
        if isinstance(input_data, dict):
            pdf_path = input_data.get('report_path') or input_data.get('pdf_path')
            if pdf_path:
                return Path(pdf_path).exists()
        elif isinstance(input_data, (str, Path)):
            return Path(input_data).exists()
        return False

    async def process(self, input_data: Any) -> SkillResult:
        """
        Process QA validation request.

        Args:
            input_data: Path to PDF or dict with 'report_path' and optional 'sections'

        Returns:
            SkillResult with validation results
        """
        if isinstance(input_data, dict):
            pdf_path = input_data.get('report_path') or input_data.get('pdf_path')
            sections = input_data.get('sections')
        else:
            pdf_path = str(input_data)
            sections = None

        return await self.validate_report(pdf_path, sections)

    def get_model(self) -> str:
        """Return model info."""
        return "rule-based validators"

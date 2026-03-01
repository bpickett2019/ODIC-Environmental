"""
ODIC ESA Pipeline - Tiered Classification System

3-tier classification system for 10x faster processing:
- Tier 1 (Rule-based): Pattern matching, instant, handles ~70% of pages
- Tier 2 (Fast LLM): Batched API calls for uncertain pages, handles ~25%
- Tier 3 (Deep LLM): Full analysis for remaining ~5% of pages

Cross-contamination detection is ONLY done in Tier 3 with strict rules.
"""

import re
import asyncio
import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime
import logging

import pdfplumber
import yaml

from .base import BaseSkill, SkillResult
from core.llm_router import LLMRouter


logger = logging.getLogger(__name__)


@dataclass
class PageClassification:
    """Classification result for a single page."""
    page_number: int
    document_type: str
    confidence: float
    tier: int  # 1, 2, or 3
    reasoning: str
    section_header: Optional[str] = None
    is_continuation: bool = False
    possible_cross_contamination: bool = False
    cross_contamination_signals: List[str] = field(default_factory=list)
    extracted_metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class DocumentSection:
    """A contiguous section of pages with the same classification."""
    document_type: str
    start_page: int
    end_page: int
    confidence: float
    page_count: int
    section_header: Optional[str] = None
    is_appendix: bool = False
    appendix_label: Optional[str] = None  # A, B, C, etc.


@dataclass
class ClassificationProgress:
    """Progress tracking for real-time updates."""
    total_pages: int
    tier1_count: int = 0
    tier2_count: int = 0
    tier3_count: int = 0
    processed_pages: int = 0
    current_tier: int = 1
    current_batch: int = 0
    total_batches: int = 0
    elapsed_seconds: float = 0


# ASTM E1527-21 Section Headers for Tier 1 matching
# These patterns match both standard ASTM section names and common variations
ASTM_SECTION_PATTERNS = {
    'cover_page': [
        r'phase\s*i\s*environmental\s*site\s*assessment',
        r'environmental\s*site\s*assessment',
        r'esa\s*report',
        r'prepared\s*for',
        r'prepared\s*by',
    ],
    'table_of_contents': [
        r'table\s*of\s*contents',
        r'^contents$',
    ],
    'executive_summary': [
        r'executive\s*summary',
        r'summary\s*of\s*findings',
    ],
    'section_1_introduction': [
        r'1\.0\s*introduction',
        r'^1\s+introduction',
        r'section\s*1[\.:]\s*introduction',
    ],
    'section_2_site_description': [
        r'2\.0\s*(?:site|property)\s*description',
        r'^2\s+(?:site|property)\s*description',
        r'section\s*2[\.:]\s*(?:site|property)',
        r'project\s*information',
    ],
    'section_3': [
        r'3\.0\s*(?:user\s*provided|property\s*reconnaissance)',
        r'^3\s+(?:user\s*provided|property\s*reconnaissance)',
        r'limiting\s*conditions',
    ],
    'section_4': [
        r'4\.0\s*(?:records\s*review|property.*history)',
        r'^4\s+(?:records\s*review|property.*history)',
        r'standard\s*environmental\s*record',
        r'vicinity\s*history',
    ],
    'section_5': [
        r'5\.0\s*(?:historical|standard\s*environmental)',
        r'^5\s+(?:historical|standard\s*environmental)',
        r'historical\s*review',
        r'environmental\s*records\s*research',
    ],
    'section_6': [
        r'6\.0\s*(?:site\s*reconnaissance|user\s*provided)',
        r'^6\s+(?:site\s*reconnaissance|user\s*provided)',
        r'site\s*visit',
        r'user\s*provided\s*information',
    ],
    'section_7_findings': [
        r'7\.0\s*findings',
        r'^7\s+findings',
        r'findings\s*and\s*(?:opinions|recommendations)',
    ],
    'section_8_conclusions': [
        r'8\.0\s*conclusions',
        r'^8\s+conclusions',
        r'conclusions\s*and\s*recommendations',
    ],
    'appendix_a': [
        r'appendix\s*a[\s:\-\.]+',
        r'^appendix\s*a\b',
        r'appendix\s*a\s*[-–—]\s*site\s*photographs',
    ],
    'appendix_b': [
        r'appendix\s*b[\s:\-\.]+',
        r'^appendix\s*b\b',
        r'appendix\s*b\s*[-–—]\s*(?:site\s*maps|figures)',
    ],
    'appendix_c': [
        r'appendix\s*c[\s:\-\.]+',
        r'^appendix\s*c\b',
        r'appendix\s*c\s*[-–—]\s*historical',
    ],
    'appendix_d': [
        r'appendix\s*d[\s:\-\.]+',
        r'^appendix\s*d\b',
        r'appendix\s*d\s*[-–—]\s*regulatory',
    ],
    'appendix_e': [
        r'appendix\s*e[\s:\-\.]+',
        r'^appendix\s*e\b',
        r'appendix\s*e\s*[-–—]\s*edr',
    ],
    'appendix_f': [
        r'appendix\s*f[\s:\-\.]+',
        r'^appendix\s*f\b',
        r'appendix\s*f\s*[-–—]\s*qualifications',
    ],
}

# Document type patterns for Tier 1
# Patterns are ordered by specificity - more specific patterns should match first
DOCUMENT_TYPE_PATTERNS = {
    'edr': [
        r'\bedr\b',
        r'environmental\s*data\s*resources',
        r'radius\s*map',
        r'database\s*search\s*report',
        r'the\s*edr\s*radius\s*map',
        r'edr\s*inquiry',
        r'target\s*property',
        r'mapped\s*sites',
        r'map\s*id\s*map\s*findings',  # EDR table header
        r'epa\s*id\s*number',  # EDR listings
        r'distance\s*edr\s*id',  # EDR table format
        r'facility\s*status',  # EDR records
        r'database:.*slic',  # State database refs
        r'database:.*rcra',
        r'database:.*lust',
        r'database:.*ust',
        r'database:.*cerclis',
        r'hwts.*waste.*code',  # HWTS waste records
        r'manifest\s*id',  # Hazardous waste manifests
        r'generator\s*epa\s*id',
        r'quantity\s*tons',
        r'waste\s*quantity',
        r'dtsc',  # Dept of Toxic Substances Control
        r'eval\s*general\s*type',  # Evaluation records
        r'violations\s*found',
    ],
    'main_report': [
        r'phase\s*i\s*environmental\s*site\s*assessment\s*report',
        r'project\s*no\.\s*\d{7}',
        r'findings\s*and\s*recommendations',
        r'summary\s*of\s*findings',
        r'conclusions\s*and\s*findings',
        r'astm\s*standard\s*practice\s*e1527',
        r'astm\s*e\s*1527',
        r'de\s*minimis\s*condition',
        r'recognized\s*environmental\s*condition',
        r'\brec\b.*\bfound\b',
        r'no\s*further\s*action',
        r'beneficial\s*uses\s*of\s*groundwater',
    ],
    'qualifications': [
        r'summary\s*of\s*qualifications',
        r'environmental\s*consultant',
        r'project\s*manager',
        r'professional\s*designation',
        r'years\s*experience',
        r'senior\s*environmental',
        r'environmental\s*professional',
        r'\bep\b.*\beducation\b',
    ],
    'sanborn_map': [
        r'sanborn',
        r'sanborn\s*map',
        r'sanborn\s*fire\s*insurance',
    ],
    'topographic_map': [
        r'\busgs\b',
        r'topographic\s*map',
        r'topo\s*map',
        r'quadrangle',
        r'u\.s\.\s*geological\s*survey',
    ],
    'aerial_photograph': [
        r'aerial\s*photograph',
        r'aerial\s*photo',
        r'aerial\s*imagery',
        r'flight\s*date',
        r'photo\s*source',
        r'historical\s*aerial',
    ],
    'city_directory': [
        r'city\s*directory',
        r'polk\s*directory',
        r'haines\s*directory',
        r'business\s*directory',
        r"cole's\s*directory",
    ],
    'site_photograph': [
        r'site\s*photo',
        r'photograph\s*log',
        r'photo\s*\d+',
        r'site\s*reconnaissance\s*photo',
        r'photo.*direction',
    ],
    'regulatory_correspondence': [
        r'environmental\s*protection\s*agency',
        r'\bepa\b.*\bletter\b',
        r'notice\s*of\s*violation',
        r'compliance\s*letter',
        r'regulatory\s*correspondence',
    ],
    'fire_insurance_map': [
        r'fire\s*insurance\s*map',
        r'perris\s*map',
        r'baist\s*map',
    ],
    'reliance_letter': [
        r'reliance\s*letter',
        r'to:.*lender',
        r'environmental\s*investigation',
    ],
}

# Document types that indicate continuation - if current page matches these weakly,
# and previous page was confidently classified as the same type, use continuation
CONTINUATION_TYPES = {
    'edr': 0.92,  # High confidence for EDR continuations
    'main_report': 0.88,
    'qualifications': 0.88,
}

# IDs that are NOT project IDs (should never trigger cross-contamination)
NON_PROJECT_ID_PATTERNS = [
    r'EPA\s*ID[:\s]*\d+',
    r'CERCLIS[:\s]*\d+',
    r'RCRA[:\s]*\d+',
    r'LUST[:\s]*\d+',
    r'UST[:\s]*\d+',
    r'NPDES[:\s]*\d+',
    r'FINDS[:\s]*\d+',
    r'FRS[:\s]*\d+',
    r'TRI[:\s]*\d+',
    r'State\s*ID[:\s]*\d+',
    r'Facility\s*ID[:\s]*\d+',
    r'Site\s*ID[:\s]*\d+',
    r'Case\s*No[:\s]*\d+',
    r'File\s*No[:\s]*\d+',
    r'Permit\s*No[:\s]*\d+',
    r'Lab\s*ID[:\s]*\d+',
    r'Sample\s*ID[:\s]*\d+',
    r'COC[:\s]*\d+',
    r'Chain\s*of\s*Custody[:\s]*\d+',
    r'USGS\s*\d+',
    r'Sortie[:\s]*\d+',
    r'Frame[:\s]*\d+',
    r'Roll[:\s]*\d+',
    r'Sheet[:\s]*\d+',
    r'Vol\.\s*\d+',
    r'Volume[:\s]*\d+',
]


class TieredClassifier(BaseSkill):
    """
    3-tier document classification system for ESA reports.

    Tier 1: Rule-based pattern matching (instant, no LLM)
    Tier 2: Fast LLM batch classification (batched API calls)
    Tier 3: Deep LLM analysis (full context, cross-contamination check)
    """

    def __init__(
        self,
        config: dict,
        llm_router: Optional[LLMRouter] = None,
        progress_callback: Optional[callable] = None
    ):
        """
        Initialize the tiered classifier.

        Args:
            config: Configuration dictionary
            llm_router: LLM router for Tier 2/3 classification
            progress_callback: Optional callback for progress updates
        """
        super().__init__(config)
        self.llm_router = llm_router or LLMRouter(config)
        self.progress_callback = progress_callback

        # Load document types
        self.document_types = self._load_document_types()

        # Thresholds
        self.tier1_confidence_threshold = 0.85
        self.tier2_confidence_threshold = 0.60
        self.tier2_batch_size = 15
        self.max_concurrent_batches = 3

        # Session state
        self.session_project_id: Optional[str] = None
        self.session_project_address: Optional[str] = None

    def _load_document_types(self) -> Dict[str, Any]:
        """Load document type definitions from YAML."""
        config_path = Path(__file__).parent.parent / "config" / "document_types.yaml"
        if config_path.exists():
            with open(config_path) as f:
                return yaml.safe_load(f)
        return {"document_types": {}}

    def _extract_project_id_from_filename(self, filename: str) -> Optional[str]:
        """
        Extract project ID from filename using common patterns.

        Patterns:
        - 6384578-ESAI-Report.pdf -> 6384578
        - ODIC-2024-001.pdf -> ODIC-2024-001
        - PROJECT-12345.pdf -> 12345
        """
        patterns = [
            r'(\d{7})-?ESAI',  # 7-digit ESAI format
            r'(\d{7})-?ESA',   # 7-digit ESA format
            r'ODIC[-_]?(\d{4})[-_]?(\d{3,4})',  # ODIC-2024-001
            r'PROJECT[-_]?(\d+)',  # PROJECT-123
            r'^(\d{7})[-_]',  # Leading 7 digits
        ]

        for pattern in patterns:
            match = re.search(pattern, filename, re.IGNORECASE)
            if match:
                if match.lastindex and match.lastindex > 1:
                    return f"ODIC-{match.group(1)}-{match.group(2)}"
                return match.group(1)

        return None

    def _extract_text_from_page(self, pdf_path: str, page_num: int) -> str:
        """Extract text from a specific PDF page."""
        try:
            with pdfplumber.open(pdf_path) as pdf:
                if page_num < len(pdf.pages):
                    return pdf.pages[page_num].extract_text() or ""
        except Exception as e:
            self.logger.warning(f"Failed to extract text from page {page_num}: {e}")
        return ""

    def _extract_all_pages(self, pdf_path: str) -> List[str]:
        """Extract text from all pages of a PDF."""
        pages = []
        try:
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages:
                    text = page.extract_text() or ""
                    pages.append(text)
        except Exception as e:
            self.logger.error(f"Failed to extract PDF pages: {e}")
        return pages

    def _tier1_classify_page(
        self,
        page_text: str,
        page_num: int,
        prev_classification: Optional[PageClassification] = None,
        next_page_text: Optional[str] = None
    ) -> Tuple[PageClassification, bool]:
        """
        Tier 1: Rule-based classification.

        Returns:
            Tuple of (classification, confident) - confident is True if Tier 1 is sufficient
        """
        text_lower = page_text.lower()

        # Check for ASTM section headers
        section_match = None
        section_confidence = 0.0

        for section_id, patterns in ASTM_SECTION_PATTERNS.items():
            for pattern in patterns:
                if re.search(pattern, text_lower):
                    # Higher confidence for exact section header matches
                    match_confidence = 0.90 if 'appendix' in section_id else 0.88
                    if match_confidence > section_confidence:
                        section_confidence = match_confidence
                        section_match = section_id

        # Check for document type patterns
        doc_type_match = None
        doc_type_confidence = 0.0

        for doc_type, patterns in DOCUMENT_TYPE_PATTERNS.items():
            match_count = 0
            for pattern in patterns:
                if re.search(pattern, text_lower):
                    match_count += 1

            if match_count > 0:
                # Confidence based on number of matching patterns
                confidence = min(0.90, 0.60 + (match_count * 0.10))
                if confidence > doc_type_confidence:
                    doc_type_confidence = confidence
                    doc_type_match = doc_type

        # Combine section and document type evidence
        final_type = 'unknown'
        final_confidence = 0.0

        if section_match and section_confidence > doc_type_confidence:
            final_type = section_match
            final_confidence = section_confidence
        elif doc_type_match:
            final_type = doc_type_match
            final_confidence = doc_type_confidence

        # Check for blank or minimal content pages FIRST
        if len(page_text.strip()) < 50:
            final_type = 'blank_page'
            final_confidence = 0.95
            is_continuation = False
        else:
            # Check for continuation from previous page
            is_continuation = False

            # More aggressive continuation for certain document types
            if prev_classification and prev_classification.confidence >= 0.70:
                prev_type = prev_classification.document_type

                # Check if current page has ANY weak signal for same type
                weak_match = False
                if prev_type in DOCUMENT_TYPE_PATTERNS:
                    patterns = DOCUMENT_TYPE_PATTERNS[prev_type]
                    for pattern in patterns:
                        if re.search(pattern, text_lower):
                            weak_match = True
                            break

                # For high-volume types like EDR, use aggressive continuation
                if prev_type in CONTINUATION_TYPES:
                    # If we weakly match the same type OR have no strong other classification
                    if weak_match or final_confidence < 0.70:
                        is_continuation = True
                        final_type = prev_type
                        final_confidence = CONTINUATION_TYPES[prev_type]
                elif final_confidence < 0.5 and prev_classification.confidence >= self.tier1_confidence_threshold:
                    # Standard continuation for other types
                    is_continuation = True
                    final_type = prev_type
                    final_confidence = prev_classification.confidence * 0.85

        classification = PageClassification(
            page_number=page_num,
            document_type=final_type,
            confidence=final_confidence,
            tier=1,
            reasoning=f"Tier 1 pattern match: {final_type}",
            section_header=section_match,
            is_continuation=is_continuation,
        )

        confident = final_confidence >= self.tier1_confidence_threshold
        return classification, confident

    async def _tier2_classify_batch(
        self,
        pages: List[Tuple[int, str, Optional[PageClassification]]],
        project_id: Optional[str] = None
    ) -> List[PageClassification]:
        """
        Tier 2: Fast LLM batch classification.

        Sends multiple pages to LLM in a single request.
        """
        if not self.llm_router.is_available():
            # Fall back to low-confidence Tier 1 results
            return [
                PageClassification(
                    page_number=p[0],
                    document_type='unknown',
                    confidence=0.3,
                    tier=2,
                    reasoning="LLM unavailable - needs manual review"
                )
                for p in pages
            ]

        # Build batch prompt
        page_excerpts = []
        for page_num, page_text, prev_class in pages:
            # Take first 500 chars plus context
            excerpt = page_text[:500] if len(page_text) > 500 else page_text
            context = ""
            if prev_class:
                context = f"Previous page: {prev_class.document_type}"
            page_excerpts.append(f"PAGE {page_num}:\n{context}\n{excerpt}\n---")

        prompt = f"""Classify each page excerpt into ONE of these types:
- edr (Environmental Database Report)
- sanborn_map (Sanborn Fire Insurance Map)
- topographic_map (USGS Topographic Map)
- aerial_photograph (Historical Aerial Photo)
- city_directory (City Directory listing)
- site_photograph (Site Visit Photos)
- regulatory_correspondence (EPA/Agency letters)
- fire_insurance_map (Non-Sanborn fire insurance)
- cover_page (Report cover)
- table_of_contents (TOC)
- executive_summary
- main_report_section (Sections 1-8 narrative)
- appendix_a through appendix_f
- qualifications (Professional qualifications)
- blank_page
- unknown

Project ID: {project_id or 'Unknown'}

{chr(10).join(page_excerpts)}

Return a JSON object with a "pages" array. For each page:
{{"pages": [{{"page": <num>, "type": "<type>", "confidence": <0-100>}}, ...]}}"""

        try:
            response = await self.llm_router.complete(
                task_type="classify",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
                max_tokens=1500
            )

            # Parse response
            import json
            content = response.get("content", "")

            # Handle both string and direct response
            if not content or not isinstance(content, str):
                self.logger.warning(f"Tier 2 got invalid content type: {type(content)}")
                content = str(content) if content else "{}"

            # Try to parse as JSON object first
            try:
                parsed = json.loads(content)
                if isinstance(parsed, dict) and "pages" in parsed:
                    results = parsed["pages"]
                elif isinstance(parsed, list):
                    results = parsed
                else:
                    # Try to find array in the response
                    json_match = re.search(r'\[.*\]', content, re.DOTALL)
                    results = json.loads(json_match.group()) if json_match else []
            except json.JSONDecodeError:
                # Fallback: try to extract JSON array
                json_match = re.search(r'\[.*\]', content, re.DOTALL)
                results = json.loads(json_match.group()) if json_match else []

            if results:

                classifications = []
                for i, (page_num, _, _) in enumerate(pages):
                    if i < len(results):
                        r = results[i]
                        conf = r.get("confidence", 50) / 100.0
                        classifications.append(PageClassification(
                            page_number=page_num,
                            document_type=r.get("type", "unknown"),
                            confidence=conf,
                            tier=2,
                            reasoning=f"Tier 2 batch classification"
                        ))
                    else:
                        classifications.append(PageClassification(
                            page_number=page_num,
                            document_type='unknown',
                            confidence=0.3,
                            tier=2,
                            reasoning="No classification returned"
                        ))

                return classifications

        except Exception as e:
            self.logger.error(f"Tier 2 batch classification failed: {e}")
            error_msg = str(e)
            # Return low-confidence results on failure
            return [
                PageClassification(
                    page_number=p[0],
                    document_type='unknown',
                    confidence=0.3,
                    tier=2,
                    reasoning=f"Tier 2 classification error: {error_msg}"
                )
                for p in pages
            ]

        # Return low-confidence results if no JSON match
        return [
            PageClassification(
                page_number=p[0],
                document_type='unknown',
                confidence=0.3,
                tier=2,
                reasoning="Tier 2 - no valid JSON response"
            )
            for p in pages
        ]

    async def _tier3_classify_page(
        self,
        page_text: str,
        page_num: int,
        project_id: Optional[str],
        prev_classification: Optional[PageClassification],
        next_classification: Optional[PageClassification]
    ) -> PageClassification:
        """
        Tier 3: Deep LLM analysis with cross-contamination detection.

        This is the ONLY tier that evaluates cross-contamination.
        """
        if not self.llm_router.is_available():
            return PageClassification(
                page_number=page_num,
                document_type='unknown',
                confidence=0.3,
                tier=3,
                reasoning="LLM unavailable - manual review required"
            )

        context_info = []
        if prev_classification:
            context_info.append(f"Previous page ({prev_classification.page_number}): {prev_classification.document_type}")
        if next_classification:
            context_info.append(f"Next page ({next_classification.page_number}): {next_classification.document_type}")

        prompt = f"""Analyze this page from a Phase I Environmental Site Assessment.

PROJECT ID: {project_id or 'Unknown'}
PAGE NUMBER: {page_num}
CONTEXT: {'; '.join(context_info) if context_info else 'None'}

PAGE TEXT:
---
{page_text[:3000]}
---

Classify this page and check for cross-contamination.

CRITICAL CROSS-CONTAMINATION RULES:
1. Cross-contamination means content from a DIFFERENT project appeared in this report
2. A different 7-digit project ID in narrative text IS cross-contamination
3. A completely different site address in the narrative IS cross-contamination
4. These are NOT cross-contamination:
   - EPA IDs, RCRA numbers, CERCLIS numbers, State Facility IDs
   - EDR database record numbers and facility identifiers
   - USGS map sheet numbers
   - Sanborn map volume/sheet numbers
   - Aerial photo sortie/frame numbers
   - Lab sample IDs, chain of custody numbers
   - Permit numbers, case numbers
   - Any ID in headers/footers of third-party documents

Respond with JSON:
{{
    "document_type": "<type>",
    "confidence": <0-100>,
    "reasoning": "<brief explanation>",
    "cross_contamination_detected": <true/false>,
    "cross_contamination_signals": ["list of signals if any"],
    "cross_contamination_confidence": <0-100 if detected, 0 otherwise>
}}

Document types: edr, sanborn_map, topographic_map, aerial_photograph, city_directory, site_photograph, regulatory_correspondence, fire_insurance_map, cover_page, table_of_contents, executive_summary, main_report_section, appendix_a-f, qualifications, blank_page, unknown"""

        try:
            response = await self.llm_router.complete(
                task_type="qa_check",  # Use reasoning model
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=800
            )

            import json
            content = response.get("content", "")
            json_match = re.search(r'\{.*\}', content, re.DOTALL)

            if json_match:
                result = json.loads(json_match.group())

                # Check cross-contamination with strict threshold
                cross_contam = False
                cross_signals = result.get("cross_contamination_signals", [])
                cross_conf = result.get("cross_contamination_confidence", 0)

                # Only flag if confidence > 90% AND we have multiple signals
                if result.get("cross_contamination_detected") and cross_conf >= 90 and len(cross_signals) >= 2:
                    cross_contam = True

                return PageClassification(
                    page_number=page_num,
                    document_type=result.get("document_type", "unknown"),
                    confidence=result.get("confidence", 50) / 100.0,
                    tier=3,
                    reasoning=result.get("reasoning", ""),
                    possible_cross_contamination=cross_contam,
                    cross_contamination_signals=cross_signals if cross_contam else []
                )

        except Exception as e:
            self.logger.error(f"Tier 3 classification failed for page {page_num}: {e}")

        return PageClassification(
            page_number=page_num,
            document_type='unknown',
            confidence=0.3,
            tier=3,
            reasoning="Tier 3 classification error"
        )

    def _consolidate_sections(
        self,
        classifications: List[PageClassification]
    ) -> List[DocumentSection]:
        """
        Consolidate page classifications into contiguous document sections.
        """
        if not classifications:
            return []

        sections = []
        current_type = classifications[0].document_type
        current_start = classifications[0].page_number
        current_confidences = [classifications[0].confidence]
        current_header = classifications[0].section_header

        for i, cls in enumerate(classifications[1:], 1):
            if cls.document_type != current_type and not cls.is_continuation:
                # Close current section
                sections.append(DocumentSection(
                    document_type=current_type,
                    start_page=current_start,
                    end_page=classifications[i-1].page_number,
                    confidence=sum(current_confidences) / len(current_confidences),
                    page_count=classifications[i-1].page_number - current_start + 1,
                    section_header=current_header,
                    is_appendix='appendix' in current_type.lower(),
                    appendix_label=self._extract_appendix_label(current_type)
                ))

                # Start new section
                current_type = cls.document_type
                current_start = cls.page_number
                current_confidences = [cls.confidence]
                current_header = cls.section_header
            else:
                current_confidences.append(cls.confidence)

        # Close final section
        sections.append(DocumentSection(
            document_type=current_type,
            start_page=current_start,
            end_page=classifications[-1].page_number,
            confidence=sum(current_confidences) / len(current_confidences),
            page_count=classifications[-1].page_number - current_start + 1,
            section_header=current_header,
            is_appendix='appendix' in current_type.lower(),
            appendix_label=self._extract_appendix_label(current_type)
        ))

        return sections

    def _extract_appendix_label(self, doc_type: str) -> Optional[str]:
        """Extract appendix letter from document type."""
        match = re.search(r'appendix[_\s]*([a-f])', doc_type.lower())
        return match.group(1).upper() if match else None

    async def classify_document(
        self,
        pdf_path: str,
        progress_callback: Optional[callable] = None
    ) -> SkillResult:
        """
        Classify all pages of a document using the 3-tier system.

        Args:
            pdf_path: Path to the PDF file
            progress_callback: Optional callback for progress updates

        Returns:
            SkillResult with classifications, sections, and statistics
        """
        callback = progress_callback or self.progress_callback

        # Extract project ID from filename
        filename = Path(pdf_path).name
        self.session_project_id = self._extract_project_id_from_filename(filename)

        self.logger.info(f"Starting tiered classification for {filename}")
        self.logger.info(f"Project ID: {self.session_project_id}")

        # Extract all pages
        start_time = datetime.now()
        pages = self._extract_all_pages(pdf_path)
        total_pages = len(pages)

        if total_pages == 0:
            return SkillResult.fail(
                error="No pages extracted from PDF",
                data={"file": pdf_path}
            )

        progress = ClassificationProgress(total_pages=total_pages)

        # ========== TIER 1: Rule-based classification ==========
        self.logger.info(f"Tier 1: Processing {total_pages} pages with rule-based classification")

        tier1_results: List[PageClassification] = []
        tier2_candidates: List[Tuple[int, str, Optional[PageClassification]]] = []

        for i, page_text in enumerate(pages):
            prev_class = tier1_results[-1] if tier1_results else None
            next_text = pages[i+1] if i+1 < len(pages) else None

            classification, confident = self._tier1_classify_page(
                page_text, i+1, prev_class, next_text
            )

            tier1_results.append(classification)

            if confident:
                progress.tier1_count += 1
            else:
                tier2_candidates.append((i+1, page_text, prev_class))

            progress.processed_pages += 1

            if callback and i % 100 == 0:
                progress.elapsed_seconds = (datetime.now() - start_time).total_seconds()
                await callback(progress)

        self.logger.info(f"Tier 1 complete: {progress.tier1_count} confident, {len(tier2_candidates)} need Tier 2")

        # ========== TIER 2: Fast LLM batch classification ==========
        if tier2_candidates:
            progress.current_tier = 2
            self.logger.info(f"Tier 2: Processing {len(tier2_candidates)} pages in batches")

            batches = [
                tier2_candidates[i:i+self.tier2_batch_size]
                for i in range(0, len(tier2_candidates), self.tier2_batch_size)
            ]
            progress.total_batches = len(batches)

            tier3_candidates: List[Tuple[int, str, Optional[PageClassification]]] = []

            # Process batches with concurrency limit
            for batch_idx in range(0, len(batches), self.max_concurrent_batches):
                concurrent_batches = batches[batch_idx:batch_idx + self.max_concurrent_batches]

                tasks = [
                    self._tier2_classify_batch(batch, self.session_project_id)
                    for batch in concurrent_batches
                ]

                batch_results = await asyncio.gather(*tasks)

                for batch, results in zip(concurrent_batches, batch_results):
                    for (page_num, page_text, prev_class), result in zip(batch, results):
                        # Update the tier 1 result with tier 2 classification
                        tier1_results[page_num - 1] = result

                        if result.confidence >= self.tier2_confidence_threshold:
                            progress.tier2_count += 1
                        else:
                            tier3_candidates.append((page_num, page_text, result))

                progress.current_batch = min(batch_idx + self.max_concurrent_batches, len(batches))
                if callback:
                    progress.elapsed_seconds = (datetime.now() - start_time).total_seconds()
                    await callback(progress)

            self.logger.info(f"Tier 2 complete: {progress.tier2_count} confident, {len(tier3_candidates)} need Tier 3")

            # ========== TIER 3: Deep LLM analysis ==========
            if tier3_candidates:
                progress.current_tier = 3
                self.logger.info(f"Tier 3: Processing {len(tier3_candidates)} pages with deep analysis")

                for page_num, page_text, prev_class in tier3_candidates:
                    next_class = tier1_results[page_num] if page_num < len(tier1_results) else None

                    result = await self._tier3_classify_page(
                        page_text,
                        page_num,
                        self.session_project_id,
                        prev_class,
                        next_class
                    )

                    tier1_results[page_num - 1] = result
                    progress.tier3_count += 1

                    if callback:
                        progress.elapsed_seconds = (datetime.now() - start_time).total_seconds()
                        await callback(progress)

        # ========== Consolidate results ==========
        sections = self._consolidate_sections(tier1_results)

        # Count cross-contamination issues
        cross_contam_pages = [
            c for c in tier1_results if c.possible_cross_contamination
        ]

        elapsed = (datetime.now() - start_time).total_seconds()

        return SkillResult.ok(
            data={
                "filename": filename,
                "project_id": self.session_project_id,
                "total_pages": total_pages,
                "classifications": [
                    {
                        "page": c.page_number,
                        "type": c.document_type,
                        "confidence": c.confidence,
                        "tier": c.tier,
                        "reasoning": c.reasoning,
                        "section_header": c.section_header,
                        "is_continuation": c.is_continuation,
                        "cross_contamination": c.possible_cross_contamination,
                        "cross_contamination_signals": c.cross_contamination_signals,
                    }
                    for c in tier1_results
                ],
                "sections": [
                    {
                        "document_type": s.document_type,
                        "start_page": s.start_page,
                        "end_page": s.end_page,
                        "page_count": s.page_count,
                        "confidence": s.confidence,
                        "section_header": s.section_header,
                        "is_appendix": s.is_appendix,
                        "appendix_label": s.appendix_label,
                    }
                    for s in sections
                ],
                "statistics": {
                    "tier1_confident": progress.tier1_count,
                    "tier2_classified": progress.tier2_count,
                    "tier3_analyzed": progress.tier3_count,
                    "cross_contamination_pages": len(cross_contam_pages),
                    "elapsed_seconds": elapsed,
                    "pages_per_second": total_pages / elapsed if elapsed > 0 else 0,
                },
                "cross_contamination_issues": [
                    {
                        "page": c.page_number,
                        "signals": c.cross_contamination_signals,
                    }
                    for c in cross_contam_pages
                ],
            }
        )

    def validate_input(self, input_data: Any) -> bool:
        """Validate input is a PDF file path."""
        if not isinstance(input_data, (str, Path)):
            return False
        path = Path(input_data)
        return path.exists() and path.suffix.lower() == '.pdf'

    async def process(self, input_data: Any) -> SkillResult:
        """
        Process a document using tiered classification.

        Args:
            input_data: Path to PDF file

        Returns:
            SkillResult with classification results
        """
        return await self.classify_document(str(input_data))

    def get_model(self) -> str:
        """Return model info for this skill."""
        return "tiered (rule-based + LLM)"

"""
ODIC ESA Pipeline - Document Classifier Skill

Classifies incoming documents into ESA document types using Kimi K2.5 AI.
Uses instant mode (fast, no deep reasoning) for efficient classification.
Returns classification with confidence score; flags low-confidence results
for manual review.
"""

import json
import re
from pathlib import Path
from typing import Any, Dict, Optional, List
from dataclasses import dataclass

import yaml
import pdfplumber

from .base import BaseSkill, SkillResult
from core.llm_router import LLMRouter


@dataclass
class ClassificationResult:
    """Result of document classification."""
    document_type: str
    confidence: float
    project_id: Optional[str]
    reasoning: str
    requires_manual_review: bool
    extracted_metadata: Dict[str, Any]


class RuleBasedClassifier:
    """
    Rule-based document classifier using keyword matching.
    Used as a fallback when AI API is not available.
    """

    def __init__(self, document_types: Dict[str, Any]):
        """
        Initialize with document type definitions.

        Args:
            document_types: Document type definitions from YAML config
        """
        self.document_types = document_types.get("document_types", {})

    def classify(self, text: str, filename: str = "") -> Dict[str, Any]:
        """
        Classify document using keyword matching.

        Args:
            text: Document text content
            filename: Optional filename for additional context

        Returns:
            Classification result dict
        """
        text_lower = text.lower()
        filename_lower = filename.lower()
        combined_text = f"{text_lower} {filename_lower}"

        # Score each document type by keyword matches
        scores = {}
        for type_id, type_info in self.document_types.items():
            if type_id == "other":
                continue

            keywords = type_info.get("keywords", [])
            if not keywords:
                continue

            # Count keyword matches
            match_count = 0
            matched_keywords = []
            for keyword in keywords:
                keyword_lower = keyword.lower()
                # Check for exact phrase match
                if keyword_lower in combined_text:
                    match_count += 1
                    matched_keywords.append(keyword)
                    # Bonus for longer keyword matches (more specific)
                    if len(keyword_lower) > 10:
                        match_count += 0.5

            if match_count > 0:
                # Calculate confidence based on matches vs total keywords
                base_confidence = min(0.95, 0.5 + (match_count / len(keywords)) * 0.45)
                scores[type_id] = {
                    "score": match_count,
                    "confidence": base_confidence,
                    "matched_keywords": matched_keywords
                }

        # Find best match
        if scores:
            best_type = max(scores.keys(), key=lambda k: scores[k]["score"])
            result = scores[best_type]

            # Adjust confidence based on match strength
            confidence = result["confidence"]
            if result["score"] >= 3:
                confidence = min(0.95, confidence + 0.1)

            return {
                "document_type": best_type,
                "confidence": confidence,
                "reasoning": f"Rule-based classification matched keywords: {', '.join(result['matched_keywords'][:5])}",
                "extracted_metadata": {
                    "classification_method": "rule_based",
                    "matched_keywords": result["matched_keywords"]
                }
            }

        # No matches - return "other"
        return {
            "document_type": "other",
            "confidence": 0.3,
            "reasoning": "No keyword matches found - rule-based classification could not determine document type",
            "extracted_metadata": {
                "classification_method": "rule_based",
                "matched_keywords": []
            }
        }


class DocumentClassifier(BaseSkill):
    """
    Classifies ESA documents using Kimi K2.5 AI (instant mode).

    Takes a PDF file path, extracts text, sends to Kimi for classification,
    and returns the document type with confidence score.
    """

    # Classification prompt template
    CLASSIFICATION_PROMPT = """You are a document classifier for Phase I Environmental Site Assessments (ESAs) at ODIC Environmental.

Analyze the following document text and classify it into ONE of these document types:

DOCUMENT TYPES:
{document_types}

DOCUMENT TEXT:
---
{document_text}
---

Respond with a JSON object containing:
{{
    "document_type": "<type_id from the list above>",
    "confidence": <integer between 0 and 100>,
    "belongs_to_current_project": <true if this is ODIC's own work product, false if third-party>,
    "entity_detected": "<name of company/entity that prepared this document, or 'ODIC Environmental' if ours>",
    "reasoning": "<brief explanation of why you chose this classification>",
    "extracted_metadata": {{
        "date": "<date if found, null otherwise>",
        "location": "<location/address if found, null otherwise>",
        "project_id": "<project ID if found in filename or text, null otherwise>",
        "report_number": "<report reference number if found, null otherwise>",
        "company_name": "<name of company that prepared the document, null if not found>",
        "is_appendix_content": "<true if this appears to be supporting/appendix material, false if main report content>",
        "page_zone": "<'main_report' if pages 1-60 style content, 'appendix' if supporting documents style>"
    }}
}}

IMPORTANT CLASSIFICATION RULES:
- Choose the SINGLE most likely document type
- Confidence is 0-100 scale: 90+ is high, 70-89 is medium, below 70 needs review
- Set confidence to 100 only if you are absolutely certain
- Set confidence below 90 if there is any ambiguity
- If the document doesn't clearly match any type, use "other" with low confidence
- Extract any dates, locations, project IDs, report numbers, and company names you can identify
- CRITICAL: Determine if this is ODIC's own work or a third-party document

==============================================================================
CRITICAL: UNDERSTANDING PHASE I ESA DOCUMENT STRUCTURE
==============================================================================

A complete Phase I ESA report has TWO DISTINCT ZONES:

ZONE 1 - MAIN REPORT (typically pages 1-60):
- ODIC Environmental's professional opinion and analysis
- Cover page, Table of Contents, Executive Summary
- Sections 1.0 through 8.0 (Introduction, Site Description, Records Review, etc.)
- Written narrative content authored by ODIC Environmental
- This is the FIRM'S OWN WORK PRODUCT

ZONE 2 - APPENDICES (typically pages 60+):
- Supporting documentation and reference materials
- Third-party reports from OTHER environmental companies
- Historical records (Sanborn maps, aerial photos, city directories)
- EDR database reports
- Regulatory correspondence
- Site photographs
- These are REFERENCE MATERIALS, not ODIC's own analysis

==============================================================================
CRITICAL: Distinguishing Environmental Reports
==============================================================================

When you encounter what appears to be a Phase I ESA or environmental report, you MUST determine:

1. "prior_environmental_report": A report prepared BY ODIC Environmental:
   - "ODIC Environmental" or "Odic" appears in the letterhead/company name
   - This is ODIC's OWN prior work for this property
   - Same property address, prepared by ODIC for previous assessment
   - Confidence should be HIGH (0.9+) only if you clearly see ODIC branding

2. "reference_report": A report from a DIFFERENT environmental company:
   - Company name that is NOT "ODIC Environmental"
   - Examples: ERM, Tetra Tech, AECOM, Kleinfelder, Geo-Solutions, Partner Engineering,
     Langan, Brown and Caldwell, Arcadis, Stantec, WSP, SCS Engineers, TRC, etc.
   - This is THIRD-PARTY documentation included as a reference
   - Often found in the appendices section of a larger report
   - May be a Phase I, Phase II, or other environmental assessment
   - May be for adjacent property, historical assessment, or regulatory requirement

CLASSIFICATION LOGIC:
- If you see an environmental report AND the company is NOT ODIC Environmental → "reference_report"
- If you see an environmental report AND the company IS ODIC Environmental → "prior_environmental_report"
- If you cannot determine the company → use lower confidence and flag for manual review

APPENDIX INDICATORS (suggests reference_report):
- Page headers like "Appendix B", "Appendix C", etc.
- Document appears to be inserted/scanned into a larger report
- Different formatting/letterhead from ODIC standard
- Contains a complete report from another firm
- EDR reports, Sanborn maps, aerial photos → classify by their specific type, NOT as reference_report

Respond ONLY with the JSON object, no other text."""

    def __init__(self, config: dict, llm_router: Optional[LLMRouter] = None):
        """
        Initialize the document classifier.

        Args:
            config: Configuration dictionary
            llm_router: Optional LLMRouter instance (created if not provided)
        """
        super().__init__(config)
        self.llm_router = llm_router or LLMRouter(config)

        # Load document type definitions
        self.document_types = self._load_document_types()

        # Initialize rule-based classifier as fallback
        self.rule_based_classifier = RuleBasedClassifier(self.document_types)

        # Classification settings
        self.confidence_threshold = config.get("pipeline", {}).get(
            "confidence_threshold", 0.90
        )
        self.max_text_chars = self.document_types.get("classification", {}).get(
            "max_text_chars", 50000
        )

    def _load_document_types(self) -> Dict[str, Any]:
        """Load document type definitions from YAML config."""
        config_path = Path(__file__).parent.parent / "config" / "document_types.yaml"

        if config_path.exists():
            with open(config_path, "r") as f:
                return yaml.safe_load(f)
        else:
            self.logger.warning(f"Document types config not found at {config_path}")
            return {"document_types": {}}

    def _format_document_types_for_prompt(self) -> str:
        """Format document types as a string for the classification prompt."""
        doc_types = self.document_types.get("document_types", {})
        lines = []

        for type_id, type_info in doc_types.items():
            name = type_info.get("name", type_id)
            description = type_info.get("description", "")
            keywords = type_info.get("keywords", [])

            lines.append(f"- {type_id}: {name}")
            lines.append(f"  Description: {description}")
            if keywords:
                lines.append(f"  Keywords: {', '.join(keywords[:5])}")
            lines.append("")

        return "\n".join(lines)

    def _extract_text_from_pdf(self, pdf_path: str) -> str:
        """
        Extract text content from a PDF file.

        For large documents (>10 pages), extracts first 5 and last 5 pages
        to capture both the beginning (title, intro) and end (appendices, signatures).

        Args:
            pdf_path: Path to the PDF file

        Returns:
            Extracted text content
        """
        text_parts = []

        try:
            with pdfplumber.open(pdf_path) as pdf:
                total_pages = len(pdf.pages)

                # For large documents, use first 5 + last 5 pages strategy
                if total_pages > 10:
                    # Extract first 5 pages
                    for i in range(min(5, total_pages)):
                        page_text = pdf.pages[i].extract_text()
                        if page_text:
                            text_parts.append(f"[Page {i + 1} of {total_pages}]\n{page_text}")

                    text_parts.append(f"\n[... {total_pages - 10} pages omitted ...]\n")

                    # Extract last 5 pages
                    start_idx = max(5, total_pages - 5)
                    for i in range(start_idx, total_pages):
                        page_text = pdf.pages[i].extract_text()
                        if page_text:
                            text_parts.append(f"[Page {i + 1} of {total_pages}]\n{page_text}")
                else:
                    # For smaller documents, extract all pages
                    for i, page in enumerate(pdf.pages):
                        page_text = page.extract_text()
                        if page_text:
                            text_parts.append(f"[Page {i + 1} of {total_pages}]\n{page_text}")

                        # Stop if we've extracted enough text
                        if len("\n".join(text_parts)) > self.max_text_chars:
                            break

        except Exception as e:
            self.logger.error(f"Error extracting text from PDF: {e}")
            raise

        full_text = "\n\n".join(text_parts)

        # Truncate if necessary
        if len(full_text) > self.max_text_chars:
            full_text = full_text[: self.max_text_chars] + "\n[... truncated ...]"

        return full_text

    def _extract_project_id_from_filename(self, filename: str) -> Optional[str]:
        """
        Try to extract project ID from filename.

        Common patterns: ODIC-2024-001, PROJECT-123, etc.
        """
        patterns = [
            r"ODIC[-_]?\d{4}[-_]?\d{3,4}",  # ODIC-2024-001
            r"PROJECT[-_]?\d+",  # PROJECT-123
            r"PRJ[-_]?\d+",  # PRJ-123
            r"\d{4}[-_]\d{3,4}",  # 2024-001
        ]

        for pattern in patterns:
            match = re.search(pattern, filename, re.IGNORECASE)
            if match:
                return match.group(0).upper()

        return None

    def _parse_llm_response(self, response_text: str) -> Dict[str, Any]:
        """
        Parse the JSON response from the LLM.

        Args:
            response_text: Raw response text from LLM

        Returns:
            Parsed dictionary
        """
        # Try to extract JSON from the response
        # Handle cases where LLM adds extra text around the JSON
        try:
            # First, try direct JSON parse
            return json.loads(response_text)
        except json.JSONDecodeError:
            pass

        # Try to find JSON object in the response
        json_match = re.search(r"\{.*\}", response_text, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group())
            except json.JSONDecodeError:
                pass

        # If all parsing fails, return a default
        self.logger.warning(f"Could not parse LLM response: {response_text[:200]}")
        return {
            "document_type": "other",
            "confidence": 0.0,
            "reasoning": "Failed to parse classification response",
            "extracted_metadata": {},
        }

    def validate_input(self, input_data: Any) -> bool:
        """
        Validate that input is a valid file path to a PDF.

        Args:
            input_data: Should be a string path to a PDF file

        Returns:
            True if valid, False otherwise
        """
        if not isinstance(input_data, (str, Path)):
            self.logger.error(f"Input must be a file path, got: {type(input_data)}")
            return False

        path = Path(input_data)

        if not path.exists():
            self.logger.error(f"File does not exist: {path}")
            return False

        if path.suffix.lower() != ".pdf":
            self.logger.error(f"File must be a PDF: {path}")
            return False

        return True

    def get_model(self) -> str:
        """Return the model used for classification (Kimi K2.5)."""
        info = self.llm_router.get_model_info()
        return info.get("classify", "kimi-k2.5")

    async def process(self, input_data: Any) -> SkillResult:
        """
        Classify a document.

        Args:
            input_data: Path to PDF file to classify

        Returns:
            SkillResult containing ClassificationResult
        """
        pdf_path = Path(input_data)
        self.logger.info(f"Classifying document: {pdf_path.name}")

        # Extract text from PDF
        try:
            document_text = self._extract_text_from_pdf(str(pdf_path))
        except Exception as e:
            return SkillResult.fail(
                error=f"Failed to extract text from PDF: {e}",
                data={"file": str(pdf_path)},
            )

        if not document_text.strip():
            return SkillResult.fail(
                error="No text could be extracted from PDF",
                data={"file": str(pdf_path)},
            )

        # Try to extract project ID from filename
        filename_project_id = self._extract_project_id_from_filename(pdf_path.name)

        # Check if LLM is available - use rule-based fallback if not
        if not self.llm_router.is_available():
            self.logger.info("LLM not available, using rule-based classification")
            parsed = self.rule_based_classifier.classify(document_text, pdf_path.name)
            model_name = "rule_based"
            usage = {"input_tokens": 0, "output_tokens": 0}
        else:
            # Build classification prompt for LLM
            prompt = self.CLASSIFICATION_PROMPT.format(
                document_types=self._format_document_types_for_prompt(),
                document_text=document_text,
            )

            # Call LLM for classification
            try:
                response = await self.llm_router.complete(
                    task_type="classify",
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.0,  # Deterministic classification
                    max_tokens=1024,
                )
                # Parse response
                parsed = self._parse_llm_response(response["content"])
                model_name = response.get("model", "kimi-k2.5")
                usage = response.get("usage", {"input_tokens": 0, "output_tokens": 0})
            except Exception as e:
                # Fall back to rule-based classification on LLM failure
                self.logger.warning(f"LLM classification failed, using rule-based fallback: {e}")
                parsed = self.rule_based_classifier.classify(document_text, pdf_path.name)
                model_name = "rule_based_fallback"
                usage = {"input_tokens": 0, "output_tokens": 0}

        # Extract values with defaults
        document_type = parsed.get("document_type", "other")
        # Handle confidence as either 0-1 float or 0-100 int
        raw_confidence = parsed.get("confidence", 0)
        confidence = float(raw_confidence) / 100.0 if raw_confidence > 1 else float(raw_confidence)
        reasoning = parsed.get("reasoning", "")
        extracted_metadata = parsed.get("extracted_metadata", {})
        belongs_to_current_project = parsed.get("belongs_to_current_project", True)
        entity_detected = parsed.get("entity_detected", extracted_metadata.get("company_name"))

        # Use filename project ID if LLM didn't find one
        project_id = extracted_metadata.get("project_id") or filename_project_id

        # Determine if manual review is needed
        requires_manual_review = (
            confidence < self.confidence_threshold or document_type == "other"
        )

        if requires_manual_review:
            self.logger.warning(
                f"Low confidence ({confidence:.2f}) classification for {pdf_path.name}. "
                f"Flagged for manual review."
            )

        # Build result
        classification = ClassificationResult(
            document_type=document_type,
            confidence=confidence,
            project_id=project_id,
            reasoning=reasoning,
            requires_manual_review=requires_manual_review,
            extracted_metadata=extracted_metadata,
        )

        return SkillResult.ok(
            data={
                "type": classification.document_type,
                "confidence": classification.confidence,
                "confidence_score": int(classification.confidence * 100),
                "project_id": classification.project_id,
                "reasoning": classification.reasoning,
                "requires_manual_review": classification.requires_manual_review,
                "extracted_metadata": classification.extracted_metadata,
                "belongs_to_current_project": belongs_to_current_project,
                "entity_detected": entity_detected,
                "ai_notes": reasoning,
                "file": str(pdf_path),
                "filename": pdf_path.name,
            },
            model=model_name,
            usage=usage,
        )

    async def classify_text(self, text: str, filename: str = "") -> SkillResult:
        """
        Classify document from raw text (for testing without PDFs).

        Args:
            text: Document text content
            filename: Optional filename for project ID extraction

        Returns:
            SkillResult containing classification
        """
        self.logger.info(f"Classifying text content (length: {len(text)})")

        # Truncate if necessary
        if len(text) > self.max_text_chars:
            text = text[: self.max_text_chars] + "\n[... truncated ...]"

        # Try to extract project ID from filename
        filename_project_id = (
            self._extract_project_id_from_filename(filename) if filename else None
        )

        # Check if LLM is available - use rule-based fallback if not
        if not self.llm_router.is_available():
            self.logger.info("LLM not available, using rule-based classification")
            parsed = self.rule_based_classifier.classify(text, filename)

            document_type = parsed.get("document_type", "other")
            confidence = float(parsed.get("confidence", 0.0))
            reasoning = parsed.get("reasoning", "")
            extracted_metadata = parsed.get("extracted_metadata", {})

            project_id = extracted_metadata.get("project_id") or filename_project_id

            requires_manual_review = (
                confidence < self.confidence_threshold or document_type == "other"
            )

            return SkillResult.ok(
                data={
                    "type": document_type,
                    "confidence": confidence,
                    "project_id": project_id,
                    "reasoning": reasoning,
                    "requires_manual_review": requires_manual_review,
                    "extracted_metadata": extracted_metadata,
                    "filename": filename,
                },
                model="rule_based",
                usage={"input_tokens": 0, "output_tokens": 0},
            )

        # Build classification prompt for LLM
        prompt = self.CLASSIFICATION_PROMPT.format(
            document_types=self._format_document_types_for_prompt(),
            document_text=text,
        )

        # Call LLM for classification
        try:
            response = await self.llm_router.complete(
                task_type="classify",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=1024,
            )
        except Exception as e:
            # Fall back to rule-based classification on LLM failure
            self.logger.warning(f"LLM classification failed, using rule-based fallback: {e}")
            parsed = self.rule_based_classifier.classify(text, filename)

            document_type = parsed.get("document_type", "other")
            confidence = float(parsed.get("confidence", 0.0))
            reasoning = parsed.get("reasoning", "")
            extracted_metadata = parsed.get("extracted_metadata", {})

            project_id = extracted_metadata.get("project_id") or filename_project_id

            requires_manual_review = (
                confidence < self.confidence_threshold or document_type == "other"
            )

            return SkillResult.ok(
                data={
                    "type": document_type,
                    "confidence": confidence,
                    "project_id": project_id,
                    "reasoning": reasoning,
                    "requires_manual_review": requires_manual_review,
                    "extracted_metadata": extracted_metadata,
                    "filename": filename,
                },
                model="rule_based_fallback",
                usage={"input_tokens": 0, "output_tokens": 0},
            )

        # Parse response
        parsed = self._parse_llm_response(response["content"])

        document_type = parsed.get("document_type", "other")
        confidence = float(parsed.get("confidence", 0.0))
        reasoning = parsed.get("reasoning", "")
        extracted_metadata = parsed.get("extracted_metadata", {})

        project_id = extracted_metadata.get("project_id") or filename_project_id

        requires_manual_review = (
            confidence < self.confidence_threshold or document_type == "other"
        )

        return SkillResult.ok(
            data={
                "type": document_type,
                "confidence": confidence,
                "project_id": project_id,
                "reasoning": reasoning,
                "requires_manual_review": requires_manual_review,
                "extracted_metadata": extracted_metadata,
                "filename": filename,
            },
            model=response["model"],
            usage=response["usage"],
        )

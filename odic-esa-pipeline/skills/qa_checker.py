"""
ODIC ESA Pipeline - QA Checker Skill

Validates assembled ESA reports using Kimi K2.5 AI (thinking mode for deep analysis).
- Checks completeness against esa_template.yaml required sections
- Verifies section ordering
- Confirms all required document types are present
- Detects cross-contamination from other projects/firms
- Returns pass/fail with specific missing items
- Failed QA goes to review queue, not to client
"""

from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field

import yaml
from PyPDF2 import PdfReader
import pdfplumber

from .base import BaseSkill, SkillResult
from core.llm_router import LLMRouter
from core.state import StateManager, ProjectStatus


@dataclass
class ContaminationIssue:
    """Represents a potential cross-contamination issue in the report."""
    document_name: str
    page_number: int
    issue_type: str  # "third_party_report", "wrong_project", "wrong_property"
    description: str
    severity: str  # "critical", "warning", "info"
    detected_firm: Optional[str] = None
    detected_project_id: Optional[str] = None
    ai_fixable: bool = False


@dataclass
class QAResult:
    """Result of QA validation."""
    passed: bool
    score: float  # 0.0 to 1.0
    issues: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    missing_sections: List[str] = field(default_factory=list)
    missing_documents: List[str] = field(default_factory=list)
    section_order_correct: bool = True
    recommendations: List[str] = field(default_factory=list)
    contamination_issues: List[ContaminationIssue] = field(default_factory=list)
    ai_analysis_performed: bool = False


class QAChecker(BaseSkill):
    """
    Validates assembled ESA reports for completeness and quality.

    Checks:
    - Required sections present
    - Required document types present (EDR, topo, site photos)
    - Section ordering matches template
    - Report structure and content quality (via Sonnet)
    """

    def __init__(
        self,
        config: dict,
        llm_router: Optional[LLMRouter] = None,
        state_manager: Optional[StateManager] = None
    ):
        """Initialize the QA checker."""
        super().__init__(config)

        self.llm_router = llm_router or LLMRouter(config)
        self.state_manager = state_manager

        # QA configuration
        qa_config = config.get("qa", {})
        self.minimum_sections = qa_config.get("minimum_sections_required", 8)
        self.require_site_photos = qa_config.get("require_site_photos", True)
        self.require_edr = qa_config.get("require_edr", True)
        self.require_topo = qa_config.get("require_topo", True)

        # Directories
        pipeline_config = config.get("pipeline", {})
        self.project_base_dir = Path(pipeline_config.get("project_base_dir", "./projects"))
        self.output_dir = Path(pipeline_config.get("output_dir", "./completed_reports"))
        self.review_dir = Path(pipeline_config.get("review_dir", "./qa_review"))
        self.review_dir.mkdir(parents=True, exist_ok=True)

        # Load ESA template
        self.esa_template = self._load_esa_template()

        # Document type to subfolder mapping
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

    def _get_required_sections(self) -> List[Dict[str, Any]]:
        """Get list of required sections from template."""
        sections = self.esa_template.get("phase1_esa", {}).get("sections", [])
        return [s for s in sections if s.get("required", False)]

    def _get_required_document_types(self) -> List[str]:
        """Get list of required document types."""
        required = []

        if self.require_edr:
            required.append("edr")
        if self.require_topo:
            required.append("topographic_map")
        if self.require_site_photos:
            required.append("site_photograph")

        # Also check template minimum requirements
        template_req = (
            self.esa_template.get("phase1_esa", {})
            .get("required_documents", {})
            .get("minimum", [])
        )
        for doc in template_req:
            if doc not in required:
                required.append(doc)

        return required

    def _check_project_documents(self, project_path: Path) -> Dict[str, List[Path]]:
        """Check what documents are present in project folder."""
        documents = {}

        for doc_type, subfolder in self.SUBFOLDER_MAP.items():
            folder_path = project_path / subfolder
            if folder_path.exists():
                pdfs = list(folder_path.glob("*.pdf"))
                if pdfs:
                    documents[doc_type] = pdfs

        return documents

    def _extract_report_text(self, report_path: Path, max_pages: int = 20) -> str:
        """Extract text from report PDF for analysis."""
        text_parts = []
        try:
            with pdfplumber.open(report_path) as pdf:
                for i, page in enumerate(pdf.pages[:max_pages]):
                    text = page.extract_text()
                    if text:
                        text_parts.append(f"[Page {i+1}]\n{text}")
        except Exception as e:
            self.logger.error(f"Failed to extract report text: {e}")
        return "\n\n".join(text_parts)

    def _get_report_page_count(self, report_path: Path) -> int:
        """Get total page count of report."""
        try:
            reader = PdfReader(str(report_path))
            return len(reader.pages)
        except Exception:
            return 0

    async def _analyze_with_llm(
        self,
        report_text: str,
        required_sections: List[str]
    ) -> Dict[str, Any]:
        """Use Sonnet to analyze report content quality."""
        prompt = f"""You are a QA reviewer for Phase I Environmental Site Assessment reports at ODIC Environmental.

Analyze the following report content and evaluate:
1. Are all major sections present? Required sections: {required_sections}
2. Does the report appear complete and professional?
3. Are there any obvious issues or missing content?
4. Is the section ordering logical?
5. Is there any cross-contamination (content from other projects/firms)?

Report content (first 20 pages):
---
{report_text[:15000]}
---

Respond with a JSON object:
{{
    "sections_found": ["list of section names found"],
    "missing_sections": ["list of missing required sections"],
    "quality_score": <float 0.0-1.0>,
    "issues": [
        {{
            "section": "section name or 'General'",
            "issue_type": "missing_content|cross_contamination|formatting|ordering",
            "description": "specific issue description",
            "severity": "critical|warning|info",
            "ai_fixable": true/false
        }}
    ],
    "warnings": ["list of warnings/suggestions"],
    "section_order_correct": <true/false>,
    "overall_assessment": "brief summary",
    "detected_firms": ["list of any non-ODIC firm names found in the content"],
    "detected_projects": ["list of any project IDs found that might indicate cross-contamination"]
}}

IMPORTANT CROSS-CONTAMINATION CHECKS:
- Look for ANY company names that are NOT "ODIC Environmental"
- Look for project IDs or reference numbers that don't match the expected format
- Look for addresses or property descriptions that seem inconsistent
- Third-party reports in appendices are EXPECTED, but flag them for awareness

Be thorough but fair in your assessment. Only flag genuine issues."""

        try:
            response = await self.llm_router.complete(
                task_type="qa_check",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=2000,
                temperature=0.2
            )

            # Parse response
            import json
            import re

            content = response["content"]
            # Try to extract JSON
            json_match = re.search(r"\{.*\}", content, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())

        except Exception as e:
            self.logger.error(f"LLM QA analysis failed: {e}")

        return {
            "sections_found": [],
            "missing_sections": [],
            "quality_score": 0.5,
            "issues": [{"section": "General", "issue_type": "analysis_error", "description": "LLM analysis unavailable", "severity": "warning", "ai_fixable": False}],
            "warnings": [],
            "section_order_correct": True,
            "overall_assessment": "Manual review recommended",
            "detected_firms": [],
            "detected_projects": []
        }

    async def _check_cross_contamination(
        self,
        project_path: Path,
        project_id: str,
        expected_address: Optional[str] = None
    ) -> List[ContaminationIssue]:
        """
        Check appendix documents for cross-contamination from other projects/firms.

        Extracts page 1 text from each appendix document and uses AI to detect:
        - Reports from firms other than ODIC Environmental
        - Wrong project IDs or reference numbers
        - Wrong property addresses

        Args:
            project_path: Path to the project folder
            project_id: Expected project ID for this report
            expected_address: Optional expected property address

        Returns:
            List of ContaminationIssue objects
        """
        contamination_issues = []

        # Define appendix subfolders to check
        appendix_folders = [
            "regulatory/edr",
            "regulatory/correspondence",
            "prior_reports",
            "historical/sanborn_maps",
            "historical/topo_maps",
            "historical/aerials",
        ]

        for subfolder in appendix_folders:
            folder_path = project_path / subfolder
            if not folder_path.exists():
                continue

            for pdf_file in folder_path.glob("*.pdf"):
                try:
                    # Extract first page text
                    first_page_text = self._extract_first_page(pdf_file)
                    if not first_page_text:
                        continue

                    # Use AI to analyze for contamination
                    analysis = await self._analyze_document_origin(
                        document_name=pdf_file.name,
                        document_text=first_page_text,
                        expected_project_id=project_id,
                        expected_address=expected_address
                    )

                    if analysis.get("has_issues"):
                        for issue in analysis.get("issues", []):
                            contamination_issues.append(ContaminationIssue(
                                document_name=pdf_file.name,
                                page_number=1,
                                issue_type=issue.get("type", "unknown"),
                                description=issue.get("description", ""),
                                severity=issue.get("severity", "warning"),
                                detected_firm=analysis.get("detected_firm"),
                                detected_project_id=analysis.get("detected_project_id"),
                                ai_fixable=issue.get("ai_fixable", False)
                            ))

                except Exception as e:
                    self.logger.warning(f"Failed to check {pdf_file.name} for contamination: {e}")

        return contamination_issues

    def _extract_first_page(self, pdf_path: Path) -> str:
        """Extract text from the first page of a PDF."""
        try:
            with pdfplumber.open(pdf_path) as pdf:
                if pdf.pages:
                    return pdf.pages[0].extract_text() or ""
        except Exception as e:
            self.logger.warning(f"Failed to extract first page from {pdf_path.name}: {e}")
        return ""

    async def _analyze_document_origin(
        self,
        document_name: str,
        document_text: str,
        expected_project_id: str,
        expected_address: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Use AI to analyze a document's first page to determine its origin.

        Args:
            document_name: Name of the document file
            document_text: Text content from first page
            expected_project_id: The project ID this should belong to
            expected_address: Optional expected property address

        Returns:
            Dict with analysis results including any contamination issues
        """
        prompt = f"""Analyze this document's first page to identify its origin and check for cross-contamination.

Document filename: {document_name}
Expected Project ID: {expected_project_id}
{"Expected Property Address: " + expected_address if expected_address else ""}

Document first page text:
---
{document_text[:5000]}
---

Determine:
1. What company/firm prepared this document?
2. What project ID or reference number is shown (if any)?
3. What property address is this for (if shown)?
4. Is this an ODIC Environmental document or a third-party document?

Respond with JSON:
{{
    "detected_firm": "company name found or null",
    "is_odic_document": true/false,
    "detected_project_id": "project ID found or null",
    "detected_address": "address found or null",
    "document_type": "phase1_esa|phase2_esa|edr|regulatory|historical|other",
    "has_issues": true/false,
    "issues": [
        {{
            "type": "third_party_report|wrong_project|wrong_property|unknown_origin",
            "description": "specific issue description",
            "severity": "critical|warning|info",
            "ai_fixable": false
        }}
    ]
}}

IMPORTANT:
- Third-party reports (EDR, historical research) are EXPECTED in appendices - mark as "info" severity
- Reports from OTHER environmental consulting firms should be marked as "warning"
- Wrong project IDs or addresses are "critical" as they indicate cross-contamination
- Only mark has_issues=true if there are actual concerns"""

        try:
            response = await self.llm_router.complete(
                task_type="qa_check",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=800,
                temperature=0.1
            )

            import json
            import re

            content = response["content"]
            json_match = re.search(r"\{.*\}", content, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())

        except Exception as e:
            self.logger.warning(f"Failed to analyze document origin: {e}")

        return {
            "detected_firm": None,
            "is_odic_document": False,
            "has_issues": False,
            "issues": []
        }

    def _check_document_completeness(
        self,
        project_path: Path
    ) -> Tuple[List[str], List[str]]:
        """Check if required documents are present."""
        present_docs = self._check_project_documents(project_path)
        required_types = self._get_required_document_types()

        present = list(present_docs.keys())
        missing = [t for t in required_types if t not in present]

        return present, missing

    def validate_input(self, input_data: Any) -> bool:
        """Validate input is a project ID or report path."""
        if isinstance(input_data, dict):
            return "project_id" in input_data or "report_path" in input_data
        if isinstance(input_data, str):
            # Could be project ID or path
            return True
        return False

    def get_model(self) -> str:
        """Return the model used for QA (Kimi K2.5 thinking mode)."""
        info = self.llm_router.get_model_info()
        return info.get("qa_check", "kimi-k2.5")

    async def process(self, input_data: Any) -> SkillResult:
        """
        Run QA checks on an assembled report.

        Args:
            input_data: Dict with project_id and/or report_path

        Returns:
            SkillResult with QA outcome
        """
        # Parse input
        if isinstance(input_data, str):
            project_id = input_data
            report_path = None
        elif isinstance(input_data, dict):
            project_id = input_data.get("project_id")
            report_path = input_data.get("report_path")
        else:
            return SkillResult.fail(
                error="Invalid input format",
                data={"input": str(input_data)}
            )

        # Find report if not provided
        project_path = self.project_base_dir / project_id if project_id else None

        if not report_path and project_path:
            # Look for report in project folder
            report_dir = project_path / "report"
            if report_dir.exists():
                reports = list(report_dir.glob("*.pdf"))
                if reports:
                    report_path = str(reports[0])

        if not report_path or not Path(report_path).exists():
            return SkillResult.fail(
                error="Report not found",
                data={"project_id": project_id, "report_path": report_path}
            )

        report_path = Path(report_path)
        self.logger.info(f"Running QA on report: {report_path.name}")

        # Initialize QA result
        qa_result = QAResult(passed=True, score=1.0)

        try:
            # 1. Check document completeness in project folder
            if project_path and project_path.exists():
                present_docs, missing_docs = self._check_document_completeness(project_path)
                qa_result.missing_documents = missing_docs

                if missing_docs:
                    qa_result.issues.append(
                        f"Missing required document types: {', '.join(missing_docs)}"
                    )
                    qa_result.score -= 0.2 * len(missing_docs)

            # 2. Check report exists and has content
            page_count = self._get_report_page_count(report_path)
            if page_count == 0:
                qa_result.passed = False
                qa_result.issues.append("Report PDF is empty or unreadable")
                qa_result.score = 0.0
            elif page_count < 10:
                qa_result.warnings.append(
                    f"Report has only {page_count} pages - may be incomplete"
                )
                qa_result.score -= 0.1

            # 3. Extract report text and analyze sections
            report_text = self._extract_report_text(report_path)
            required_sections = [s.get("name") for s in self._get_required_sections()]

            # 4. Check for required section keywords in text
            sections_found = []
            for section in required_sections:
                # Simple keyword check
                section_keywords = section.lower().split()
                if any(kw in report_text.lower() for kw in section_keywords if len(kw) > 3):
                    sections_found.append(section)
                else:
                    qa_result.missing_sections.append(section)

            if len(sections_found) < self.minimum_sections:
                qa_result.issues.append(
                    f"Only {len(sections_found)}/{self.minimum_sections} required sections found"
                )
                qa_result.score -= 0.3

            # 5. LLM-based quality analysis (if available)
            if self.llm_router.is_configured():
                qa_result.ai_analysis_performed = True
                llm_analysis = await self._analyze_with_llm(report_text, required_sections)

                # Incorporate LLM findings - handle both old list format and new dict format
                llm_issues = llm_analysis.get("issues", [])
                for issue in llm_issues:
                    if isinstance(issue, str):
                        qa_result.issues.append(issue)
                    elif isinstance(issue, dict):
                        issue_desc = f"[{issue.get('severity', 'info').upper()}] {issue.get('section', 'General')}: {issue.get('description', '')}"
                        if issue.get('severity') == 'critical':
                            qa_result.issues.append(issue_desc)
                        else:
                            qa_result.warnings.append(issue_desc)

                qa_result.warnings.extend(llm_analysis.get("warnings", []))
                qa_result.section_order_correct = llm_analysis.get("section_order_correct", True)

                # Blend scores
                llm_score = llm_analysis.get("quality_score", 0.5)
                qa_result.score = (qa_result.score + llm_score) / 2

                # Update missing sections with LLM findings
                llm_missing = llm_analysis.get("missing_sections", [])
                for section in llm_missing:
                    if section not in qa_result.missing_sections:
                        qa_result.missing_sections.append(section)

                # Check for detected third-party firms
                detected_firms = llm_analysis.get("detected_firms", [])
                if detected_firms:
                    qa_result.warnings.append(
                        f"Third-party firm content detected: {', '.join(detected_firms)}"
                    )

            # 5b. Cross-contamination check for appendix documents
            if self.llm_router.is_configured() and project_path and project_path.exists():
                contamination_issues = await self._check_cross_contamination(
                    project_path=project_path,
                    project_id=project_id
                )
                qa_result.contamination_issues = contamination_issues

                # Add critical contamination issues to main issues list
                for ci in contamination_issues:
                    if ci.severity == "critical":
                        qa_result.issues.append(
                            f"CONTAMINATION: {ci.document_name} - {ci.description}"
                        )
                        qa_result.score -= 0.15
                    elif ci.severity == "warning":
                        qa_result.warnings.append(
                            f"Potential contamination in {ci.document_name}: {ci.description}"
                        )

            # 6. Determine pass/fail
            qa_result.passed = (
                qa_result.score >= 0.7 and
                len(qa_result.missing_documents) == 0 and
                len(qa_result.issues) <= 2
            )

            # 7. Generate recommendations
            if qa_result.missing_documents:
                qa_result.recommendations.append(
                    f"Add missing documents: {', '.join(qa_result.missing_documents)}"
                )
            if qa_result.missing_sections:
                qa_result.recommendations.append(
                    f"Review missing sections: {', '.join(qa_result.missing_sections[:5])}"
                )
            if not qa_result.section_order_correct:
                qa_result.recommendations.append(
                    "Review section ordering against ESA template"
                )

            # 8. Update state and handle outcome
            if self.state_manager and project_id:
                if qa_result.passed:
                    self.state_manager.set_project_status(project_id, ProjectStatus.COMPLETE)
                    self.state_manager.set_project_report_path(project_id, str(report_path))
                else:
                    self.state_manager.set_project_status(project_id, ProjectStatus.FAILED)

            # 9. Move to review queue if failed
            if not qa_result.passed:
                self._move_to_review(report_path, project_id, qa_result)

            return SkillResult.ok(
                data={
                    "passed": qa_result.passed,
                    "score": round(qa_result.score, 2),
                    "issues": qa_result.issues,
                    "warnings": qa_result.warnings,
                    "missing_sections": qa_result.missing_sections,
                    "missing_documents": qa_result.missing_documents,
                    "section_order_correct": qa_result.section_order_correct,
                    "recommendations": qa_result.recommendations,
                    "contamination_issues": [
                        {
                            "document": ci.document_name,
                            "page": ci.page_number,
                            "type": ci.issue_type,
                            "description": ci.description,
                            "severity": ci.severity,
                            "detected_firm": ci.detected_firm,
                            "detected_project_id": ci.detected_project_id,
                            "ai_fixable": ci.ai_fixable
                        }
                        for ci in qa_result.contamination_issues
                    ],
                    "ai_analysis_performed": qa_result.ai_analysis_performed,
                    "project_id": project_id,
                    "report_path": str(report_path),
                    "page_count": page_count,
                },
                model=self.get_model() if self.llm_router.is_configured() else None
            )

        except Exception as e:
            self.logger.exception(f"QA check failed: {e}")
            return SkillResult.fail(
                error=f"QA check failed: {str(e)}",
                data={"project_id": project_id, "report_path": str(report_path)}
            )

    def _move_to_review(
        self,
        report_path: Path,
        project_id: Optional[str],
        qa_result: QAResult
    ):
        """Move failed report to review queue with QA notes."""
        import shutil
        import json

        try:
            # Create review folder for this report
            review_folder = self.review_dir / (project_id or report_path.stem)
            review_folder.mkdir(parents=True, exist_ok=True)

            # Copy report
            review_report = review_folder / report_path.name
            shutil.copy2(report_path, review_report)

            # Write QA notes
            notes_path = review_folder / "qa_notes.json"
            with open(notes_path, "w") as f:
                json.dump({
                    "project_id": project_id,
                    "original_path": str(report_path),
                    "qa_date": datetime.utcnow().isoformat(),
                    "passed": qa_result.passed,
                    "score": qa_result.score,
                    "issues": qa_result.issues,
                    "warnings": qa_result.warnings,
                    "missing_sections": qa_result.missing_sections,
                    "missing_documents": qa_result.missing_documents,
                    "recommendations": qa_result.recommendations,
                }, f, indent=2)

            self.logger.info(f"Report moved to review queue: {review_folder}")

        except Exception as e:
            self.logger.error(f"Failed to move report to review: {e}")

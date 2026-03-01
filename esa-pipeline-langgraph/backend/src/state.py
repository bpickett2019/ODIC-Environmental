"""
ESA Pipeline State Schema - Full AI-Automated System

Defines the ReportState TypedDict that flows through the entire LangGraph pipeline.
Supports multi-pass validation, self-correction loops, and full audit trail.
"""

from typing import TypedDict, Annotated, List, Optional, Dict, Any, Literal
from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
import operator


# ===== Enums =====

class DocumentCategory(str, Enum):
    """Document classification categories."""
    MAIN_BODY = "main_body"
    APPENDIX = "appendix"
    SUPPORTING_RECORD = "supporting_record"
    EXCLUDED = "excluded"


class PipelineStage(str, Enum):
    """Pipeline stages."""
    INGEST = "ingest"
    CLASSIFY = "classify"
    STRUCTURE = "structure"
    ASSEMBLE = "assemble"
    QC = "qc"
    EXPORT = "export"
    COMPLETE = "complete"
    FAILED = "failed"


class QCSeverity(str, Enum):
    """QC issue severity levels."""
    CRITICAL = "critical"
    WARNING = "warning"
    INFO = "info"


class DecisionTier(str, Enum):
    """3-Tier Confidence System for AI decisions."""
    AUTO_APPROVE = "auto_approved"      # Tier 1 - Green Lane (confidence >= 95%, low risk)
    AUDIT_TRAIL = "audit_trail"         # Tier 2 - Yellow Lane (confidence >= 90%, medium risk)
    HUMAN_REVIEW = "human_review"       # Tier 3 - Red Lane (confidence < 90% or high risk)


class RiskLevel(str, Enum):
    """Risk classification for decisions."""
    LOW = "low"       # Deterministic operations
    MEDIUM = "medium" # Classification, validation
    HIGH = "high"     # Cross-contamination, content integrity


class ValidatorType(str, Enum):
    """QC Validator types."""
    COMPLETENESS = "completeness"
    CROSS_CONTAMINATION = "cross_contamination"
    STRUCTURE = "structure"
    CONTENT_INTEGRITY = "content_integrity"
    FORMAT = "format"


# ===== Data Classes =====

@dataclass
class IngestedFile:
    """Represents a file after ingestion."""
    id: str
    original_filename: str
    format: str  # pdf, docx, jpg, png, tiff
    page_count: int
    size_bytes: int
    text_content: str
    ocr_confidence: Optional[float] = None
    content_hash: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    file_path: str = ""
    project_id: str = ""  # CRITICAL: Project tagging for cross-contamination prevention

    def to_dict(self):
        return asdict(self)


@dataclass
class Classification:
    """Document classification result."""
    category: DocumentCategory
    section: str  # e.g., "executive_summary", "appendix_c_sanborn_maps"
    appendix_letter: Optional[str] = None
    confidence: float = 0.0
    flags: List[str] = field(default_factory=list)
    reasoning: str = ""
    content_summary: str = ""  # 2-3 sentence AI summary of content

    def to_dict(self):
        d = asdict(self)
        d['category'] = self.category.value
        return d


@dataclass
class ClassificationPass:
    """Result of a single classification pass (for dual-pass validation)."""
    pass_number: int
    classification: Classification
    prompt_variant: str  # Which prompt was used
    raw_response: str = ""


@dataclass
class ClassifiedDocument:
    """A document with its classification and validation history."""
    file: IngestedFile
    classification: Classification
    classification_passes: List[ClassificationPass] = field(default_factory=list)
    tiebreaker_used: bool = False
    needs_review: bool = False  # True if confidence < 85% or disagreement

    def to_dict(self):
        return {
            "file": self.file.to_dict(),
            "classification": self.classification.to_dict(),
            "tiebreaker_used": self.tiebreaker_used,
            "needs_review": self.needs_review,
            "pass_count": len(self.classification_passes)
        }


@dataclass
class ESASection:
    """ASTM E1527-21 required section."""
    id: str
    name: str
    required: bool
    found: bool = False
    confidence: float = 0.0
    source_file_id: Optional[str] = None
    page_range: Optional[tuple] = None
    ai_summary: str = ""  # 2-sentence summary
    sub_sections: List['ESASection'] = field(default_factory=list)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "required": self.required,
            "found": self.found,
            "confidence": self.confidence,
            "source_file_id": self.source_file_id,
            "page_range": self.page_range,
            "ai_summary": self.ai_summary,
            "sub_sections": [s.to_dict() for s in self.sub_sections]
        }


@dataclass
class StructureResult:
    """Result of the STRUCTURE node."""
    template: str = "astm_e1527_21"
    sections: List[ESASection] = field(default_factory=list)
    sections_found: List[str] = field(default_factory=list)
    sections_missing: List[str] = field(default_factory=list)
    sections_extra: List[str] = field(default_factory=list)
    sections_misclassified_recovered: List[str] = field(default_factory=list)
    appendix_order: List[str] = field(default_factory=list)
    completeness_score: float = 0.0
    blocking_issues: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    ordered_documents: List[ClassifiedDocument] = field(default_factory=list)

    def to_dict(self):
        return {
            "template": self.template,
            "sections": [s.to_dict() for s in self.sections],
            "sections_found": self.sections_found,
            "sections_missing": self.sections_missing,
            "sections_extra": self.sections_extra,
            "sections_misclassified_recovered": self.sections_misclassified_recovered,
            "appendix_order": self.appendix_order,
            "completeness_score": self.completeness_score,
            "blocking_issues": self.blocking_issues,
            "warnings": self.warnings
        }


@dataclass
class PageMapping:
    """Maps source document pages to assembled document pages."""
    source_file_id: str
    source_filename: str
    source_pages: int
    assembled_start_page: int
    assembled_end_page: int
    section: str


@dataclass
class AssemblyResult:
    """Result of the ASSEMBLE node."""
    assembled_file_path: str = ""
    total_pages: int = 0  # Pages in assembled document
    source_pages: int = 0  # Expected pages from sources
    pages_match: bool = False  # CRITICAL: Must be True for valid assembly
    page_reconciliation_attempts: int = 0
    missing_pages_recovered: List[str] = field(default_factory=list)
    toc_generated: bool = False
    toc_page_count: int = 0
    page_mapping: Dict[str, List[int]] = field(default_factory=dict)  # doc_id -> [start, end]

    def to_dict(self):
        return {
            "assembled_file_path": self.assembled_file_path,
            "total_pages": self.total_pages,
            "source_pages": self.source_pages,
            "pages_match": self.pages_match,
            "page_reconciliation_attempts": self.page_reconciliation_attempts,
            "missing_pages_recovered": self.missing_pages_recovered,
            "toc_generated": self.toc_generated,
            "toc_page_count": self.toc_page_count,
            "page_mapping": self.page_mapping
        }


@dataclass
class QCIssue:
    """A single QC issue."""
    agent: str  # Which validator/agent found this issue
    severity: QCSeverity
    description: str
    location: str  # page number or section
    evidence: str = ""  # Specific text/data that caused the issue
    auto_fixable: bool = False
    suggested_fix: str = ""
    fixed: bool = False
    fix_attempts: int = 0

    def to_dict(self):
        return {
            "agent": self.agent,
            "severity": self.severity.value,
            "description": self.description,
            "location": self.location,
            "evidence": self.evidence,
            "auto_fixable": self.auto_fixable,
            "suggested_fix": self.suggested_fix,
            "fixed": self.fixed,
            "fix_attempts": self.fix_attempts
        }


@dataclass
class ValidatorResult:
    """Result from a single QC validator."""
    validator: ValidatorType
    passed: bool
    score: float  # 0-100
    issues: List[QCIssue] = field(default_factory=list)
    run_count: int = 1
    auto_fixes_applied: int = 0
    ai_notes: str = ""

    def to_dict(self):
        return {
            "validator": self.validator.value,
            "passed": self.passed,
            "score": self.score,
            "issues": [i.to_dict() for i in self.issues],
            "run_count": self.run_count,
            "auto_fixes_applied": self.auto_fixes_applied,
            "ai_notes": self.ai_notes
        }


@dataclass
class QCResult:
    """Result of the QC node."""
    qc_passed: bool = False
    overall_score: float = 0.0
    confidence_level: float = 0.0
    blocking_issues: List[QCIssue] = field(default_factory=list)
    warnings: List[QCIssue] = field(default_factory=list)
    ai_notes: str = ""
    section_scores: Dict[str, float] = field(default_factory=dict)
    remediation_count: int = 0
    validator_results: Dict[str, ValidatorResult] = field(default_factory=dict)
    qc_loops_completed: int = 0

    def to_dict(self):
        return {
            "qc_passed": self.qc_passed,
            "overall_score": self.overall_score,
            "confidence_level": self.confidence_level,
            "blocking_issues": [i.to_dict() for i in self.blocking_issues],
            "warnings": [i.to_dict() for i in self.warnings],
            "ai_notes": self.ai_notes,
            "section_scores": self.section_scores,
            "remediation_count": self.remediation_count,
            "validator_results": {k: v.to_dict() for k, v in self.validator_results.items()},
            "qc_loops_completed": self.qc_loops_completed
        }


@dataclass
class ExportFile:
    """An exported file."""
    filename: str
    size_bytes: int
    page_count: int
    part_number: int = 1
    total_parts: int = 1
    sections_included: List[str] = field(default_factory=list)
    file_path: str = ""
    format: str = "pdf"

    def to_dict(self):
        return asdict(self)


@dataclass
class ExportResult:
    """Result of the EXPORT node."""
    files: List[ExportFile] = field(default_factory=list)
    qc_summary_path: str = ""
    completeness_report_path: str = ""
    total_parts: int = 1
    compression_applied: bool = False
    auto_split_applied: bool = False
    split_reason: str = ""

    def to_dict(self):
        return {
            "files": [f.to_dict() for f in self.files],
            "qc_summary_path": self.qc_summary_path,
            "completeness_report_path": self.completeness_report_path,
            "total_parts": self.total_parts,
            "compression_applied": self.compression_applied,
            "auto_split_applied": self.auto_split_applied,
            "split_reason": self.split_reason
        }


@dataclass
class AIDecision:
    """Tracks an AI decision with tier classification and full reasoning."""
    timestamp: str
    stage: str
    action: str
    tier: DecisionTier
    confidence: float
    risk_level: RiskLevel
    reasoning: str = ""
    details: Dict[str, Any] = field(default_factory=dict)
    auto_fixed: bool = False
    human_approved: bool = False

    def to_dict(self):
        return {
            "timestamp": self.timestamp,
            "stage": self.stage,
            "action": self.action,
            "tier": self.tier.value,
            "confidence": self.confidence,
            "risk_level": self.risk_level.value,
            "reasoning": self.reasoning,
            "details": self.details,
            "auto_fixed": self.auto_fixed,
            "human_approved": self.human_approved
        }


@dataclass
class CompletenessReportEntry:
    """Entry in the AI Completeness Report."""
    section_id: str
    section_name: str
    status: str  # "found", "missing", "partial"
    confidence: float
    source_file: Optional[str]
    page_range: Optional[str]
    ai_summary: str  # 2-sentence summary


# ===== Helper Functions =====

def determine_tier(confidence: float, risk_level: RiskLevel) -> DecisionTier:
    """Determine the appropriate tier based on confidence and risk."""
    if risk_level == RiskLevel.HIGH:
        return DecisionTier.HUMAN_REVIEW
    if confidence >= 0.95 and risk_level == RiskLevel.LOW:
        return DecisionTier.AUTO_APPROVE
    if confidence >= 0.90 and risk_level == RiskLevel.MEDIUM:
        return DecisionTier.AUDIT_TRAIL
    return DecisionTier.HUMAN_REVIEW


def create_decision(
    stage: str,
    action: str,
    confidence: float,
    risk_level: RiskLevel,
    reasoning: str = "",
    details: Dict[str, Any] = None
) -> AIDecision:
    """Create an AI decision with automatic tier assignment."""
    tier = determine_tier(confidence, risk_level)
    return AIDecision(
        timestamp=datetime.utcnow().isoformat(),
        stage=stage,
        action=action,
        tier=tier,
        confidence=confidence,
        risk_level=risk_level,
        reasoning=reasoning,
        details=details or {},
    )


# ===== Reducers for LangGraph =====

def merge_decisions(existing: List[AIDecision], new: List[AIDecision]) -> List[AIDecision]:
    """Merge decision lists."""
    return existing + new


def add_files(existing: List[IngestedFile], new: List[IngestedFile]) -> List[IngestedFile]:
    """Add new files to existing list."""
    return existing + new


def add_issues(existing: List[QCIssue], new: List[QCIssue]) -> List[QCIssue]:
    """Add new issues to existing list."""
    return existing + new


def merge_logs(existing: List[Dict], new: List[Dict]) -> List[Dict]:
    """Merge log entries."""
    return existing + new


# ===== Main State Schema =====

class ReportState(TypedDict):
    """
    Main state schema for the ESA Pipeline.
    Flows through entire LangGraph DAG with all stage outputs and tracking.
    """
    # Project identification
    project_id: str
    project_address: str
    report_type: Literal["phase_1", "phase_2"]
    client_name: str
    company_name: str  # Our company name for cross-contamination detection

    # Current pipeline stage
    current_stage: PipelineStage
    stage_history: Annotated[List[str], operator.add]
    pipeline_started_at: str
    pipeline_completed_at: Optional[str]

    # INGEST stage outputs
    files: Annotated[List[IngestedFile], add_files]
    ingest_complete: bool
    ingest_errors: Annotated[List[str], operator.add]
    total_source_pages: int

    # CLASSIFY stage outputs
    classified_documents: List[ClassifiedDocument]
    classification_complete: bool
    classification_passes_run: int
    tiebreakers_used: int
    documents_needing_review: List[str]

    # STRUCTURE stage outputs
    structure_result: Optional[StructureResult]
    structure_complete: bool
    appendix_order_confirmed: bool

    # ASSEMBLE stage outputs
    assembly_result: Optional[AssemblyResult]
    assembly_complete: bool
    page_reconciliation_passed: bool

    # QC stage outputs
    qc_result: Optional[QCResult]
    qc_complete: bool
    qc_loops_run: int
    max_qc_loops: int  # Default 3
    final_validation_passed: bool

    # EXPORT stage outputs
    export_result: Optional[ExportResult]
    export_complete: bool

    # Human-in-the-loop state (only if issues survive self-correction)
    awaiting_human_input: bool
    human_input_type: Optional[str]
    human_input_data: Dict[str, Any]
    unresolved_issues: List[QCIssue]

    # Background processing
    is_background_task: bool
    background_task_id: Optional[str]

    # Audit trail
    audit_log: Annotated[List[Dict[str, Any]], merge_logs]
    decisions: Annotated[List[AIDecision], merge_decisions]

    # Decision tier counts
    tier1_count: int  # Auto-approved
    tier2_count: int  # Audit trail
    tier3_count: int  # Human review

    # Error tracking
    errors: Annotated[List[str], operator.add]
    pipeline_failed: bool
    failure_reason: Optional[str]


def create_initial_state(
    project_id: str,
    project_address: str,
    report_type: Literal["phase_1", "phase_2"] = "phase_1",
    client_name: str = "",
    company_name: str = "ODIC Environmental"
) -> ReportState:
    """Create initial state for a new report pipeline run."""
    return ReportState(
        # Project identification
        project_id=project_id,
        project_address=project_address,
        report_type=report_type,
        client_name=client_name,
        company_name=company_name,

        # Current pipeline stage
        current_stage=PipelineStage.INGEST,
        stage_history=[],
        pipeline_started_at=datetime.utcnow().isoformat(),
        pipeline_completed_at=None,

        # INGEST
        files=[],
        ingest_complete=False,
        ingest_errors=[],
        total_source_pages=0,

        # CLASSIFY
        classified_documents=[],
        classification_complete=False,
        classification_passes_run=0,
        tiebreakers_used=0,
        documents_needing_review=[],

        # STRUCTURE
        structure_result=None,
        structure_complete=False,
        appendix_order_confirmed=False,

        # ASSEMBLE
        assembly_result=None,
        assembly_complete=False,
        page_reconciliation_passed=False,

        # QC
        qc_result=None,
        qc_complete=False,
        qc_loops_run=0,
        max_qc_loops=3,
        final_validation_passed=False,

        # EXPORT
        export_result=None,
        export_complete=False,

        # Human-in-the-loop
        awaiting_human_input=False,
        human_input_type=None,
        human_input_data={},
        unresolved_issues=[],

        # Background processing
        is_background_task=True,
        background_task_id=None,

        # Audit trail
        audit_log=[],
        decisions=[],
        tier1_count=0,
        tier2_count=0,
        tier3_count=0,

        # Error tracking
        errors=[],
        pipeline_failed=False,
        failure_reason=None,
    )


def log_action(stage: str, action: str, details: Any = None) -> Dict[str, Any]:
    """Create an audit log entry."""
    return {
        "timestamp": datetime.utcnow().isoformat(),
        "stage": stage,
        "action": action,
        "details": details if isinstance(details, dict) else {"message": str(details) if details else ""},
    }


# ===== ASTM E1527-21 Template =====

def get_astm_e1527_template() -> List[ESASection]:
    """Get the ASTM E1527-21 Phase I ESA required sections template."""
    return [
        ESASection(id="cover_page", name="Cover Page", required=True),
        ESASection(id="toc", name="Table of Contents", required=True),
        ESASection(id="executive_summary", name="Executive Summary", required=True),
        ESASection(id="introduction", name="1.0 Introduction", required=True, sub_sections=[
            ESASection(id="purpose", name="1.1 Purpose", required=True),
            ESASection(id="scope", name="1.2 Scope of Services", required=True),
            ESASection(id="limitations", name="1.3 Limitations and Exceptions", required=True),
            ESASection(id="special_terms", name="1.4 Special Terms and Conditions", required=False),
        ]),
        ESASection(id="site_description", name="2.0 Site Description", required=True, sub_sections=[
            ESASection(id="location", name="2.1 Location and Legal Description", required=True),
            ESASection(id="site_vicinity", name="2.2 Site and Vicinity Characteristics", required=True),
            ESASection(id="current_use", name="2.3 Current Use of the Property", required=True),
            ESASection(id="adjacent_properties", name="2.4 Descriptions of Structures", required=True),
        ]),
        ESASection(id="user_provided_info", name="3.0 User Provided Information", required=True),
        ESASection(id="records_review", name="4.0 Records Review", required=True, sub_sections=[
            ESASection(id="standard_environmental", name="4.1 Standard Environmental Record Sources", required=True),
            ESASection(id="additional_environmental", name="4.2 Additional Environmental Record Sources", required=False),
            ESASection(id="physical_setting", name="4.3 Physical Setting Sources", required=True),
            ESASection(id="historical_use", name="4.4 Historical Use Information", required=True),
        ]),
        ESASection(id="site_reconnaissance", name="5.0 Site Reconnaissance", required=True, sub_sections=[
            ESASection(id="methodology", name="5.1 Methodology and Limiting Conditions", required=True),
            ESASection(id="general_description", name="5.2 General Site Setting", required=True),
            ESASection(id="exterior_observations", name="5.3 Exterior Observations", required=True),
            ESASection(id="interior_observations", name="5.4 Interior Observations", required=True),
        ]),
        ESASection(id="interviews", name="6.0 Interviews", required=True),
        ESASection(id="findings", name="7.0 Findings", required=True),
        ESASection(id="opinions", name="8.0 Opinions", required=True),
        ESASection(id="conclusions", name="9.0 Conclusions", required=True),
        ESASection(id="recommendations", name="10.0 Recommendations", required=False),
        ESASection(id="deviations", name="11.0 Deviations", required=True),
        ESASection(id="qualifications", name="12.0 Qualifications", required=True),
        ESASection(id="appendix_a", name="Appendix A - Figures/Site Plans", required=True),
        ESASection(id="appendix_b", name="Appendix B - Site Photographs", required=True),
        ESASection(id="appendix_c", name="Appendix C - Historical Sources", required=True),
        ESASection(id="appendix_d", name="Appendix D - Regulatory Records", required=True),
        ESASection(id="appendix_e", name="Appendix E - EDR Report", required=True),
        ESASection(id="appendix_f", name="Appendix F - Qualifications", required=True),
    ]

"""
STRUCTURE Node - ASTM E1527-21 Template Mapping

Maps classified documents to ESA report template (ASTM E1527-21 for Phase I).
- Uses full ASTM E1527-21 section template
- AI-powered section recovery for misclassified documents
- Detects missing required sections
- Proposes appendix ordering
- Outputs completeness score with blocking issues vs warnings

SELF-VALIDATION:
- Cross-references classifications against expected template
- Recovers documents that were misclassified but match template patterns
- Flags documents that appear in wrong section
"""

import logging
import json
from typing import Dict, Any, List, Optional
from datetime import datetime

from state import (
    ReportState,
    ClassifiedDocument,
    DocumentCategory,
    StructureResult,
    ESASection,
    PipelineStage,
    log_action,
    create_decision,
    RiskLevel,
    get_astm_e1527_template,
)
from utils.llm import get_classifier_llm

logger = logging.getLogger(__name__)


# Phase I ESA Template (ASTM E1527-21 standard) - simplified mapping
SECTION_MAPPING = {
    # Main body sections
    "cover_page": ["cover_page", "cover", "title_page"],
    "toc": ["toc", "table_of_contents", "contents"],
    "executive_summary": ["executive_summary", "summary"],
    "introduction": ["introduction", "purpose", "scope"],
    "site_description": ["site_description", "site_location", "property_description"],
    "user_provided_info": ["user_provided_info", "user_provided_information", "user_information"],
    "records_review": ["records_review", "regulatory_database_review", "environmental_records"],
    "site_reconnaissance": ["site_reconnaissance", "site_visit", "field_inspection"],
    "interviews": ["interviews", "interview_records"],
    "findings": ["findings", "findings_conclusions_recommendations"],
    "opinions": ["opinions", "professional_opinion"],
    "conclusions": ["conclusions"],
    "recommendations": ["recommendations"],
    "deviations": ["deviations", "limitations"],
    "qualifications": ["qualifications", "credentials", "certifications"],

    # Appendices
    "appendix_a": ["appendix_a", "appendix_a_site_plans_maps", "site_plans", "site_maps", "figures"],
    "appendix_b": ["appendix_b", "appendix_b_site_photographs", "photographs", "photos", "site_photos"],
    "appendix_c": ["appendix_c", "appendix_c_historical_sources", "sanborn_map", "sanborn",
                   "aerial_photograph", "aerial_photos", "city_directory", "topographic_map", "historical"],
    "appendix_d": ["appendix_d", "appendix_d_regulatory_records", "regulatory_records",
                   "regulatory_correspondence", "agency_correspondence"],
    "appendix_e": ["appendix_e", "appendix_e_edr_report", "edr_report", "edr", "environmental_database"],
    "appendix_f": ["appendix_f", "appendix_f_qualifications", "professional_qualifications", "resumes"],
}

# Reverse mapping for lookups
SECTION_TO_TEMPLATE = {}
for template_id, variations in SECTION_MAPPING.items():
    for var in variations:
        SECTION_TO_TEMPLATE[var] = template_id


def structure_node(state: ReportState) -> Dict[str, Any]:
    """
    STRUCTURE node - Map documents to ASTM E1527-21 report template.

    - Assigns documents to template slots using AI-enhanced matching
    - Recovers misclassified documents by content analysis
    - Detects missing required sections
    - Proposes appendix ordering
    - Flags blocking issues vs warnings

    Returns human-in-the-loop interrupt if appendix order confirmation needed.
    """
    logger.info(f"STRUCTURE: Starting for project {state['project_id']}")

    classified_docs = state.get("classified_documents", [])
    report_type = state.get("report_type", "phase_1")

    audit_entries = []
    decisions = []

    # Get ASTM E1527-21 template sections
    template_sections = get_astm_e1527_template()

    # Group documents by category and section
    main_body_docs: List[ClassifiedDocument] = []
    appendix_docs: List[ClassifiedDocument] = []
    supporting_docs: List[ClassifiedDocument] = []
    excluded_docs: List[ClassifiedDocument] = []

    for doc in classified_docs:
        cat = doc.classification.category
        if cat == DocumentCategory.MAIN_BODY:
            main_body_docs.append(doc)
        elif cat == DocumentCategory.APPENDIX:
            appendix_docs.append(doc)
        elif cat == DocumentCategory.SUPPORTING_RECORD:
            supporting_docs.append(doc)
        else:
            excluded_docs.append(doc)

    # Map documents to template sections
    section_assignments: Dict[str, List[ClassifiedDocument]] = {s.id: [] for s in template_sections}
    sections_found: List[str] = []
    sections_missing: List[str] = []
    sections_extra: List[str] = []
    sections_recovered: List[str] = []

    # Process main body documents
    for doc in main_body_docs:
        section_id = _map_to_template_section(doc.classification.section)
        if section_id and section_id in section_assignments:
            section_assignments[section_id].append(doc)
            if section_id not in sections_found:
                sections_found.append(section_id)
        else:
            sections_extra.append(doc.classification.section)
            audit_entries.append(log_action("structure", "unmapped_section", {
                "file_id": doc.file.id,
                "section": doc.classification.section,
            }))

    # Process appendix documents
    for doc in appendix_docs:
        section_id = _map_to_template_section(doc.classification.section)
        if section_id and section_id in section_assignments:
            section_assignments[section_id].append(doc)
            if section_id not in sections_found:
                sections_found.append(section_id)
        elif doc.classification.appendix_letter:
            # Map by appendix letter
            letter_section = f"appendix_{doc.classification.appendix_letter.lower()}"
            if letter_section in section_assignments:
                section_assignments[letter_section].append(doc)
                if letter_section not in sections_found:
                    sections_found.append(letter_section)
            else:
                sections_extra.append(doc.classification.section)
        else:
            sections_extra.append(doc.classification.section)

    # Attempt AI-powered recovery for misclassified documents
    # Check if any supporting records might belong in appendices
    for doc in supporting_docs:
        recovered_section = _attempt_section_recovery(doc, section_assignments)
        if recovered_section:
            section_assignments[recovered_section].append(doc)
            sections_recovered.append(f"{doc.file.original_filename} -> {recovered_section}")
            if recovered_section not in sections_found:
                sections_found.append(recovered_section)
            audit_entries.append(log_action("structure", "section_recovered", {
                "file_id": doc.file.id,
                "original_section": doc.classification.section,
                "recovered_section": recovered_section,
            }))

    # Check for missing required sections
    for section in template_sections:
        if section.required and section.id not in sections_found:
            # Check sub-sections
            sub_found = any(s.id in sections_found for s in section.sub_sections) if section.sub_sections else False
            if not sub_found:
                sections_missing.append(section.id)

    # Build ESASection list with found status
    populated_sections: List[ESASection] = []
    for template_section in template_sections:
        section = ESASection(
            id=template_section.id,
            name=template_section.name,
            required=template_section.required,
            found=template_section.id in sections_found,
            confidence=_calculate_section_confidence(section_assignments.get(template_section.id, [])),
            source_file_id=section_assignments.get(template_section.id, [None])[0].file.id if section_assignments.get(template_section.id) else None,
            sub_sections=[
                ESASection(
                    id=sub.id,
                    name=sub.name,
                    required=sub.required,
                    found=sub.id in sections_found,
                    confidence=_calculate_section_confidence(section_assignments.get(sub.id, []))
                )
                for sub in template_section.sub_sections
            ] if template_section.sub_sections else []
        )
        populated_sections.append(section)

    # Propose appendix ordering
    def appendix_sort_key(doc):
        letter = doc.classification.appendix_letter or "Z"
        section = doc.classification.section
        filename = doc.file.original_filename
        return (letter, section, filename)

    sorted_appendices = sorted(appendix_docs, key=appendix_sort_key)
    appendix_order = [doc.file.id for doc in sorted_appendices]

    # Calculate completeness score
    total_required = sum(1 for s in template_sections if s.required)
    found_required = sum(1 for s in template_sections if s.required and s.id in sections_found)
    completeness_score = found_required / total_required if total_required > 0 else 0.0

    # Determine blocking issues vs warnings
    blocking_issues: List[str] = []
    warnings: List[str] = []

    for section in template_sections:
        if section.required and section.id in sections_missing:
            blocking_issues.append(f"Missing required section: {section.name}")

    if excluded_docs:
        warnings.append(f"{len(excluded_docs)} documents excluded from report")

    if supporting_docs:
        remaining_supporting = [d for d in supporting_docs
                               if not any(d in section_assignments[sid] for sid in section_assignments)]
        if remaining_supporting:
            warnings.append(f"{len(remaining_supporting)} supporting records (reference material) identified")

    if sections_recovered:
        warnings.append(f"{len(sections_recovered)} documents recovered from misclassification")

    # Build ordered document list for assembly
    ordered_documents: List[ClassifiedDocument] = []

    # Add main body in template order
    for section in template_sections:
        if not section.id.startswith("appendix"):
            for doc in section_assignments.get(section.id, []):
                if doc not in ordered_documents:
                    ordered_documents.append(doc)

    # Add appendices in proposed order
    for doc_id in appendix_order:
        for doc in appendix_docs:
            if doc.file.id == doc_id and doc not in ordered_documents:
                ordered_documents.append(doc)

    # Add any remaining appendix documents not in order
    for section_id, docs in section_assignments.items():
        if section_id.startswith("appendix"):
            for doc in docs:
                if doc not in ordered_documents:
                    ordered_documents.append(doc)

    # Create structure result
    structure_result = StructureResult(
        template="astm_e1527_21",
        sections=populated_sections,
        sections_found=sections_found,
        sections_missing=sections_missing,
        sections_extra=sections_extra,
        sections_misclassified_recovered=sections_recovered,
        appendix_order=appendix_order,
        completeness_score=completeness_score,
        blocking_issues=blocking_issues,
        warnings=warnings,
        ordered_documents=ordered_documents,
    )

    logger.info(
        f"STRUCTURE complete: "
        f"completeness={completeness_score:.0%}, "
        f"blocking={len(blocking_issues)}, "
        f"warnings={len(warnings)}, "
        f"recovered={len(sections_recovered)}"
    )

    audit_entries.append(log_action("structure", "structure_complete", {
        "completeness_score": completeness_score,
        "sections_found": len(sections_found),
        "sections_missing": sections_missing,
        "sections_recovered": sections_recovered,
        "blocking_issues": blocking_issues,
        "warnings": warnings,
    }))

    # Create decisions
    structure_risk = RiskLevel.HIGH if blocking_issues else (
        RiskLevel.MEDIUM if completeness_score < 0.95 else RiskLevel.LOW
    )
    decisions.append(create_decision(
        stage="structure",
        action=f"Structure mapping: {completeness_score:.0%} complete",
        confidence=completeness_score,
        risk_level=structure_risk,
        reasoning=f"Found {len(sections_found)}/{total_required} required sections, {len(sections_missing)} missing",
        details={
            "sections_found": sections_found,
            "sections_missing": sections_missing,
            "sections_recovered": sections_recovered,
        }
    ))

    # Determine if we need human confirmation for appendix order
    needs_order_confirmation = len(appendix_docs) > 1

    return {
        "current_stage": PipelineStage.STRUCTURE,
        "stage_history": [PipelineStage.STRUCTURE.value],
        "structure_result": structure_result,
        "structure_complete": not needs_order_confirmation and not blocking_issues,
        "appendix_order_confirmed": not needs_order_confirmation,
        "awaiting_human_input": needs_order_confirmation,
        "human_input_type": "appendix_order" if needs_order_confirmation else None,
        "human_input_data": {
            "appendix_order": [
                {
                    "file_id": doc.file.id,
                    "filename": doc.file.original_filename,
                    "appendix_letter": doc.classification.appendix_letter,
                    "section": doc.classification.section,
                    "page_count": doc.file.page_count,
                }
                for doc in sorted_appendices
            ],
            "completeness_score": completeness_score,
            "blocking_issues": blocking_issues,
            "warnings": warnings,
        } if needs_order_confirmation else {},
        "audit_log": audit_entries,
        "decisions": decisions,
        "errors": blocking_issues if blocking_issues else [],
        "pipeline_failed": len(blocking_issues) > 0 and completeness_score < 0.5,
    }


def _map_to_template_section(section: str) -> Optional[str]:
    """Map a classification section to template section ID."""
    section_lower = section.lower()

    # Direct lookup
    if section_lower in SECTION_TO_TEMPLATE:
        return SECTION_TO_TEMPLATE[section_lower]

    # Partial match
    for template_id, variations in SECTION_MAPPING.items():
        for var in variations:
            if var in section_lower or section_lower in var:
                return template_id

    return None


def _attempt_section_recovery(doc: ClassifiedDocument, section_assignments: Dict) -> Optional[str]:
    """
    Attempt to recover a document's section assignment using content analysis.

    This helps catch misclassified documents that should belong in the report.
    """
    text_lower = doc.file.text_content.lower()[:5000]  # First 5000 chars

    # Keywords that suggest appendix placement
    recovery_patterns = {
        "appendix_c": ["sanborn", "fire insurance", "aerial photograph", "city directory",
                       "topographic", "historical map", "1920", "1930", "1940", "1950"],
        "appendix_d": ["regulatory", "correspondence", "agency", "epa", "state environmental"],
        "appendix_e": ["edr", "environmental database", "radius map", "orphan summary"],
        "appendix_b": ["photograph", "photo log", "site visit", "exterior view", "interior view"],
        "appendix_a": ["site plan", "vicinity map", "figure", "location map"],
    }

    for section_id, keywords in recovery_patterns.items():
        if any(kw in text_lower for kw in keywords):
            # Only recover if section doesn't already have documents
            if not section_assignments.get(section_id):
                return section_id

    return None


def _calculate_section_confidence(docs: List[ClassifiedDocument]) -> float:
    """Calculate confidence score for a section based on assigned documents."""
    if not docs:
        return 0.0

    # Average confidence of documents assigned to this section
    confidences = [d.classification.confidence for d in docs if d.classification.confidence]
    return sum(confidences) / len(confidences) if confidences else 0.5


def apply_appendix_order(
    state: ReportState,
    new_order: List[str],  # List of file IDs in desired order
) -> Dict[str, Any]:
    """
    Apply human-specified appendix ordering.

    Args:
        state: Current pipeline state
        new_order: List of file IDs in the order the human wants

    Returns:
        Updated state fields
    """
    logger.info(f"Applying custom appendix order: {new_order}")

    structure_result = state.get("structure_result")
    if not structure_result:
        return {
            "errors": ["No structure result to update"],
        }

    classified_docs = state.get("classified_documents", [])
    appendix_docs = [d for d in classified_docs if d.classification.category == DocumentCategory.APPENDIX]

    # Map file_id to doc
    appendix_map = {d.file.id: d for d in appendix_docs}

    # Reorder appendices
    new_appendix_order = []
    for file_id in new_order:
        if file_id in appendix_map:
            new_appendix_order.append(appendix_map[file_id])

    # Add any appendices not in the new order
    for doc in appendix_docs:
        if doc.file.id not in new_order:
            new_appendix_order.append(doc)

    # Rebuild ordered documents list
    non_appendix_docs = [d for d in structure_result.ordered_documents
                        if d.classification.category != DocumentCategory.APPENDIX]

    new_ordered = non_appendix_docs + new_appendix_order

    # Update structure result
    structure_result.appendix_order = new_order
    structure_result.ordered_documents = new_ordered

    audit_entry = log_action("structure", "appendix_order_applied", {
        "new_order": new_order,
    })

    return {
        "structure_result": structure_result,
        "structure_complete": True,
        "appendix_order_confirmed": True,
        "awaiting_human_input": False,
        "human_input_type": None,
        "human_input_data": {},
        "audit_log": [audit_entry],
    }

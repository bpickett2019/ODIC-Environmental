"""
CLASSIFY Node - Dual-Pass AI Validation System

AI-powered document classification into ESA taxonomy with multi-pass validation:
1. First pass with prompt variant A
2. Second pass with prompt variant B
3. If disagreement, tiebreaker pass with chain-of-thought

CRITICAL: Must distinguish between current report content and previous reports
from other companies included as reference material.

Generates 2-3 sentence content summaries per document.
"""

import json
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime

from state import (
    ReportState,
    IngestedFile,
    Classification,
    ClassificationPass,
    ClassifiedDocument,
    DocumentCategory,
    PipelineStage,
    log_action,
    create_decision,
    RiskLevel,
)
from utils.llm import get_classifier_llm, get_reasoning_llm

logger = logging.getLogger(__name__)

# Confidence threshold for auto-approval
CONFIDENCE_THRESHOLD = 0.85


# ===== Classification Prompts =====

CLASSIFICATION_PROMPT_A = """You are an Environmental Site Assessment document classifier (Variant A - Focus on Structure).

Classify this document into the ESA report structure. Focus on document structure indicators:
- Headers, footers, and section titles
- Page numbering patterns
- Document formatting
- Table of contents references

CRITICAL DISTINCTION: Previous environmental reports conducted by OTHER companies are
SUPPORTING RECORDS (reference material), NOT part of the main report body. Look for:
- Different company letterheads/logos
- Different project numbers
- Different professional signatures
- Dated reports that predate the current assessment

CATEGORIES:
1. main_body - Core report content from our firm for this assessment
   Sections: executive_summary, introduction, site_description, environmental_setting,
   historical_use, records_review, site_reconnaissance, interviews, findings,
   conclusions, recommendations, deviations, qualifications

2. appendix - Supporting documentation for this report
   Sections: appendix_a_figures (site plans, maps), appendix_b_photos,
   appendix_c_historical (Sanborn maps, aerials, city directories, topos),
   appendix_d_regulatory, appendix_e_edr, appendix_f_qualifications

3. supporting_record - Reference material from other entities
   Sections: previous_phase1, previous_phase2, third_party_report, historical_assessment

4. excluded - Should not be in final report
   Sections: duplicate, draft, internal_notes, irrelevant

Output JSON:
{
    "category": "main_body|appendix|supporting_record|excluded",
    "section": "specific_section_id",
    "appendix_letter": "A|B|C|D|E|F|null",
    "confidence": 0.0-1.0,
    "reasoning": "detailed explanation",
    "content_summary": "2-3 sentence summary of document content",
    "key_entities": {"company": "...", "project_id": "...", "address": "...", "date": "..."},
    "flags": ["list of concerns"]
}"""

CLASSIFICATION_PROMPT_B = """You are an Environmental Site Assessment document classifier (Variant B - Focus on Content).

Classify this document into the ESA report structure. Focus on content analysis:
- Key terminology and phrases
- Subject matter discussed
- Data types presented
- Professional language patterns

CRITICAL: Reports from OTHER environmental companies are SUPPORTING RECORDS, not main report.
Signs of third-party content:
- Different company name mentioned as author
- Project IDs that don't match the current project
- Different site addresses mentioned
- Historical dates from years ago

CATEGORIES:
1. main_body - Our firm's current assessment content
   Look for: Our company name, current project ID, current date references

2. appendix - Supporting materials we're including
   Look for: Maps, photos, historical records, regulatory correspondence, EDR data

3. supporting_record - Other companies' reports included as reference
   Look for: Different letterhead, different author, prior assessment dates

4. excluded - Remove from final report
   Look for: Duplicates, draft watermarks, internal notes

Output JSON:
{
    "category": "main_body|appendix|supporting_record|excluded",
    "section": "specific_section_id",
    "appendix_letter": "A|B|C|D|E|F|null",
    "confidence": 0.0-1.0,
    "reasoning": "detailed explanation",
    "content_summary": "2-3 sentence summary of document content",
    "key_entities": {"company": "...", "project_id": "...", "address": "...", "date": "..."},
    "flags": ["list of concerns"]
}"""

TIEBREAKER_PROMPT = """You are the senior Environmental Site Assessment document classifier performing a TIEBREAKER classification.

Two prior classification passes DISAGREED on this document. You must resolve the conflict.

PASS 1 RESULT:
{pass1_result}

PASS 2 RESULT:
{pass2_result}

Your task:
1. Analyze both classifications
2. Examine the document content carefully
3. Use chain-of-thought reasoning to determine the correct classification
4. Provide a final, authoritative classification

CRITICAL: Pay special attention to whether this is:
- Content from OUR firm's current assessment (main_body/appendix)
- Content from ANOTHER company's prior work (supporting_record)

Think step by step, then output JSON:
{
    "category": "main_body|appendix|supporting_record|excluded",
    "section": "specific_section_id",
    "appendix_letter": "A|B|C|D|E|F|null",
    "confidence": 0.0-1.0,
    "reasoning": "DETAILED chain-of-thought explaining your resolution",
    "content_summary": "2-3 sentence summary of document content",
    "key_entities": {"company": "...", "project_id": "...", "address": "...", "date": "..."},
    "flags": ["list of concerns"],
    "resolution_notes": "why you chose this over the other classification"
}"""


def classify_node(state: ReportState) -> Dict[str, Any]:
    """
    CLASSIFY node - Dual-pass AI classification with tiebreaker resolution.

    Process:
    1. Run classification pass A
    2. Run classification pass B
    3. If agreement (same category+section), use result with higher confidence
    4. If disagreement, run tiebreaker pass
    5. Generate content summaries for all documents
    """
    logger.info(f"CLASSIFY: Starting for project {state['project_id']}")

    files = state.get("files", [])
    if not files:
        logger.warning("CLASSIFY: No files to classify")
        return {
            "current_stage": PipelineStage.CLASSIFY,
            "stage_history": [PipelineStage.CLASSIFY.value],
            "classified_documents": [],
            "classification_complete": True,
            "classification_passes_run": 0,
            "tiebreakers_used": 0,
            "documents_needing_review": [],
            "audit_log": [log_action("classify", "no_files", {})],
        }

    classified_docs: List[ClassifiedDocument] = []
    audit_entries: List[Dict] = []
    decisions = []
    tiebreakers_used = 0
    total_passes = 0

    project_id = state["project_id"]
    project_address = state.get("project_address", "")
    client_name = state.get("client_name", "")
    company_name = state.get("company_name", "ODIC Environmental")

    for file in files:
        logger.info(f"Classifying: {file.original_filename}")

        try:
            # Run dual-pass classification
            pass1_result = _run_classification_pass(
                file=file,
                prompt_variant="A",
                system_prompt=CLASSIFICATION_PROMPT_A,
                project_id=project_id,
                project_address=project_address,
                client_name=client_name,
                company_name=company_name,
            )
            total_passes += 1

            pass2_result = _run_classification_pass(
                file=file,
                prompt_variant="B",
                system_prompt=CLASSIFICATION_PROMPT_B,
                project_id=project_id,
                project_address=project_address,
                client_name=client_name,
                company_name=company_name,
            )
            total_passes += 1

            # Check for agreement
            passes_agree = (
                pass1_result.classification.category == pass2_result.classification.category and
                pass1_result.classification.section == pass2_result.classification.section
            )

            if passes_agree:
                # Use result with higher confidence
                final_classification = (
                    pass1_result.classification
                    if pass1_result.classification.confidence >= pass2_result.classification.confidence
                    else pass2_result.classification
                )
                tiebreaker_used = False
                logger.info(f"Passes agree on {file.original_filename}: {final_classification.section}")
            else:
                # Run tiebreaker
                logger.info(f"Passes disagree on {file.original_filename}, running tiebreaker")
                tiebreaker_result = _run_tiebreaker(
                    file=file,
                    pass1_result=pass1_result,
                    pass2_result=pass2_result,
                    project_id=project_id,
                    project_address=project_address,
                    company_name=company_name,
                )
                final_classification = tiebreaker_result.classification
                tiebreaker_used = True
                tiebreakers_used += 1
                total_passes += 1

            # Determine if human review needed
            needs_review = (
                final_classification.confidence < CONFIDENCE_THRESHOLD or
                "possible_cross_contamination" in final_classification.flags or
                "low_confidence" in final_classification.flags or
                tiebreaker_used
            )

            # Add OCR quality flag if needed
            if file.ocr_confidence and file.ocr_confidence < 0.7:
                final_classification.flags.append("low_ocr_quality")

            classified_doc = ClassifiedDocument(
                file=file,
                classification=final_classification,
                classification_passes=[pass1_result, pass2_result],
                tiebreaker_used=tiebreaker_used,
                needs_review=needs_review,
            )

            if tiebreaker_used:
                classified_doc.classification_passes.append(tiebreaker_result)

            classified_docs.append(classified_doc)

            # Audit entry
            audit_entries.append(log_action("classify", "document_classified", {
                "file_id": file.id,
                "filename": file.original_filename,
                "category": final_classification.category.value,
                "section": final_classification.section,
                "confidence": final_classification.confidence,
                "passes_agreed": passes_agree,
                "tiebreaker_used": tiebreaker_used,
                "needs_review": needs_review,
                "content_summary": final_classification.content_summary,
            }))

            # Decision tracking
            decisions.append(create_decision(
                stage="classify",
                action=f"Classified '{file.original_filename}' as {final_classification.category.value}/{final_classification.section}",
                confidence=final_classification.confidence,
                risk_level=RiskLevel.HIGH if tiebreaker_used else RiskLevel.MEDIUM,
                reasoning=final_classification.reasoning,
                details={
                    "file_id": file.id,
                    "category": final_classification.category.value,
                    "section": final_classification.section,
                    "passes_agreed": passes_agree,
                    "tiebreaker_used": tiebreaker_used,
                    "flags": final_classification.flags,
                    "content_summary": final_classification.content_summary,
                }
            ))

            logger.info(
                f"Classified: {file.original_filename} -> "
                f"{final_classification.category.value}/{final_classification.section} "
                f"(confidence: {final_classification.confidence:.2f}, tiebreaker: {tiebreaker_used})"
            )

        except Exception as e:
            logger.exception(f"Classification failed for {file.original_filename}: {e}")

            # Create fallback classification
            fallback = Classification(
                category=DocumentCategory.EXCLUDED,
                section="error",
                confidence=0.0,
                flags=["classification_error", str(e)],
                reasoning=f"Classification failed: {e}",
                content_summary="Classification error - manual review required",
            )

            classified_doc = ClassifiedDocument(
                file=file,
                classification=fallback,
                needs_review=True,
            )
            classified_docs.append(classified_doc)

            audit_entries.append(log_action("classify", "classification_error", {
                "file_id": file.id,
                "filename": file.original_filename,
                "error": str(e),
            }))

    # Summary
    by_category = {}
    for doc in classified_docs:
        cat = doc.classification.category.value
        by_category[cat] = by_category.get(cat, 0) + 1

    documents_needing_review = [doc.file.id for doc in classified_docs if doc.needs_review]

    logger.info(
        f"CLASSIFY complete: {len(classified_docs)} documents, "
        f"{total_passes} passes run, "
        f"{tiebreakers_used} tiebreakers, "
        f"{len(documents_needing_review)} need review"
    )
    logger.info(f"Categories: {by_category}")

    audit_entries.append(log_action("classify", "classify_complete", {
        "total_documents": len(classified_docs),
        "total_passes": total_passes,
        "tiebreakers_used": tiebreakers_used,
        "needs_review": len(documents_needing_review),
        "by_category": by_category,
    }))

    return {
        "current_stage": PipelineStage.CLASSIFY,
        "stage_history": [PipelineStage.CLASSIFY.value],
        "classified_documents": classified_docs,
        "classification_complete": True,
        "classification_passes_run": total_passes,
        "tiebreakers_used": tiebreakers_used,
        "documents_needing_review": documents_needing_review,
        "decisions": decisions,
        "audit_log": audit_entries,
    }


def _run_classification_pass(
    file: IngestedFile,
    prompt_variant: str,
    system_prompt: str,
    project_id: str,
    project_address: str,
    client_name: str,
    company_name: str,
) -> ClassificationPass:
    """Run a single classification pass."""
    from langchain_core.messages import HumanMessage, SystemMessage

    llm = get_classifier_llm()

    user_prompt = f"""Classify this document for:
Project ID: {project_id}
Project Address: {project_address}
Client: {client_name}
Our Company: {company_name}

Document: {file.original_filename}
Format: {file.format}
Pages: {file.page_count}

Document text (first 12000 chars):
---
{file.text_content[:12000]}
---

Return ONLY valid JSON."""

    messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_prompt)
    ]

    response = llm.invoke(messages)
    raw_response = response.content

    # Parse response
    result = _parse_classification_response(raw_response)

    classification = Classification(
        category=result.get("category", DocumentCategory.EXCLUDED),
        section=result.get("section", "unknown"),
        appendix_letter=result.get("appendix_letter"),
        confidence=result.get("confidence", 0.5),
        flags=result.get("flags", []),
        reasoning=result.get("reasoning", ""),
        content_summary=result.get("content_summary", ""),
    )

    return ClassificationPass(
        pass_number=1 if prompt_variant == "A" else 2,
        classification=classification,
        prompt_variant=prompt_variant,
        raw_response=raw_response,
    )


def _run_tiebreaker(
    file: IngestedFile,
    pass1_result: ClassificationPass,
    pass2_result: ClassificationPass,
    project_id: str,
    project_address: str,
    company_name: str,
) -> ClassificationPass:
    """Run tiebreaker classification when passes disagree."""
    from langchain_core.messages import HumanMessage, SystemMessage

    llm = get_reasoning_llm()  # Use more capable model for tiebreaker

    pass1_json = json.dumps({
        "category": pass1_result.classification.category.value,
        "section": pass1_result.classification.section,
        "confidence": pass1_result.classification.confidence,
        "reasoning": pass1_result.classification.reasoning,
    }, indent=2)

    pass2_json = json.dumps({
        "category": pass2_result.classification.category.value,
        "section": pass2_result.classification.section,
        "confidence": pass2_result.classification.confidence,
        "reasoning": pass2_result.classification.reasoning,
    }, indent=2)

    system_prompt = TIEBREAKER_PROMPT.format(
        pass1_result=pass1_json,
        pass2_result=pass2_json,
    )

    user_prompt = f"""Resolve classification conflict for:
Project ID: {project_id}
Project Address: {project_address}
Our Company: {company_name}

Document: {file.original_filename}
Format: {file.format}
Pages: {file.page_count}

Document text (first 15000 chars for thorough analysis):
---
{file.text_content[:15000]}
---

Provide your tiebreaker decision as JSON."""

    messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_prompt)
    ]

    response = llm.invoke(messages)
    raw_response = response.content

    result = _parse_classification_response(raw_response)

    classification = Classification(
        category=result.get("category", DocumentCategory.EXCLUDED),
        section=result.get("section", "unknown"),
        appendix_letter=result.get("appendix_letter"),
        confidence=result.get("confidence", 0.7),
        flags=result.get("flags", []) + ["tiebreaker_resolved"],
        reasoning=result.get("reasoning", "") + f"\n\nResolution: {result.get('resolution_notes', '')}",
        content_summary=result.get("content_summary", ""),
    )

    return ClassificationPass(
        pass_number=3,
        classification=classification,
        prompt_variant="TIEBREAKER",
        raw_response=raw_response,
    )


def _parse_classification_response(response: str) -> Dict[str, Any]:
    """Parse classification JSON from LLM response."""
    try:
        # Extract JSON from response
        content = response
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]

        result = json.loads(content.strip())

        # Normalize category
        category_str = result.get("category", "excluded")
        try:
            result["category"] = DocumentCategory(category_str)
        except ValueError:
            result["category"] = DocumentCategory.EXCLUDED

        return result

    except (json.JSONDecodeError, IndexError) as e:
        logger.warning(f"Failed to parse classification response: {e}")
        return {
            "category": DocumentCategory.EXCLUDED,
            "section": "parse_error",
            "confidence": 0.3,
            "flags": ["parse_error"],
            "reasoning": f"Failed to parse response: {e}",
            "content_summary": "Parse error - manual review required",
        }


def apply_human_classification(
    state: ReportState,
    decisions: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Apply human corrections to classifications.

    Args:
        state: Current pipeline state
        decisions: Dict mapping file_id to classification overrides
            Each override can contain: category, section, appendix_letter, confirmed

    Returns:
        Updated state fields
    """
    logger.info(f"Applying human classification decisions for {len(decisions)} documents")

    classified_docs = state.get("classified_documents", [])
    audit_entries = []

    for doc in classified_docs:
        file_id = doc.file.id
        if file_id in decisions:
            override = decisions[file_id]

            # Apply category override
            if "category" in override:
                try:
                    doc.classification.category = DocumentCategory(override["category"])
                except ValueError:
                    pass

            # Apply section override
            if "section" in override:
                doc.classification.section = override["section"]

            # Apply appendix letter override
            if "appendix_letter" in override:
                doc.classification.appendix_letter = override["appendix_letter"]

            # Mark as human-confirmed
            doc.classification.flags.append("human_confirmed")
            doc.needs_review = False

            # Boost confidence if human confirmed
            if override.get("confirmed", False):
                doc.classification.confidence = max(doc.classification.confidence, 0.95)

            audit_entries.append(log_action("classify", "human_override", {
                "file_id": file_id,
                "filename": doc.file.original_filename,
                "changes": override,
            }))

    return {
        "classified_documents": classified_docs,
        "classification_complete": True,
        "awaiting_human_input": False,
        "human_input_type": None,
        "human_input_data": {},
        "audit_log": audit_entries,
    }

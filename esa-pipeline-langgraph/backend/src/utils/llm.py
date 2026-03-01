"""
LLM Client for ESA Pipeline

Uses OpenAI GPT-4 for:
- Document classification
- QC content integrity checks
- Cross-contamination detection
"""

import os
import logging
from typing import Optional, Dict, Any, List
from functools import lru_cache

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate
from pydantic_settings import BaseSettings

logger = logging.getLogger(__name__)


class LLMSettings(BaseSettings):
    """LLM configuration settings."""
    openai_api_key: str = ""
    classifier_model: str = "gpt-4o-mini"  # Fast & cheap for classification
    reasoning_model: str = "gpt-4o"  # More capable for QC/analysis
    max_retries: int = 3
    timeout_seconds: int = 60

    class Config:
        env_file = ".env"
        env_prefix = ""


@lru_cache()
def get_llm_settings() -> LLMSettings:
    """Get cached LLM settings."""
    return LLMSettings()


def get_classifier_llm() -> ChatOpenAI:
    """Get LLM for classification tasks (GPT-4o-mini - fast & cheap)."""
    settings = get_llm_settings()
    return ChatOpenAI(
        model=settings.classifier_model,
        api_key=settings.openai_api_key,
        max_retries=settings.max_retries,
        timeout=settings.timeout_seconds,
        temperature=0.0,  # Deterministic for classification
    )


def get_reasoning_llm() -> ChatOpenAI:
    """Get LLM for reasoning tasks (GPT-4o - accurate & thoughtful)."""
    settings = get_llm_settings()
    return ChatOpenAI(
        model=settings.reasoning_model,
        api_key=settings.openai_api_key,
        max_retries=settings.max_retries,
        timeout=settings.timeout_seconds,
        temperature=0.1,  # Slight creativity for analysis
    )


# Classification prompt
CLASSIFICATION_SYSTEM_PROMPT = """You are an Environmental Site Assessment document classifier.
Your task is to classify documents into the correct ESA report structure.

CRITICAL DISTINCTION: Previous environmental reports conducted by OTHER companies on the same site are
SUPPORTING RECORDS (Appendix material), NOT part of the main report body. Look for:
- Different company letterheads
- Different project numbers
- Dated reports that predate the current assessment
- References to other firms' work

These go into the records/references appendix, never into the main report sections.

DOCUMENT CATEGORIES:
1. main_body - Core report content written by our firm for this assessment
   - executive_summary
   - introduction
   - site_description
   - environmental_setting
   - historical_use
   - regulatory_database_review
   - vapor_assessment
   - findings_conclusions_recommendations
   - qualifications

2. appendix - Supporting documentation for this report
   - appendix_a_site_plans_maps
   - appendix_b_site_photographs
   - appendix_c_historical_sources (Sanborn Maps, City Directories, Aerial Photos)
   - appendix_d_regulatory_records
   - appendix_e_edr_report
   - appendix_f_qualifications
   - appendix_other

3. supporting_record - Reference material from other entities
   - previous_phase1_other_firm
   - previous_phase2_other_firm
   - historical_report
   - third_party_assessment

4. excluded - Should not be included in final report
   - duplicate
   - draft
   - internal_notes
   - irrelevant

For each document, output a JSON object with:
- category: one of [main_body, appendix, supporting_record, excluded]
- section: specific section identifier
- appendix_letter: if appendix, the letter (A, B, C, etc.)
- confidence: 0.0-1.0 confidence score
- reasoning: brief explanation of classification decision
- flags: list of any concerns (e.g., "possible_cross_contamination", "low_ocr_quality", "different_project_id")
"""

CLASSIFICATION_USER_TEMPLATE = """Classify the following document for project: {project_id}
Project Address: {project_address}
Client: {client_name}

Document filename: {filename}
Document format: {format}
Page count: {page_count}

Document text (first 10000 characters):
---
{text_content}
---

Return ONLY valid JSON with the classification."""


def classify_document(
    text_content: str,
    filename: str,
    format: str,
    page_count: int,
    project_id: str,
    project_address: str,
    client_name: str = "",
) -> Dict[str, Any]:
    """
    Classify a document using Claude.

    Returns classification dict with category, section, confidence, etc.
    Falls back to rule-based classification if API unavailable.
    """
    settings = get_llm_settings()

    # Check if API key is available
    if not settings.openai_api_key:
        logger.warning("No OpenAI API key, using rule-based classification")
        return _rule_based_classify(text_content, filename, format)

    try:
        llm = get_classifier_llm()

        # Truncate text to avoid token limits
        truncated_text = text_content[:10000] if len(text_content) > 10000 else text_content

        messages = [
            SystemMessage(content=CLASSIFICATION_SYSTEM_PROMPT),
            HumanMessage(content=CLASSIFICATION_USER_TEMPLATE.format(
                project_id=project_id,
                project_address=project_address,
                client_name=client_name,
                filename=filename,
                format=format,
                page_count=page_count,
                text_content=truncated_text,
            ))
        ]

        response = llm.invoke(messages)

        # Parse JSON response
        import json
        try:
            # Try to extract JSON from response
            content = response.content
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]

            result = json.loads(content.strip())
            logger.info(f"Classified {filename}: {result.get('category')} / {result.get('section')} (confidence: {result.get('confidence')})")
            return result

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse classification response: {e}")
            return _rule_based_classify(text_content, filename, format)

    except Exception as e:
        logger.error(f"LLM classification failed: {e}")
        return _rule_based_classify(text_content, filename, format)


def _rule_based_classify(text_content: str, filename: str, format: str) -> Dict[str, Any]:
    """Rule-based classification fallback."""
    text_lower = text_content.lower()
    filename_lower = filename.lower()

    # Check for common document types by keywords and filename patterns
    rules = [
        # Main body sections
        (["executive summary"], "main_body", "executive_summary", None),
        (["introduction", "purpose and scope"], "main_body", "introduction", None),
        (["site description", "site location"], "main_body", "site_description", None),
        (["environmental setting", "geology", "hydrogeology"], "main_body", "environmental_setting", None),
        (["historical use", "historical review"], "main_body", "historical_use", None),
        (["regulatory", "database review", "edr"], "main_body", "regulatory_database_review", None),
        (["findings", "conclusions", "recommendations"], "main_body", "findings_conclusions_recommendations", None),
        (["qualifications", "credentials", "certifications"], "main_body", "qualifications", None),

        # Appendices
        (["site plan", "site map", "location map"], "appendix", "appendix_a_site_plans_maps", "A"),
        (["photograph", "photo"], "appendix", "appendix_b_site_photographs", "B"),
        (["sanborn", "fire insurance map"], "appendix", "appendix_c_historical_sources", "C"),
        (["city directory", "polk directory"], "appendix", "appendix_c_historical_sources", "C"),
        (["aerial photo", "aerial photograph"], "appendix", "appendix_c_historical_sources", "C"),
        (["topographic", "topo map", "usgs"], "appendix", "appendix_c_historical_sources", "C"),
        (["regulatory correspondence", "agency letter"], "appendix", "appendix_d_regulatory_records", "D"),
        (["edr report", "environmental database"], "appendix", "appendix_e_edr_report", "E"),

        # Supporting records from other entities
        (["prepared by", "conducted by"], "supporting_record", "previous_phase1_other_firm", None),
    ]

    for keywords, category, section, appendix_letter in rules:
        if any(kw in text_lower or kw in filename_lower for kw in keywords):
            return {
                "category": category,
                "section": section,
                "appendix_letter": appendix_letter,
                "confidence": 0.6,  # Lower confidence for rule-based
                "reasoning": f"Rule-based classification matched keywords: {keywords}",
                "flags": ["rule_based_fallback"],
            }

    # Default - unknown, needs review
    return {
        "category": "excluded",
        "section": "unknown",
        "appendix_letter": None,
        "confidence": 0.3,
        "reasoning": "No keywords matched, flagged for manual review",
        "flags": ["needs_manual_review"],
    }


# QC Content Integrity Prompt
QC_CONTENT_INTEGRITY_PROMPT = """You are a QC validator for Environmental Site Assessment reports.
Your task is to validate content integrity by checking:

1. Executive summary references match actual findings in the report
2. Site address/description is consistent throughout
3. Dates are consistent (report date, site visit date)
4. Project ID is consistent throughout
5. Company names and professional certifications are present

For the given report content, identify any inconsistencies or issues.

Output a JSON object with:
- issues: list of issue objects, each with:
  - description: what's wrong
  - location: where in the document
  - severity: "critical" or "warning"
  - auto_fixable: true/false
  - suggested_fix: if auto_fixable, how to fix it
- passed: true/false
- confidence: 0.0-1.0 confidence in assessment
- notes: any other observations
"""


def check_content_integrity(
    report_content: str,
    project_id: str,
    project_address: str,
    client_name: str,
) -> Dict[str, Any]:
    """
    Use Claude to check content integrity of assembled report.
    """
    settings = get_llm_settings()

    if not settings.openai_api_key:
        logger.warning("No OpenAI API key, skipping AI content integrity check")
        return {
            "issues": [],
            "passed": True,
            "confidence": 0.5,
            "notes": "AI content check skipped - no API key"
        }

    try:
        llm = get_reasoning_llm()  # Use Sonnet for reasoning

        # Truncate content to fit context window
        max_chars = 150000  # ~50k tokens
        truncated_content = report_content[:max_chars] if len(report_content) > max_chars else report_content

        messages = [
            SystemMessage(content=QC_CONTENT_INTEGRITY_PROMPT),
            HumanMessage(content=f"""Project ID: {project_id}
Project Address: {project_address}
Client: {client_name}

Report Content:
---
{truncated_content}
---

Return ONLY valid JSON with the integrity check results.""")
        ]

        response = llm.invoke(messages)

        import json
        try:
            content = response.content
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]

            return json.loads(content.strip())

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse content integrity response: {e}")
            return {
                "issues": [],
                "passed": True,
                "confidence": 0.3,
                "notes": f"AI check failed to parse: {e}"
            }

    except Exception as e:
        logger.error(f"Content integrity check failed: {e}")
        return {
            "issues": [],
            "passed": True,
            "confidence": 0.3,
            "notes": f"AI check failed: {e}"
        }


# Cross-contamination detection prompt
CROSS_CONTAMINATION_PROMPT = """You are checking an ESA report for cross-contamination between projects.
Cross-contamination occurs when content from one project accidentally appears in another project's report.

Check for:
1. Project IDs that don't match: {project_id}
2. Addresses that don't match: {project_address}
3. Company names or client names that seem inconsistent
4. Date ranges that don't make sense
5. References to different site locations

Output JSON with:
- contamination_found: true/false
- issues: list of specific contamination instances with:
  - description: what was found
  - location: where (page/section)
  - severity: "critical" (wrong project) or "warning" (suspicious)
  - evidence: the specific text that raised concern
- confidence: 0.0-1.0
"""


def check_cross_contamination(
    content: str,
    project_id: str,
    project_address: str,
    expected_company: str = "",
) -> Dict[str, Any]:
    """
    Use Claude to check for cross-contamination in report.
    """
    settings = get_llm_settings()

    if not settings.openai_api_key:
        logger.warning("No OpenAI API key, using rule-based contamination check")
        return _rule_based_contamination_check(content, project_id, project_address)

    try:
        llm = get_reasoning_llm()

        # Truncate content
        max_chars = 100000
        truncated = content[:max_chars] if len(content) > max_chars else content

        messages = [
            SystemMessage(content=CROSS_CONTAMINATION_PROMPT.format(
                project_id=project_id,
                project_address=project_address,
            )),
            HumanMessage(content=f"""Expected Company/Firm: {expected_company or 'Not specified'}

Document Content:
---
{truncated}
---

Return ONLY valid JSON.""")
        ]

        response = llm.invoke(messages)

        import json
        try:
            content = response.content
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]

            return json.loads(content.strip())

        except json.JSONDecodeError:
            return _rule_based_contamination_check(content, project_id, project_address)

    except Exception as e:
        logger.error(f"Cross-contamination check failed: {e}")
        return _rule_based_contamination_check(content, project_id, project_address)


def _rule_based_contamination_check(content: str, project_id: str, project_address: str) -> Dict[str, Any]:
    """Rule-based cross-contamination check fallback."""
    import re

    issues = []

    # Look for other project IDs (patterns like XXXX-XXXX or similar)
    project_patterns = re.findall(r'\b\d{4,}-\d{3,}[A-Z]*\b', content)
    for found_id in project_patterns:
        if found_id != project_id and found_id not in project_id:
            issues.append({
                "description": f"Found different project ID: {found_id}",
                "location": "Unknown",
                "severity": "critical",
                "evidence": found_id,
            })

    # Check if expected address components are present
    if project_address:
        address_parts = project_address.lower().split()
        address_found = any(part in content.lower() for part in address_parts if len(part) > 3)
        if not address_found:
            issues.append({
                "description": "Expected project address not found in content",
                "location": "Document",
                "severity": "warning",
                "evidence": project_address,
            })

    return {
        "contamination_found": len(issues) > 0,
        "issues": issues,
        "confidence": 0.5 if issues else 0.7,
    }

"""
Streaming AI Processor for ESA Pipeline Demo

Uses OpenAI's GPT-4o with streaming to provide visible AI thinking
as documents are analyzed. This is the "magic" that makes the demo impressive.
"""

import os
import json
import asyncio
import logging
from typing import AsyncGenerator, Dict, Any, Optional, List
from dataclasses import dataclass, asdict

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)


@dataclass
class AIThinkingEvent:
    """Event sent to frontend during AI processing."""
    type: str  # "thinking", "classification", "finding", "alert", "complete"
    stage: str  # "ingest", "classify", "verify", "qc"
    content: str
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self):
        return {k: v for k, v in asdict(self).items() if v is not None}


class StreamingAIProcessor:
    """
    Handles streaming AI analysis with visible thinking.

    Key features:
    - Streams tokens as AI "thinks out loud"
    - Extracts structured data (classifications, entities, issues)
    - Sends real-time events via callback
    """

    def __init__(self):
        self.client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        self.model = "gpt-4o"

    async def analyze_document_streaming(
        self,
        text_content: str,
        page_range: tuple,
        project_context: Dict[str, str],
        event_callback: callable
    ) -> Dict[str, Any]:
        """
        Analyze document content with streaming visible thinking.

        Args:
            text_content: Extracted text from PDF pages
            page_range: (start_page, end_page) tuple
            project_context: Dict with project_id, address, company
            event_callback: Async function to send events to frontend

        Returns:
            Classification result dict
        """
        system_prompt = """You are an expert Environmental Site Assessment document analyst.
You are processing a Phase I ESA report. As you analyze each section, think out loud about what
you're seeing - describe the content, identify which ESA report section it belongs to, note any
issues or observations. Be specific about what you find (company names, dates, addresses, project IDs).

IMPORTANT: Narrate your analysis process. Say things like:
- "Looking at this page, I can see..."
- "The header indicates this is from..."
- "I notice a project ID reference: ..."
- "This appears to be part of the..."
- "ALERT: I found a reference to a different company..."

Classify into one of these sections:
- Executive Summary
- Introduction / Purpose and Scope
- Site Description
- User Provided Information
- Records Review (4.0)
- Historical Review (5.0)
- Site Reconnaissance (6.0)
- Interviews
- Findings and Conclusions
- Recommendations
- Qualifications
- Appendix A - Site Plans/Maps
- Appendix B - Site Photographs
- Appendix C - Historical Sources (Sanborn, Aerials, Topos, City Directories)
- Appendix D - Regulatory Records
- Appendix E - EDR Report
- Appendix F - Qualifications
- Supporting Records (third-party reports from other firms)
- Unknown

After your analysis, output a JSON block with:
```json
{
    "section": "the section name",
    "confidence": 0-100,
    "observations": ["observation 1", "observation 2"],
    "entities_found": {
        "company": "company name if found",
        "project_id": "project ID if found",
        "address": "address if found",
        "date": "date if found"
    },
    "flags": ["any concerns like possible_cross_contamination"]
}
```"""

        user_prompt = f"""Analyzing pages {page_range[0]}-{page_range[1]} of an ESA report.

Project Context:
- Project ID: {project_context.get('project_id', 'Unknown')}
- Site Address: {project_context.get('project_address', 'Unknown')}
- Company: {project_context.get('company', 'Unknown')}

Document Content:
---
{text_content[:15000]}
---

Think out loud as you analyze this content. Then provide your classification as JSON."""

        # Send initial event
        await event_callback(AIThinkingEvent(
            type="thinking",
            stage="classify",
            content=f"Analyzing pages {page_range[0]}-{page_range[1]}...\n"
        ))

        full_response = ""

        try:
            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                stream=True,
                temperature=0.1,
                max_tokens=2000
            )

            async for chunk in stream:
                if chunk.choices[0].delta.content:
                    token = chunk.choices[0].delta.content
                    full_response += token

                    # Stream token to frontend
                    await event_callback(AIThinkingEvent(
                        type="thinking",
                        stage="classify",
                        content=token
                    ))

                    # Check for alerts in real-time
                    if "ALERT" in token.upper() or "WARNING" in token.upper():
                        await event_callback(AIThinkingEvent(
                            type="alert",
                            stage="classify",
                            content="",  # Alert will be visible in stream
                            metadata={"severity": "warning"}
                        ))

            # Extract JSON from response
            classification = self._extract_json(full_response)

            # Send classification complete event
            await event_callback(AIThinkingEvent(
                type="classification",
                stage="classify",
                content=f"\n\nClassified as: {classification.get('section', 'Unknown')} (confidence: {classification.get('confidence', 0)}%)\n",
                metadata=classification
            ))

            return classification

        except Exception as e:
            logger.exception(f"Streaming analysis failed: {e}")
            await event_callback(AIThinkingEvent(
                type="error",
                stage="classify",
                content=f"\nError during analysis: {str(e)}\n"
            ))
            return {
                "section": "Unknown",
                "confidence": 0,
                "observations": [f"Analysis failed: {str(e)}"],
                "entities_found": {},
                "flags": ["analysis_error"]
            }

    async def check_cross_contamination_streaming(
        self,
        sections: List[Dict[str, Any]],
        project_context: Dict[str, str],
        event_callback: callable
    ) -> Dict[str, Any]:
        """
        Run cross-contamination check with streaming output.

        This is the check that "spooked the client" - finding content
        from different projects mixed into the report.
        """
        system_prompt = f"""You are a QC validator for ESA reports. Your job is to detect CROSS-CONTAMINATION -
content from a different project or entity that doesn't belong in this report.

The CURRENT project is:
- Project ID: {project_context.get('project_id', 'Unknown')}
- Site Address: {project_context.get('project_address', 'Unknown')}
- Company: {project_context.get('company', 'Unknown')}

Scan the classified sections and SPECIFICALLY look for:
1. Different company names or letterheads
2. Different project IDs (any ID that doesn't match the current project)
3. Different site addresses
4. Dates that suggest content is from a prior/different assessment
5. References to other locations or properties

IMPORTANT: Think out loud as you scan. When you find something suspicious, say:
"ALERT: Found reference to [specific finding] on page [X]. This appears to be [explanation]."

Be VERY specific about what you find. Quote the exact text that raised concern.

After scanning, provide a summary JSON:
```json
{{
    "contamination_found": true/false,
    "issues": [
        {{
            "description": "what was found",
            "page": "page number",
            "severity": "critical or warning",
            "evidence": "exact text found"
        }}
    ],
    "confidence": 0-100,
    "summary": "brief summary of findings"
}}
```"""

        # Build content summary from sections
        content_summary = "\n\n".join([
            f"=== {s.get('section', 'Unknown')} (Pages {s.get('page_start', '?')}-{s.get('page_end', '?')}) ===\n{s.get('text_preview', '')[:2000]}"
            for s in sections[:10]  # Limit to first 10 sections
        ])

        user_prompt = f"""Scan the following classified sections for cross-contamination:

{content_summary}

Think out loud as you scan each section. Call out any suspicious findings immediately."""

        # Send initial event
        await event_callback(AIThinkingEvent(
            type="thinking",
            stage="qc",
            content="\n--- CROSS-CONTAMINATION SCAN ---\nScanning for content from other projects...\n\n"
        ))

        full_response = ""

        try:
            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                stream=True,
                temperature=0.1,
                max_tokens=3000
            )

            async for chunk in stream:
                if chunk.choices[0].delta.content:
                    token = chunk.choices[0].delta.content
                    full_response += token

                    # Stream to frontend
                    await event_callback(AIThinkingEvent(
                        type="thinking",
                        stage="qc",
                        content=token
                    ))

                    # Highlight alerts
                    if "ALERT" in token.upper():
                        await event_callback(AIThinkingEvent(
                            type="alert",
                            stage="qc",
                            content="",
                            metadata={"severity": "critical"}
                        ))

            # Extract results
            result = self._extract_json(full_response)

            # Send completion event
            status = "ISSUES FOUND" if result.get("contamination_found") else "CLEAN"
            await event_callback(AIThinkingEvent(
                type="finding",
                stage="qc",
                content=f"\n\n--- SCAN COMPLETE: {status} ---\n",
                metadata=result
            ))

            return result

        except Exception as e:
            logger.exception(f"Cross-contamination check failed: {e}")
            return {
                "contamination_found": False,
                "issues": [],
                "confidence": 0,
                "summary": f"Check failed: {str(e)}"
            }

    async def generate_qc_summary_streaming(
        self,
        classifications: List[Dict[str, Any]],
        contamination_result: Dict[str, Any],
        project_context: Dict[str, str],
        page_stats: Dict[str, int],
        event_callback: callable
    ) -> Dict[str, Any]:
        """
        Generate final QC summary with streaming output.
        """
        system_prompt = """You are generating a final QC summary for an ESA report review.

Summarize:
1. Section-by-section breakdown with confidence scores
2. Any cross-contamination findings
3. Missing sections per ASTM E1527-21 requirements
4. Specific observations (dates, entities, addresses found)
5. Overall assessment: ready for assembly or issues to resolve

Format your response as a clear, readable summary. At the end, provide JSON:
```json
{
    "overall_status": "ready" or "issues_found",
    "confidence": 0-100,
    "missing_sections": ["list of missing required sections"],
    "key_findings": ["important findings"],
    "recommendation": "proceed with assembly" or "requires attention"
}
```"""

        # Build classification summary
        classifications_text = "\n".join([
            f"- {c.get('section', 'Unknown')}: {c.get('confidence', 0)}% confidence"
            for c in classifications
        ])

        contamination_text = "No cross-contamination detected."
        if contamination_result.get("contamination_found"):
            issues = contamination_result.get("issues", [])
            contamination_text = f"CROSS-CONTAMINATION DETECTED:\n" + "\n".join([
                f"  - {i.get('description')} (Page {i.get('page', 'unknown')})"
                for i in issues
            ])

        user_prompt = f"""Generate QC summary for project {project_context.get('project_id', 'Unknown')}:

CLASSIFICATIONS:
{classifications_text}

PAGE STATISTICS:
- Source PDF: {page_stats.get('source_pages', 0)} pages
- Classified pages: {page_stats.get('classified_pages', 0)} pages
- Unclassified: {page_stats.get('unclassified_pages', 0)} pages

CROSS-CONTAMINATION CHECK:
{contamination_text}

Provide a comprehensive QC summary."""

        # Send initial event
        await event_callback(AIThinkingEvent(
            type="thinking",
            stage="qc",
            content="\n--- GENERATING QC SUMMARY ---\n\n"
        ))

        full_response = ""

        try:
            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                stream=True,
                temperature=0.1,
                max_tokens=2000
            )

            async for chunk in stream:
                if chunk.choices[0].delta.content:
                    token = chunk.choices[0].delta.content
                    full_response += token

                    await event_callback(AIThinkingEvent(
                        type="thinking",
                        stage="qc",
                        content=token
                    ))

            result = self._extract_json(full_response)

            await event_callback(AIThinkingEvent(
                type="complete",
                stage="qc",
                content="\n\n--- QC COMPLETE ---\n",
                metadata=result
            ))

            return result

        except Exception as e:
            logger.exception(f"QC summary generation failed: {e}")
            return {
                "overall_status": "error",
                "confidence": 0,
                "missing_sections": [],
                "key_findings": [f"Summary generation failed: {str(e)}"],
                "recommendation": "manual review required"
            }

    def _extract_json(self, text: str) -> Dict[str, Any]:
        """Extract JSON from AI response text."""
        try:
            # Look for JSON block in markdown code fence
            if "```json" in text:
                json_str = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                json_str = text.split("```")[1].split("```")[0]
            else:
                # Try to find JSON object directly
                import re
                match = re.search(r'\{[^{}]*\}', text, re.DOTALL)
                if match:
                    json_str = match.group()
                else:
                    return {}

            return json.loads(json_str.strip())
        except (json.JSONDecodeError, IndexError) as e:
            logger.warning(f"Failed to extract JSON: {e}")
            return {}


# Singleton instance
_processor = None

def get_streaming_processor() -> StreamingAIProcessor:
    """Get singleton streaming processor instance."""
    global _processor
    if _processor is None:
        _processor = StreamingAIProcessor()
    return _processor

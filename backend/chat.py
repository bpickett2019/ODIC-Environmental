"""AI chat engine for the command bar — interprets natural language commands."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from config import settings
from database import Document, Report, ChatMessage, ActionSnapshot
from models import SectionCategory, ChatAction, ChatResponse, SECTION_DISPLAY

logger = logging.getLogger(__name__)

# Map friendly names to section categories
SECTION_ALIASES = {
    "reliance": SectionCategory.RELIANCE_LETTER,
    "reliance letter": SectionCategory.RELIANCE_LETTER,
    "e&o": SectionCategory.EO_INSURANCE,
    "eo": SectionCategory.EO_INSURANCE,
    "insurance": SectionCategory.EO_INSURANCE,
    "cover": SectionCategory.COVER_WRITEUP,
    "writeup": SectionCategory.COVER_WRITEUP,
    "write-up": SectionCategory.COVER_WRITEUP,
    "write up": SectionCategory.COVER_WRITEUP,
    "appendix a": SectionCategory.APPENDIX_A,
    "app a": SectionCategory.APPENDIX_A,
    "maps": SectionCategory.APPENDIX_A,
    "appendix b": SectionCategory.APPENDIX_B,
    "app b": SectionCategory.APPENDIX_B,
    "photos": SectionCategory.APPENDIX_B,
    "photographs": SectionCategory.APPENDIX_B,
    "appendix c": SectionCategory.APPENDIX_C,
    "app c": SectionCategory.APPENDIX_C,
    "database": SectionCategory.APPENDIX_C,
    "radius": SectionCategory.APPENDIX_C,
    "edr": SectionCategory.APPENDIX_C,
    "appendix d": SectionCategory.APPENDIX_D,
    "app d": SectionCategory.APPENDIX_D,
    "historical": SectionCategory.APPENDIX_D,
    "appendix e": SectionCategory.APPENDIX_E,
    "app e": SectionCategory.APPENDIX_E,
    "agency": SectionCategory.APPENDIX_E,
    "public agency": SectionCategory.APPENDIX_E,
    "reports after e": SectionCategory.REPORTS_AFTER_E,
    "supporting reports": SectionCategory.REPORTS_AFTER_E,
    "reports": SectionCategory.REPORTS_AFTER_E,
    "appendix f": SectionCategory.APPENDIX_F,
    "app f": SectionCategory.APPENDIX_F,
    "qualifications": SectionCategory.APPENDIX_F,
}


def _build_system_prompt(report: Report, documents: list[Document]) -> str:
    """Build the system prompt with full document context."""
    # Section summary
    from collections import defaultdict
    by_section = defaultdict(list)
    excluded = []
    for doc in documents:
        if doc.is_included:
            by_section[doc.category].append(doc)
        else:
            excluded.append(doc)

    section_summary = []
    total_pages = 0
    for cat in [s.value for s in SectionCategory]:
        docs = by_section.get(cat, [])
        if not docs:
            continue
        pages = sum(d.page_count or 0 for d in docs)
        total_pages += pages
        display = SECTION_DISPLAY.get(SectionCategory(cat), cat)
        section_summary.append(f"  {display}: {len(docs)} docs, {pages} pages")

    # Full manifest (brief)
    manifest_lines = []
    for doc in documents:
        status = "INCLUDED" if doc.is_included else "EXCLUDED"
        manifest_lines.append(
            f"  id={doc.id} | {doc.original_filename} | {doc.category} | "
            f"{doc.page_count or '?'}p | {status}"
        )

    return f"""You are an AI assistant helping assemble a Phase I Environmental Site Assessment (ESA) report.

Report: {report.name}
Address: {report.address or 'unknown'}
Project: {report.project_number or 'unknown'}
Total included: {sum(len(v) for v in by_section.values())} docs, {total_pages} pages
Excluded: {len(excluded)} docs

Section summary:
{chr(10).join(section_summary)}

Document manifest:
{chr(10).join(manifest_lines)}

VALID SECTIONS: {', '.join(s.value for s in SectionCategory if s != SectionCategory.UNCLASSIFIED)}

You help the user manage this report by interpreting their commands. Respond with JSON:
{{
  "message": "Human-readable response to the user",
  "actions": [
    {{"action": "ACTION_TYPE", "params": {{...}}}}
  ]
}}

ACTION TYPES:
- move: {{"doc_ids": [1,2,3], "target_section": "APPENDIX_E"}} — Move documents to a section
- exclude: {{"doc_ids": [1,2,3], "reason": "why"}} — Exclude documents from report
- include: {{"doc_ids": [1,2,3]}} — Re-include excluded documents
- assemble: {{}} — Trigger PDF assembly
- compress: {{"quality": "email|standard|high"}} — Compress assembled PDF
- split: {{"max_size_mb": 20}} — Split PDF for email
- search: {{"query": "search term"}} — Search documents by filename
- info: {{}} — Return report statistics (no changes)
- undo: {{}} — Undo the last action
- text_replace: {{"doc_id": 1, "find": "old text", "replace": "new text"}} — Replace text in DOCX
- delete_pages: {{"doc_id": 1, "pages": [0, 1]}} — Remove pages from PDF (0-indexed)

RULES:
- When the user says "move X to Y", find matching documents and use the move action
- When finding documents, match by filename pattern (case-insensitive substring)
- For section references, use the VALID SECTIONS values exactly
- If the action would affect more than 10 documents, set a message explaining what will happen but still include the actions
- For "how many pages" or stats questions, use info action and include the answer in message
- For "assemble" or "build", use assemble action
- For "undo", use undo action
- Always be concise in your message
- If the user's request is unclear, ask for clarification in the message with empty actions"""


async def _call_llm(system_prompt: str, user_message: str) -> dict:
    """Call LLM and return parsed JSON response. Tries primary backend, falls back to secondary."""
    primary_backend = settings.AI_BACKEND or "ollama"
    
    # Try primary backend first (Ollama or Anthropic)
    if primary_backend == "ollama":
        try:
            logger.debug("Attempting Ollama chat")
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    f"{settings.OLLAMA_URL}/api/generate",
                    json={
                        "model": settings.OLLAMA_MODEL,
                        "prompt": f"{system_prompt}\n\nUser: {user_message}",
                        "stream": False,
                        "format": "json",
                    },
                )
                response.raise_for_status()
                data = response.json()
                text = data["response"].strip()
                # Strip markdown fences
                if text.startswith("```"):
                    text = re.sub(r"```(?:json)?\s*", "", text)
                    text = text.rstrip("`").strip()
                logger.debug("Ollama chat succeeded")
                return json.loads(text)
        except Exception as e:
            logger.warning(f"Ollama chat failed: {e}. Trying Anthropic fallback...")
            # Fall through to Anthropic

    elif primary_backend == "anthropic":
        try:
            logger.debug("Attempting Anthropic chat")
            import anthropic
            client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
            response = client.messages.create(
                model=settings.CLAUDE_MODEL,
                max_tokens=1000,
                system=system_prompt,
                messages=[{"role": "user", "content": user_message}],
            )
            text = response.content[0].text.strip()
            if text.startswith("```"):
                text = re.sub(r"```(?:json)?\s*", "", text)
                text = text.rstrip("`").strip()
            logger.debug("Anthropic chat succeeded")
            return json.loads(text)
        except ImportError:
            logger.warning("Anthropic module not available. Falling back to Ollama...")
        except Exception as e:
            logger.warning(f"Anthropic chat failed: {e}. Trying Ollama fallback...")
            # Fall through to Ollama

    # Fallback: Try Anthropic if primary was Ollama
    if primary_backend == "ollama" and settings.ANTHROPIC_API_KEY:
        try:
            logger.debug("Attempting Anthropic fallback")
            import anthropic
            client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
            response = client.messages.create(
                model=settings.CLAUDE_MODEL,
                max_tokens=1000,
                system=system_prompt,
                messages=[{"role": "user", "content": user_message}],
            )
            text = response.content[0].text.strip()
            if text.startswith("```"):
                text = re.sub(r"```(?:json)?\s*", "", text)
                text = text.rstrip("`").strip()
            logger.info("Switched to Anthropic after Ollama failed")
            return json.loads(text)
        except Exception as e:
            logger.error(f"Anthropic fallback also failed: {e}")

    # Fallback: Try Ollama if primary was Anthropic
    if primary_backend == "anthropic":
        try:
            logger.debug("Attempting Ollama fallback")
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    f"{settings.OLLAMA_URL}/api/generate",
                    json={
                        "model": settings.OLLAMA_MODEL,
                        "prompt": f"{system_prompt}\n\nUser: {user_message}",
                        "stream": False,
                        "format": "json",
                    },
                )
                response.raise_for_status()
                data = response.json()
                text = data["response"].strip()
                if text.startswith("```"):
                    text = re.sub(r"```(?:json)?\s*", "", text)
                    text = text.rstrip("`").strip()
                logger.info("Switched to Ollama after Anthropic failed")
                return json.loads(text)
        except Exception as e:
            logger.error(f"Ollama fallback also failed: {e}")

    # All backends failed
    logger.error("All AI backends unavailable")
    return {"message": "AI is unavailable. Please check Ollama/Anthropic connectivity and try again.", "actions": []}


def _snapshot_docs(docs: list[Document]) -> str:
    """Create a JSON snapshot of document states for undo."""
    return json.dumps([{
        "id": d.id,
        "category": d.category,
        "subcategory": d.subcategory,
        "is_included": d.is_included,
        "sort_order": d.sort_order,
        "reasoning": d.reasoning,
    } for d in docs])


def _execute_actions(
    actions: list[dict],
    report: Report,
    db: Session,
) -> list[dict]:
    """Execute parsed actions and return results."""
    results = []

    for action_data in actions:
        action = action_data.get("action", "")
        params = action_data.get("params", {})

        if action == "move":
            doc_ids = params.get("doc_ids", [])
            target = params.get("target_section", "")
            try:
                target_cat = SectionCategory(target)
            except ValueError:
                results.append({"action": "move", "error": f"Invalid section: {target}"})
                continue
            docs = db.query(Document).filter(
                Document.report_id == report.id,
                Document.id.in_(doc_ids),
            ).all()
            # Snapshot before change
            snapshot = _snapshot_docs(docs)
            snap = ActionSnapshot(
                report_id=report.id,
                snapshot_json=snapshot,
            )
            db.add(snap)
            for doc in docs:
                doc.category = target_cat.value
                doc.reasoning = f"Moved via chat command"
                doc.confidence = 1.0
            db.commit()
            results.append({"action": "move", "moved": len(docs), "target": target})

        elif action == "exclude":
            doc_ids = params.get("doc_ids", [])
            reason = params.get("reason", "Excluded via chat command")
            docs = db.query(Document).filter(
                Document.report_id == report.id,
                Document.id.in_(doc_ids),
            ).all()
            snapshot = _snapshot_docs(docs)
            snap = ActionSnapshot(report_id=report.id, snapshot_json=snapshot)
            db.add(snap)
            for doc in docs:
                doc.is_included = False
                doc.reasoning = (doc.reasoning or "") + f" [{reason}]"
            db.commit()
            results.append({"action": "exclude", "excluded": len(docs)})

        elif action == "include":
            doc_ids = params.get("doc_ids", [])
            docs = db.query(Document).filter(
                Document.report_id == report.id,
                Document.id.in_(doc_ids),
            ).all()
            snapshot = _snapshot_docs(docs)
            snap = ActionSnapshot(report_id=report.id, snapshot_json=snapshot)
            db.add(snap)
            for doc in docs:
                doc.is_included = True
            db.commit()
            results.append({"action": "include", "included": len(docs)})

        elif action == "search":
            query = params.get("query", "").lower()
            docs = db.query(Document).filter(
                Document.report_id == report.id,
            ).all()
            matches = [d for d in docs if query in d.original_filename.lower()]
            results.append({
                "action": "search",
                "matches": [{
                    "id": d.id,
                    "filename": d.original_filename,
                    "category": d.category,
                    "pages": d.page_count,
                    "included": d.is_included,
                } for d in matches],
                "count": len(matches),
            })

        elif action == "info":
            docs = db.query(Document).filter(Document.report_id == report.id).all()
            included = [d for d in docs if d.is_included]
            total_pages = sum(d.page_count or 0 for d in included)
            results.append({
                "action": "info",
                "total_docs": len(docs),
                "included_docs": len(included),
                "excluded_docs": len(docs) - len(included),
                "total_pages": total_pages,
                "status": report.status,
                "assembled": bool(report.assembled_filename),
            })

        elif action in ("assemble", "compress", "split", "undo", "text_replace", "delete_pages"):
            # These are handled by the caller (main.py endpoints)
            results.append({"action": action, "params": params, "deferred": True})

        else:
            results.append({"action": action, "error": "Unknown action"})

    return results


async def process_message(
    report_id: int,
    user_message: str,
    db: Session,
) -> ChatResponse:
    """Process a user chat message: build context, call LLM, execute actions."""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        return ChatResponse(message="Report not found.", actions=[], results=[])

    documents = db.query(Document).filter(Document.report_id == report_id).all()

    # Build prompt and call LLM
    system_prompt = _build_system_prompt(report, documents)
    llm_response = await _call_llm(system_prompt, user_message)

    message = llm_response.get("message", "")
    raw_actions = llm_response.get("actions", [])

    # Count affected docs
    affected = 0
    for a in raw_actions:
        ids = a.get("params", {}).get("doc_ids", [])
        affected += len(ids) if ids else 0

    needs_confirmation = affected > 10

    # Execute non-deferred actions (unless confirmation needed)
    results = []
    if not needs_confirmation:
        results = _execute_actions(raw_actions, report, db)

    # Save chat messages
    user_msg = ChatMessage(
        report_id=report_id,
        role="user",
        content=user_message,
    )
    db.add(user_msg)

    assistant_msg = ChatMessage(
        report_id=report_id,
        role="assistant",
        content=message,
        actions_json=json.dumps(raw_actions) if raw_actions else None,
    )
    db.add(assistant_msg)
    db.commit()

    actions = [ChatAction(action=a["action"], params=a.get("params", {})) for a in raw_actions]

    return ChatResponse(
        message=message,
        actions=actions,
        results=results,
        needs_confirmation=needs_confirmation,
        affected_count=affected,
    )


def undo_last_action(report_id: int, db: Session) -> dict:
    """Restore the most recent action snapshot."""
    snapshot = db.query(ActionSnapshot).filter(
        ActionSnapshot.report_id == report_id,
    ).order_by(ActionSnapshot.id.desc()).first()

    if not snapshot:
        return {"status": "nothing_to_undo", "restored": 0}

    doc_states = json.loads(snapshot.snapshot_json)
    restored = 0
    for state in doc_states:
        doc = db.query(Document).filter(Document.id == state["id"]).first()
        if doc:
            doc.category = state["category"]
            doc.subcategory = state.get("subcategory")
            doc.is_included = state["is_included"]
            doc.sort_order = state.get("sort_order", 0)
            doc.reasoning = state.get("reasoning")
            restored += 1

    # Remove the used snapshot
    db.delete(snapshot)
    db.commit()

    return {"status": "ok", "restored": restored}


def get_contextual_suggestions(report_id: int, db: Session) -> list[str]:
    """Generate contextual suggestion chips based on report state."""
    documents = db.query(Document).filter(Document.report_id == report_id).all()
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        return []

    suggestions = []
    included = [d for d in documents if d.is_included]
    excluded = [d for d in documents if not d.is_included]
    total_pages = sum(d.page_count or 0 for d in included)

    # Always useful
    suggestions.append("How many pages?")

    # If report has docs but isn't assembled
    if included and not report.assembled_filename:
        suggestions.append("Assemble report")

    # If assembled, suggest compression/split
    if report.assembled_filename:
        if report.assembled_size and report.assembled_size > 20 * 1024 * 1024:
            suggestions.append("Split for email")
        suggestions.append("Compress for email")

    # If there are excluded docs
    if excluded:
        suggestions.append(f"Show {len(excluded)} excluded docs")

    # If REPORTS_AFTER_E is large
    rae_pages = sum(d.page_count or 0 for d in included if d.category == "REPORTS_AFTER_E")
    if rae_pages > 500:
        suggestions.append("Trim supporting reports")

    # If unclassified docs exist
    unclassified = [d for d in included if d.category == "UNCLASSIFIED"]
    if unclassified:
        suggestions.append(f"Classify {len(unclassified)} unclassified docs")

    return suggestions[:5]  # Max 5 suggestions

"""
ESA Pipeline LangGraph Definition

Defines the StateGraph with all nodes and conditional edges.
Implements:
- Human-in-the-loop via interrupt()
- SQLite checkpointing for pause/resume
- Remediation loop for QC failures
"""

import os
import logging
from typing import Literal, Dict, Any

from langgraph.graph import StateGraph, END
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import interrupt

from state import (
    ReportState,
    PipelineStage,
    create_initial_state,
)
from nodes import (
    ingest_node,
    classify_node,
    structure_node,
    assemble_node,
    verify_node,
    qc_node,
    export_node,
)
from nodes.classify import apply_human_classification
from nodes.structure import apply_appendix_order
from nodes.verify import apply_verification_overrides
from nodes.qc import apply_auto_fixes
from nodes.export import apply_final_signoff

logger = logging.getLogger(__name__)


def should_proceed_after_ingest(state: ReportState) -> Literal["classify", "end"]:
    """Determine next step after INGEST."""
    if state.get("pipeline_failed") or not state.get("files"):
        return "end"
    return "classify"


def should_proceed_after_classify(state: ReportState) -> Literal["human_review", "structure"]:
    """Determine next step after CLASSIFY."""
    if state.get("awaiting_human_input") and state.get("human_input_type") == "classification_review":
        return "human_review"
    return "structure"


def should_proceed_after_structure(state: ReportState) -> Literal["human_order", "assemble", "end"]:
    """Determine next step after STRUCTURE."""
    if state.get("pipeline_failed"):
        return "end"
    if state.get("awaiting_human_input") and state.get("human_input_type") == "appendix_order":
        return "human_order"
    return "assemble"


def should_proceed_after_assemble(state: ReportState) -> Literal["verify", "remediate_pages", "end"]:
    """Determine next step after ASSEMBLE."""
    assembly_result = state.get("assembly_result")
    if not assembly_result:
        return "end"

    if not assembly_result.pages_match:
        # Page mismatch - needs remediation
        return "remediate_pages"

    # Go to AI verification
    return "verify"


def should_proceed_after_verify(state: ReportState) -> Literal["qc", "human_verify", "end"]:
    """Determine next step after VERIFY - auto-approve or human review."""
    verification_report = state.get("verification_report", {})

    if not verification_report:
        # No verification report - skip to QC
        return "qc"

    # Check if auto-approved (confidence >= 95% and no missing required sections)
    if verification_report.get("auto_approved", False):
        logger.info("VERIFY: Auto-approved - proceeding directly to QC")
        return "qc"

    # Check if human verification review is needed
    if state.get("awaiting_human_input") and state.get("human_input_type") == "verification_review":
        return "human_verify"

    # Default to QC
    return "qc"


def should_proceed_after_qc(state: ReportState) -> Literal["export", "human_qc", "remediate_qc", "end"]:
    """Determine next step after QC."""
    qc_result = state.get("qc_result")
    if not qc_result:
        return "end"

    if qc_result.qc_passed:
        return "export"

    # QC failed - check if we can remediate
    remediation_attempts = state.get("remediation_attempts", 0)
    max_remediations = state.get("max_remediations", 3)

    if remediation_attempts >= max_remediations:
        # Max remediations reached - need human
        return "human_qc"

    # Check if there are auto-fixable issues
    auto_fixable = [i for i in qc_result.blocking_issues if i.auto_fixable]
    if auto_fixable:
        return "remediate_qc"

    # No auto-fixable issues - need human
    return "human_qc"


def should_proceed_after_export(state: ReportState) -> Literal["human_signoff", "end"]:
    """Determine next step after EXPORT."""
    if state.get("awaiting_human_input") and state.get("human_input_type") == "final_signoff":
        return "human_signoff"
    if state.get("export_complete"):
        return "end"
    return "human_signoff"


# Human-in-the-loop nodes
def human_classification_review(state: ReportState) -> Dict[str, Any]:
    """
    Human-in-the-loop node for classification review.

    Uses LangGraph interrupt() to pause and wait for human input.
    """
    logger.info("Waiting for human classification review...")

    # Get documents needing review
    review_data = state.get("human_input_data", {})
    documents = review_data.get("documents", [])

    # Interrupt and wait for human input
    human_response = interrupt({
        "type": "classification_review",
        "documents": documents,
        "instructions": "Review the following documents and confirm or correct their classifications.",
    })

    # Apply human decisions
    if human_response and "decisions" in human_response:
        return apply_human_classification(state, human_response["decisions"])

    # If no changes, just mark as complete
    return {
        "classification_complete": True,
        "awaiting_human_input": False,
        "human_input_type": None,
        "human_input_data": {},
    }


def human_appendix_order(state: ReportState) -> Dict[str, Any]:
    """
    Human-in-the-loop node for appendix reordering.

    Uses LangGraph interrupt() for drag-drop reordering.
    """
    logger.info("Waiting for human appendix order confirmation...")

    review_data = state.get("human_input_data", {})

    human_response = interrupt({
        "type": "appendix_order",
        "appendix_order": review_data.get("appendix_order", []),
        "instructions": "Review and reorder appendices as needed.",
    })

    if human_response and "new_order" in human_response:
        return apply_appendix_order(state, human_response["new_order"])

    # If no changes, accept current order
    return {
        "structure_complete": True,
        "appendix_order_confirmed": True,
        "awaiting_human_input": False,
        "human_input_type": None,
        "human_input_data": {},
    }


def human_qc_resolution(state: ReportState) -> Dict[str, Any]:
    """
    Human-in-the-loop node for QC issue resolution.
    """
    logger.info("Waiting for human QC resolution...")

    review_data = state.get("human_input_data", {})

    human_response = interrupt({
        "type": "qc_resolution",
        "blocking_issues": review_data.get("blocking_issues", []),
        "warnings": review_data.get("warnings", []),
        "instructions": "Review QC issues and decide which to auto-fix or manually resolve.",
    })

    if human_response:
        if human_response.get("approve_with_issues"):
            # User is accepting the report despite issues
            return {
                "qc_complete": True,
                "qc_issues_resolved": True,
                "awaiting_human_input": False,
                "human_input_type": None,
                "human_input_data": {},
            }

        if human_response.get("auto_fix"):
            # Apply selected auto-fixes and re-run QC
            fixes = human_response.get("fixes_to_apply", [])
            return apply_auto_fixes(state, fixes)

    # Default - keep waiting or fail
    return {
        "pipeline_failed": True,
        "errors": ["QC issues not resolved"],
    }


def human_final_signoff(state: ReportState) -> Dict[str, Any]:
    """
    Human-in-the-loop node for final sign-off before delivery.
    """
    logger.info("Waiting for final sign-off...")

    review_data = state.get("human_input_data", {})

    human_response = interrupt({
        "type": "final_signoff",
        "export_files": review_data.get("export_files", []),
        "qc_summary_path": review_data.get("qc_summary_path", ""),
        "instructions": "Review final export and approve for delivery.",
    })

    if human_response:
        approved = human_response.get("approved", False)
        notes = human_response.get("notes", "")
        return apply_final_signoff(state, approved, notes)

    return {
        "export_complete": False,
        "errors": ["Final sign-off not provided"],
    }


def human_verification_review(state: ReportState) -> Dict[str, Any]:
    """
    Human-in-the-loop node for verification review.

    Called when AI verification confidence is below threshold or
    required sections appear to be missing.
    """
    logger.info("Waiting for human verification review...")

    review_data = state.get("human_input_data", {})
    verification_report = state.get("verification_report", {})

    human_response = interrupt({
        "type": "verification_review",
        "verification_report": verification_report,
        "markdown_report": verification_report.get("markdown_report", ""),
        "missing_sections": review_data.get("missing_sections", []),
        "flags": verification_report.get("flags", []),
        "recommendations": verification_report.get("recommendations", []),
        "instructions": "Review the AI verification report. Approve if the report is complete, or indicate which sections need attention.",
    })

    if human_response:
        if human_response.get("approved", False):
            # Human approves despite AI concerns
            return apply_verification_overrides(state, {"approve_anyway": True})

        if human_response.get("section_overrides"):
            # Human provides corrections
            return apply_verification_overrides(state, {
                "section_overrides": human_response["section_overrides"]
            })

    # Default - mark as reviewed and continue
    return {
        "verification_reviewed": True,
        "awaiting_human_input": False,
        "human_input_type": None,
        "human_input_data": {},
    }


def remediate_page_mismatch(state: ReportState) -> Dict[str, Any]:
    """
    Remediation node for page count mismatch.
    """
    logger.info("Attempting to remediate page mismatch...")

    from nodes.assemble import remediate_missing_pages
    return remediate_missing_pages(state)


def remediate_qc_issues(state: ReportState) -> Dict[str, Any]:
    """
    Auto-remediation node for QC issues.
    """
    logger.info("Attempting auto-remediation of QC issues...")

    qc_result = state.get("qc_result")
    if not qc_result:
        return {"errors": ["No QC result to remediate"]}

    # Get auto-fixable issues
    auto_fixable = [i.description for i in qc_result.blocking_issues if i.auto_fixable]

    if auto_fixable:
        result = apply_auto_fixes(state, auto_fixable)
        # After fixing, we'll re-run QC via the graph edge
        return result

    return {"errors": ["No auto-fixable issues found"]}


def create_pipeline_graph(checkpoint_path: str = "./checkpoints/pipeline.db") -> StateGraph:
    """
    Create the ESA pipeline StateGraph with all nodes and edges.

    Args:
        checkpoint_path: Path to SQLite checkpoint database

    Returns:
        Compiled StateGraph ready for execution
    """
    # Create the graph
    graph = StateGraph(ReportState)

    # Add all nodes
    graph.add_node("ingest", ingest_node)
    graph.add_node("classify", classify_node)
    graph.add_node("human_review", human_classification_review)
    graph.add_node("structure", structure_node)
    graph.add_node("human_order", human_appendix_order)
    graph.add_node("assemble", assemble_node)
    graph.add_node("remediate_pages", remediate_page_mismatch)
    graph.add_node("verify", verify_node)  # AI verification node
    graph.add_node("human_verify", human_verification_review)  # Human verification review
    graph.add_node("qc", qc_node)
    graph.add_node("remediate_qc", remediate_qc_issues)
    graph.add_node("human_qc", human_qc_resolution)
    graph.add_node("export", export_node)
    graph.add_node("human_signoff", human_final_signoff)

    # Set entry point
    graph.set_entry_point("ingest")

    # Add conditional edges
    graph.add_conditional_edges(
        "ingest",
        should_proceed_after_ingest,
        {
            "classify": "classify",
            "end": END,
        }
    )

    graph.add_conditional_edges(
        "classify",
        should_proceed_after_classify,
        {
            "human_review": "human_review",
            "structure": "structure",
        }
    )

    # After human review, go to structure
    graph.add_edge("human_review", "structure")

    graph.add_conditional_edges(
        "structure",
        should_proceed_after_structure,
        {
            "human_order": "human_order",
            "assemble": "assemble",
            "end": END,
        }
    )

    # After human order, go to assemble
    graph.add_edge("human_order", "assemble")

    graph.add_conditional_edges(
        "assemble",
        should_proceed_after_assemble,
        {
            "verify": "verify",
            "remediate_pages": "remediate_pages",
            "end": END,
        }
    )

    # After page remediation, try assembly again
    graph.add_edge("remediate_pages", "assemble")

    # Verify determines if auto-approve or human review needed
    graph.add_conditional_edges(
        "verify",
        should_proceed_after_verify,
        {
            "qc": "qc",
            "human_verify": "human_verify",
            "end": END,
        }
    )

    # After human verification review, proceed to QC
    graph.add_edge("human_verify", "qc")

    graph.add_conditional_edges(
        "qc",
        should_proceed_after_qc,
        {
            "export": "export",
            "human_qc": "human_qc",
            "remediate_qc": "remediate_qc",
            "end": END,
        }
    )

    # After QC remediation, re-run QC
    graph.add_edge("remediate_qc", "qc")

    # After human QC resolution, either pass to export or stay
    graph.add_conditional_edges(
        "human_qc",
        lambda s: "export" if s.get("qc_issues_resolved") else "end",
        {
            "export": "export",
            "end": END,
        }
    )

    graph.add_conditional_edges(
        "export",
        should_proceed_after_export,
        {
            "human_signoff": "human_signoff",
            "end": END,
        }
    )

    # After sign-off, end
    graph.add_edge("human_signoff", END)

    return graph


def get_compiled_graph(checkpoint_path: str = "./checkpoints/pipeline.db"):
    """
    Get a compiled graph with SQLite checkpointing.

    Returns:
        Compiled graph with checkpointer attached
    """
    # Ensure checkpoint directory exists
    os.makedirs(os.path.dirname(checkpoint_path), exist_ok=True)

    # Create checkpointer
    checkpointer = SqliteSaver.from_conn_string(checkpoint_path)

    # Create and compile graph
    graph = create_pipeline_graph(checkpoint_path)
    compiled = graph.compile(checkpointer=checkpointer)

    return compiled


async def run_pipeline(
    project_id: str,
    project_address: str,
    report_type: str = "phase_1",
    client_name: str = "",
    thread_id: str = None,
) -> Dict[str, Any]:
    """
    Run the full pipeline for a project.

    Args:
        project_id: Unique project identifier
        project_address: Site address for the assessment
        report_type: "phase_1" or "phase_2"
        client_name: Name of the client
        thread_id: Optional thread ID for resuming

    Returns:
        Final state after pipeline completion
    """
    logger.info(f"Starting pipeline for project {project_id}")

    # Create initial state
    initial_state = create_initial_state(
        project_id=project_id,
        project_address=project_address,
        report_type=report_type,
        client_name=client_name,
    )

    # Get compiled graph
    graph = get_compiled_graph()

    # Run with thread ID for checkpointing
    config = {"configurable": {"thread_id": thread_id or project_id}}

    final_state = None
    async for event in graph.astream(initial_state, config):
        logger.debug(f"Pipeline event: {event}")
        final_state = event

    return final_state


def resume_pipeline(thread_id: str, human_input: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    Resume a paused pipeline with optional human input.

    Args:
        thread_id: Thread ID of the paused pipeline
        human_input: Human input to provide (for interrupt resumption)

    Returns:
        Updated state after resumption
    """
    logger.info(f"Resuming pipeline thread {thread_id}")

    graph = get_compiled_graph()
    config = {"configurable": {"thread_id": thread_id}}

    # Get current state
    current_state = graph.get_state(config)

    if human_input:
        # Resume with human input
        final_state = graph.invoke(human_input, config)
    else:
        # Just continue
        final_state = graph.invoke(None, config)

    return final_state

# ODIC ESA Pipeline - Core Module
# Note: Pipeline import is deferred to avoid circular imports with skills module
from .llm_router import LLMRouter
from .state import StateManager, DocumentStatus, ProjectStatus, DocumentRecord, ProjectRecord

__all__ = [
    "LLMRouter",
    "StateManager",
    "DocumentStatus",
    "ProjectStatus",
    "DocumentRecord",
    "ProjectRecord",
]

# Deferred imports - import Pipeline directly when needed:
# from core.pipeline import Pipeline, PipelineResult, PipelineStage

"""
ODIC ESA Pipeline - Base Skill Interface

Every skill in the pipeline must implement this interface.
Skills are standalone, testable modules with a standard process() method.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Optional
import logging
from datetime import datetime


@dataclass
class SkillResult:
    """
    Standard result object returned by all skills.

    Attributes:
        success: Whether the skill completed successfully
        data: The output data from the skill
        error: Error message if success is False
        metadata: Additional context (timing, model used, etc.)
    """
    success: bool
    data: Any
    error: Optional[str] = None
    metadata: Dict = field(default_factory=dict)

    def __post_init__(self):
        """Add timestamp to metadata if not present."""
        if "timestamp" not in self.metadata:
            self.metadata["timestamp"] = datetime.utcnow().isoformat()

    @classmethod
    def ok(cls, data: Any, **metadata) -> "SkillResult":
        """Create a successful result."""
        return cls(success=True, data=data, metadata=metadata)

    @classmethod
    def fail(cls, error: str, data: Any = None, **metadata) -> "SkillResult":
        """Create a failed result."""
        return cls(success=False, data=data, error=error, metadata=metadata)


class BaseSkill(ABC):
    """
    Abstract base class for all pipeline skills.

    Each skill is a self-contained processing unit that:
    - Takes input data
    - Validates it
    - Processes it (potentially calling an LLM)
    - Returns a standardized SkillResult

    Skills should be:
    - Idempotent: running twice with same input gives same output
    - Independently testable
    - Config-driven where possible
    """

    def __init__(self, config: dict):
        """
        Initialize the skill with configuration.

        Args:
            config: Dictionary containing skill-specific and global config
        """
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)
        self._setup_logging()

    def _setup_logging(self):
        """Configure logging for this skill."""
        if not self.logger.handlers:
            handler = logging.StreamHandler()
            formatter = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
            )
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)
            self.logger.setLevel(
                logging.DEBUG if self.config.get("debug", False) else logging.INFO
            )

    @abstractmethod
    async def process(self, input_data: Any) -> SkillResult:
        """
        Process input and return result.

        This is the main entry point for the skill. Implementations should:
        1. Validate input using validate_input()
        2. Perform the skill's core logic
        3. Return a SkillResult with success/failure status

        Args:
            input_data: The data to process (type depends on skill)

        Returns:
            SkillResult with the processing outcome
        """
        pass

    @abstractmethod
    def validate_input(self, input_data: Any) -> bool:
        """
        Validate input before processing.

        Called at the start of process() to ensure input meets requirements.
        Should raise or return False for invalid input.

        Args:
            input_data: The data to validate

        Returns:
            True if input is valid, False otherwise
        """
        pass

    def get_model(self) -> Optional[str]:
        """
        Return which Claude model this skill uses.

        Override in skills that use LLM capabilities.
        Returns None for skills that don't need an LLM.

        Returns:
            Model name string or None
        """
        return None

    def get_skill_name(self) -> str:
        """Return the skill's name for logging and tracking."""
        return self.__class__.__name__

    async def safe_process(self, input_data: Any) -> SkillResult:
        """
        Wrapper around process() that catches exceptions.

        Use this for production to ensure skills never crash the pipeline.
        Failed skills return a SkillResult with success=False.

        Args:
            input_data: The data to process

        Returns:
            SkillResult (always returns, never raises)
        """
        try:
            # Validate input first
            if not self.validate_input(input_data):
                return SkillResult.fail(
                    error="Input validation failed",
                    data=input_data,
                    skill=self.get_skill_name()
                )

            # Process the input
            result = await self.process(input_data)
            result.metadata["skill"] = self.get_skill_name()
            return result

        except Exception as e:
            self.logger.exception(f"Skill {self.get_skill_name()} failed with exception")
            return SkillResult.fail(
                error=f"Exception in {self.get_skill_name()}: {str(e)}",
                data=input_data,
                skill=self.get_skill_name(),
                exception_type=type(e).__name__
            )

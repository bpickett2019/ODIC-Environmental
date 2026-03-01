"""
ODIC ESA Pipeline - LLM Router

Routes tasks to Anthropic Claude API with model selection:
- claude-haiku-4-5-20251001: Fast classification, metadata extraction (cheap + fast)
- claude-sonnet-4-5-20250929: Report assembly, QA analysis, reasoning (accurate + thoughtful)

Authentication priority:
1. ANTHROPIC_API_KEY environment variable (standard API key)
2. Claude Code OAuth token from macOS Keychain (Max/Pro subscription)
"""

import os
import json
import time
import asyncio
import logging
import subprocess
import platform
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


def _get_claude_oauth_token() -> Optional[str]:
    """
    Read Claude Code's OAuth access token from macOS Keychain.

    This allows using a Claude Max/Pro subscription for API calls
    without a separate API key. Checks multiple keychain entries
    and prefers the one with an active subscription.

    Returns:
        The OAuth access token string, or None if unavailable.
    """
    if platform.system() != "Darwin":
        return None

    # Check both credential entries — prefer the one with a subscription
    keychain_services = [
        "Claude Code-credentials",            # Primary (usually has subscription)
        "Claude Code-credentials-f05cef81",   # Secondary
    ]

    for service in keychain_services:
        try:
            result = subprocess.run(
                [
                    "security", "find-generic-password",
                    "-s", service,
                    "-w"
                ],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode != 0:
                continue

            creds = json.loads(result.stdout.strip())
            oauth_data = creds.get("claudeAiOauth", {})
            access_token = oauth_data.get("accessToken")

            if not access_token:
                continue

            # Check expiry
            expires_at = oauth_data.get("expiresAt", 0)
            now_ms = int(time.time() * 1000)
            if expires_at <= now_ms:
                logger.warning(
                    f"Claude OAuth token from '{service}' expired — "
                    "open Claude Code to refresh it"
                )
                continue

            sub_type = oauth_data.get("subscriptionType")
            logger.info(
                f"Using Claude OAuth token from macOS Keychain "
                f"(subscription: {sub_type or 'unknown'})"
            )
            return access_token

        except Exception as e:
            logger.debug(f"Could not read OAuth from '{service}': {e}")
            continue

    return None


class LLMRouter:
    """
    Routes LLM tasks to Anthropic Claude API with model routing.

    Model routing by complexity:
    - Haiku: classification, renaming, simple extraction (fast + cheap)
    - Sonnet: report assembly, QA validation, reasoning (accurate + thoughtful)
    """

    # Task-to-model mapping
    TASK_MODEL_MAP = {
        "classify": "classifier_model",      # Haiku
        "extract": "classifier_model",        # Haiku
        "rename": "classifier_model",         # Haiku
        "assemble": "reasoning_model",        # Sonnet
        "qa_check": "reasoning_model",        # Sonnet
        "summarize": "reasoning_model",       # Sonnet
        "notify_draft": "classifier_model",   # Haiku
    }

    def __init__(self, config: dict = None):
        """
        Initialize the router with configuration.

        Args:
            config: Optional config dict with llm settings
        """
        self.config = config or {}
        llm_config = self.config.get("llm", {})

        # Auth priority:
        # 1. Claude Code OAuth token from macOS Keychain (Max/Pro subscription)
        # 2. ANTHROPIC_API_KEY env var
        # 3. Custom env var from config
        self._using_oauth = False
        self.api_key = None

        # Try OAuth first (preferred — uses Max/Pro subscription)
        oauth_token = _get_claude_oauth_token()
        if oauth_token:
            self.api_key = oauth_token
            self._using_oauth = True
        else:
            # Fall back to API key
            api_key_env = llm_config.get("api_key_env", "ANTHROPIC_API_KEY")
            self.api_key = (
                os.environ.get("ANTHROPIC_API_KEY") or
                os.environ.get(api_key_env, "") or
                llm_config.get("api_key", "")
            )

        # Model configuration
        self.classifier_model = llm_config.get(
            "classifier_model", "claude-haiku-4-5-20251001"
        )
        self.reasoning_model = llm_config.get(
            "reasoning_model", "claude-sonnet-4-5-20250929"
        )
        # Default model (used by legacy code that reads self.model)
        self.model = self.reasoning_model
        self.base_url = "https://api.anthropic.com"

        self.max_retries = llm_config.get("max_retries", 3)
        self.timeout = llm_config.get("timeout_seconds", 120)

        # Initialize Anthropic clients
        self.client = None
        self.async_client = None

        if self.api_key:
            try:
                from anthropic import Anthropic, AsyncAnthropic

                # OAuth tokens use auth_token (Bearer header)
                # API keys use api_key (x-api-key header)
                if self._using_oauth:
                    # OAuth requires the beta header to be accepted
                    oauth_headers = {
                        "anthropic-beta": "oauth-2025-04-20",
                    }
                    # Temporarily mask ANTHROPIC_API_KEY so the SDK
                    # doesn't auto-read it and override our OAuth token
                    saved_key = os.environ.pop("ANTHROPIC_API_KEY", None)
                    try:
                        self.client = Anthropic(
                            auth_token=self.api_key,
                            default_headers=oauth_headers,
                            timeout=self.timeout
                        )
                        self.async_client = AsyncAnthropic(
                            auth_token=self.api_key,
                            default_headers=oauth_headers,
                            timeout=self.timeout
                        )
                    finally:
                        if saved_key is not None:
                            os.environ["ANTHROPIC_API_KEY"] = saved_key
                else:
                    self.client = Anthropic(
                        api_key=self.api_key,
                        timeout=self.timeout
                    )
                    self.async_client = AsyncAnthropic(
                        api_key=self.api_key,
                        timeout=self.timeout
                    )

                auth_label = "OAuth (Max/Pro)" if self._using_oauth else "API key"
                logger.info(
                    f"LLM Router initialized with Anthropic Claude via {auth_label} "
                    f"(Haiku: {self.classifier_model}, "
                    f"Sonnet: {self.reasoning_model})"
                )
            except ImportError:
                logger.error(
                    "anthropic package not installed. Run: pip install anthropic"
                )
                self.client = None
                self.async_client = None
        else:
            logger.warning(
                "No AI API key configured. "
                "Set ANTHROPIC_API_KEY environment variable, "
                "or open Claude Code to refresh OAuth."
            )

    def is_configured(self) -> bool:
        """Check if AI is configured and available."""
        return self.client is not None

    def is_available(self) -> bool:
        """Alias for is_configured for compatibility."""
        return self.is_configured()

    def get_auth_mode(self) -> str:
        """Return the authentication mode."""
        if self.is_configured():
            return "claude_oauth" if self._using_oauth else "anthropic_api_key"
        return "none"

    def get_model_for_task(self, task_type: str) -> str:
        """Get the appropriate model for a task type."""
        model_key = self.TASK_MODEL_MAP.get(task_type, "reasoning_model")
        if model_key == "classifier_model":
            return self.classifier_model
        return self.reasoning_model

    def get_model_info(self) -> Dict[str, str]:
        """Return model information for different task types."""
        return {
            "classify": self.classifier_model,
            "extract": self.classifier_model,
            "rename": self.classifier_model,
            "qa_check": self.reasoning_model,
            "analyze": self.reasoning_model,
            "assemble": self.reasoning_model,
            "summarize": self.reasoning_model,
        }

    def classify(self, system_prompt: str, user_content: str) -> Dict[str, Any]:
        """
        Fast classification call using Haiku.

        Args:
            system_prompt: System prompt for the classification task
            user_content: User content to classify

        Returns:
            Dict with content, success, model keys
        """
        return self._call(
            system_prompt, user_content,
            temperature=0.1, model=self.classifier_model
        )

    def analyze(self, system_prompt: str, user_content: str) -> Dict[str, Any]:
        """
        Deep analysis call using Sonnet.

        Args:
            system_prompt: System prompt for the analysis task
            user_content: Content to analyze

        Returns:
            Dict with content, success, model keys
        """
        return self._call(
            system_prompt, user_content,
            temperature=0.3, model=self.reasoning_model
        )

    async def aclassify(
        self, system_prompt: str, user_content: str
    ) -> Dict[str, Any]:
        """Async fast classification using Haiku."""
        return await self._acall(
            system_prompt, user_content,
            temperature=0.1, model=self.classifier_model
        )

    async def aanalyze(
        self, system_prompt: str, user_content: str
    ) -> Dict[str, Any]:
        """Async deep analysis using Sonnet."""
        return await self._acall(
            system_prompt, user_content,
            temperature=0.3, model=self.reasoning_model
        )

    async def complete(
        self,
        task_type: str,
        messages: list,
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Complete method compatible with existing skill code.

        Routes to the appropriate Claude model based on task_type.

        Args:
            task_type: Type of task (classify, qa_check, assemble, etc.)
            messages: List of message dicts with role and content
            system: Optional system prompt
            max_tokens: Maximum tokens in response
            temperature: Sampling temperature

        Returns:
            Dict with content, model, task_type, usage keys
        """
        # Select model based on task type
        model = self.get_model_for_task(task_type)

        # Determine temperature based on task type
        temp = 0.1 if task_type in ["classify", "extract", "rename"] else temperature

        # Extract user content from messages
        user_content = ""
        for msg in messages:
            if msg.get("role") == "user":
                user_content = msg.get("content", "")
                break

        # Use system prompt if provided, otherwise use a default
        system_prompt = (
            system or
            "You are a document classification expert for environmental "
            "consulting. Respond with JSON when asked."
        )

        result = await self._acall(
            system_prompt, user_content,
            temperature=temp, max_tokens=max_tokens, model=model
        )

        return {
            "content": result.get("content", ""),
            "model": model,
            "task_type": task_type,
            "usage": result.get("usage", {"input_tokens": 0, "output_tokens": 0}),
            "stop_reason": "end_turn" if result.get("success") else "error",
            "auth_mode": "anthropic_api",
            "success": result.get("success", False),
            "error": result.get("error"),
        }

    def complete_sync(
        self,
        task_type: str,
        messages: list,
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        **kwargs
    ) -> Dict[str, Any]:
        """Synchronous version of complete() for legacy compatibility."""
        model = self.get_model_for_task(task_type)
        temp = 0.1 if task_type in ["classify", "extract", "rename"] else temperature

        user_content = ""
        for msg in messages:
            if msg.get("role") == "user":
                user_content = msg.get("content", "")
                break

        system_prompt = (
            system or
            "You are a document classification expert for environmental "
            "consulting. Respond with JSON when asked."
        )

        result = self._call(
            system_prompt, user_content,
            temperature=temp, max_tokens=max_tokens, model=model
        )

        return {
            "content": result.get("content", ""),
            "model": model,
            "task_type": task_type,
            "usage": result.get("usage", {"input_tokens": 0, "output_tokens": 0}),
            "stop_reason": "end_turn" if result.get("success") else "error",
            "auth_mode": "anthropic_api",
            "success": result.get("success", False),
            "error": result.get("error"),
        }

    def _call(
        self,
        system_prompt: str,
        user_content: str,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        model: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Synchronous Anthropic API call with retry logic.

        Args:
            system_prompt: System prompt
            user_content: User content
            temperature: Sampling temperature
            max_tokens: Maximum tokens in response
            model: Model to use (defaults to reasoning_model)

        Returns:
            Dict with content, success, model keys
        """
        if not self.client:
            return {
                "error": "AI not configured. Set ANTHROPIC_API_KEY.",
                "success": False
            }

        model = model or self.reasoning_model

        for attempt in range(self.max_retries):
            try:
                response = self.client.messages.create(
                    model=model,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_content}],
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
                content = response.content[0].text
                usage = {
                    "input_tokens": response.usage.input_tokens,
                    "output_tokens": response.usage.output_tokens
                }
                return {
                    "content": content,
                    "success": True,
                    "model": model,
                    "usage": usage
                }
            except Exception as e:
                logger.error(f"LLM call attempt {attempt + 1} failed: {e}")
                if attempt < self.max_retries - 1:
                    time.sleep(2 ** attempt)
                else:
                    return {"error": str(e), "success": False}

        return {"error": "Max retries exceeded", "success": False}

    async def _acall(
        self,
        system_prompt: str,
        user_content: str,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        model: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Async Anthropic API call with retry logic.

        Args:
            system_prompt: System prompt
            user_content: User content
            temperature: Sampling temperature
            max_tokens: Maximum tokens in response
            model: Model to use (defaults to reasoning_model)

        Returns:
            Dict with content, success, model keys
        """
        if not self.async_client:
            return {
                "error": "AI not configured. Set ANTHROPIC_API_KEY.",
                "success": False
            }

        model = model or self.reasoning_model

        for attempt in range(self.max_retries):
            try:
                response = await self.async_client.messages.create(
                    model=model,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_content}],
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
                content = response.content[0].text
                usage = {
                    "input_tokens": response.usage.input_tokens,
                    "output_tokens": response.usage.output_tokens
                }
                return {
                    "content": content,
                    "success": True,
                    "model": model,
                    "usage": usage
                }
            except Exception as e:
                logger.error(
                    f"Async LLM call attempt {attempt + 1} failed: {e}"
                )
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(2 ** attempt)
                else:
                    return {"error": str(e), "success": False}

        return {"error": "Max retries exceeded", "success": False}

"""LLM Router — Anthropic Claude with OAuth (Max subscription) + API key fallback."""

import asyncio
import json
import logging
import os
import platform
import subprocess
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("esa.llm")


def _get_claude_oauth_token() -> Optional[str]:
    """Read Claude Code's OAuth access token from macOS Keychain."""
    if platform.system() != "Darwin":
        return None

    keychain_services = [
        "Claude Code-credentials",
        "Claude Code-credentials-f05cef81",
    ]

    for service in keychain_services:
        try:
            result = subprocess.run(
                ["security", "find-generic-password", "-s", service, "-w"],
                capture_output=True, text=True, timeout=5,
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
            if expires_at <= int(time.time() * 1000):
                logger.warning(f"OAuth token from '{service}' expired — open Claude Code to refresh")
                continue

            sub_type = oauth_data.get("subscriptionType")
            logger.info(f"Using Claude OAuth from Keychain (subscription: {sub_type or 'unknown'})")
            return access_token

        except Exception as e:
            logger.debug(f"Could not read OAuth from '{service}': {e}")

    return None


class LLMRouter:
    """Routes LLM tasks to Anthropic Claude API.

    Auth priority: OAuth (Max/Pro) first, then ANTHROPIC_API_KEY fallback.
    Model routing: Haiku for classification, Sonnet for reasoning/QA.
    """

    def __init__(self):
        self._using_oauth = False
        self.api_key = None
        self.client = None
        self.async_client = None

        self.classifier_model = "claude-haiku-4-5-20251001"
        self.reasoning_model = "claude-sonnet-4-5-20250929"
        self.max_retries = 3
        self.timeout = 120

        # Try OAuth first
        oauth_token = _get_claude_oauth_token()
        if oauth_token:
            self.api_key = oauth_token
            self._using_oauth = True
        else:
            self.api_key = os.environ.get("ANTHROPIC_API_KEY", "")

        if self.api_key:
            try:
                from anthropic import Anthropic, AsyncAnthropic

                if self._using_oauth:
                    oauth_headers = {"anthropic-beta": "oauth-2025-04-20"}
                    saved_key = os.environ.pop("ANTHROPIC_API_KEY", None)
                    try:
                        self.client = Anthropic(
                            auth_token=self.api_key,
                            default_headers=oauth_headers,
                            timeout=self.timeout,
                        )
                        self.async_client = AsyncAnthropic(
                            auth_token=self.api_key,
                            default_headers=oauth_headers,
                            timeout=self.timeout,
                        )
                    finally:
                        if saved_key is not None:
                            os.environ["ANTHROPIC_API_KEY"] = saved_key
                else:
                    self.client = Anthropic(api_key=self.api_key, timeout=self.timeout)
                    self.async_client = AsyncAnthropic(api_key=self.api_key, timeout=self.timeout)

                auth_label = "OAuth (Max)" if self._using_oauth else "API key"
                logger.info(
                    f"LLM ready via {auth_label} "
                    f"(Haiku: {self.classifier_model}, Sonnet: {self.reasoning_model})"
                )
            except ImportError:
                logger.error("anthropic package not installed — pip install anthropic")
        else:
            logger.warning("No Claude auth — set ANTHROPIC_API_KEY or open Claude Code for OAuth")

    @property
    def available(self) -> bool:
        return self.async_client is not None

    async def complete(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.3,
        max_tokens: int = 2000,
        task_type: str = "classify",
    ) -> Optional[str]:
        """Send a completion request. Returns None if unavailable.

        task_type controls model routing:
        - "classify", "extract": uses Haiku (fast + cheap)
        - "qa", "assemble", "reasoning": uses Sonnet (accurate)
        """
        if not self.async_client:
            return None

        model = self.classifier_model if task_type in ("classify", "extract") else self.reasoning_model

        for attempt in range(self.max_retries):
            try:
                response = await self.async_client.messages.create(
                    model=model,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_prompt}],
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
                content = response.content[0].text
                usage = response.usage
                logger.info(
                    f"LLM call OK: model={model}, "
                    f"in={usage.input_tokens} out={usage.output_tokens}"
                )
                return content
            except Exception as e:
                logger.error(f"LLM call attempt {attempt + 1} failed: {e}")
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(2 ** attempt)

        return None

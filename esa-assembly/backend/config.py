"""Configuration loaded from environment variables."""

import os
from pathlib import Path

BASE_DIR = Path(__file__).parent
PROJECTS_DIR = BASE_DIR / "projects"
UPLOADS_DIR = BASE_DIR / "uploads"

PROJECTS_DIR.mkdir(exist_ok=True)
UPLOADS_DIR.mkdir(exist_ok=True)

# LLM settings (OpenAI-compatible)
OPENAI_API_BASE = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# Upload limits
MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024  # 2GB
CHUNK_SIZE = 1024 * 1024  # 1MB chunks

# Export settings
MAX_EXPORT_SIZE = 25 * 1024 * 1024  # 25MB per split
IMAGE_MAX_DPI = 300

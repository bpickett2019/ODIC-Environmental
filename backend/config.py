import os
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Paths
    BASE_DIR: Path = Path(__file__).parent
    UPLOAD_DIR: Path = BASE_DIR / "uploads"
    DATABASE_URL: str = f"sqlite:///{BASE_DIR / 'reports.db'}"

    # AI Classification backend: "ollama", "anthropic", or "none"
    AI_BACKEND: str = "ollama"

    # Ollama (default, free, local)
    # For Railway: Make sure Ollama is running and accessible
    # For local Docker: Use host.docker.internal:11434 instead
    OLLAMA_URL: str = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    OLLAMA_MODEL: str = "qwen2.5:7b"
    OLLAMA_VL_MODEL: str = "qwen2.5vl:7b"  # Vision-language model for scanned PDFs
    OLLAMA_CONCURRENCY: int = 8              # Max concurrent Ollama calls during classification

    # Anthropic Claude API (production recommendation)
    ANTHROPIC_API_KEY: str = os.environ.get("ANTHROPIC_API_KEY", "")
    CLAUDE_MODEL: str = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-20250514")

    # External tools
    LIBREOFFICE_PATH: str = os.environ.get("LIBREOFFICE_PATH", "soffice")
    GHOSTSCRIPT_PATH: str = os.environ.get("GHOSTSCRIPT_PATH", "gs")
    TESSERACT_PATH: str = os.environ.get("TESSERACT_PATH", "tesseract")

    # Compression defaults
    COMPRESSION_DPI: int = 150
    MAX_EMAIL_SIZE_MB: int = 10
    MAX_STANDARD_SIZE_MB: int = 25

    # Report template section order
    SECTION_ORDER: list[str] = [
        "RELIANCE_LETTER",
        "EO_INSURANCE",
        "COVER_WRITEUP",
        "APPENDIX_A",
        "APPENDIX_B",
        "APPENDIX_C",
        "APPENDIX_D",
        "APPENDIX_E",
        "REPORTS_AFTER_E",
        "APPENDIX_F",
    ]

    # Appendix D sub-order
    APPENDIX_D_ORDER: list[str] = [
        "sanborn",
        "aerials",
        "topos",
        "city_directory",
    ]

    # File types to skip
    SKIP_EXTENSIONS: set[str] = {".mov", ".mp4", ".avi", ".db", ".dbf"}
    SUPPORTED_EXTENSIONS: set[str] = {
        ".pdf", ".docx", ".doc", ".heic", ".heif",
        ".jpg", ".jpeg", ".png", ".tiff", ".tif",
        ".vsd", ".vsdx", ".txt", ".zip",
    }

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

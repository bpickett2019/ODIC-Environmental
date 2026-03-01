# ODIC ESA Report Automation Pipeline — Build Prompt

## Context
You are building an automated document processing pipeline for an environmental consulting company (ODIC Environmental) that produces Phase I Environmental Site Assessments (ESAs). The system watches an FTP server for incoming documents, classifies them, organizes them into project folders, and compiles them into final ESA reports following a standard template structure.

## Architecture
Lightweight daemon with a skill-based plugin system. Each processing step is a self-contained, swappable module with a standard interface. Inspired by OpenClaw's skill architecture but purpose-built — no external framework dependencies.

### Design Principles
- Each "skill" is a standalone module with a standard interface: `process(input) -> output`
- Config-driven via YAML — the client's team can adjust settings without touching code
- Daemon pattern — persistent background process watching for new work
- Model routing by complexity (Haiku for cheap/fast, Sonnet for reasoning)
- All skills are independently testable

## Tech Stack
- **Language:** Python 3.11+
- **FTP Monitoring:** paramiko (SFTP) or ftplib + watchdog for local mount
- **LLM:** Anthropic Claude API (claude-haiku-4-5-20251001 for classification, claude-sonnet-4-5-20250929 for reasoning tasks)
- **PDF Processing:** PyPDF2 for reading, ReportLab for assembly, pdfplumber for text extraction
- **Config:** YAML (PyYAML)
- **Logging:** Python logging with structured JSON output
- **Queue:** Simple file-based queue or Redis if needed for scale
- **API/UI (optional):** FastAPI for status endpoints

## Project Structure

```
odic-esa-pipeline/
├── config/
│   ├── config.yaml              # Main configuration
│   ├── esa_template.yaml        # ESA report section structure/ordering
│   └── document_types.yaml      # Document classification definitions
├── skills/
│   ├── base.py                  # Abstract base skill interface
│   ├── ftp_watcher.py           # Monitors FTP for new files
│   ├── document_classifier.py   # Classifies documents (Haiku)
│   ├── file_organizer.py        # Renames and sorts into project folders
│   ├── report_assembler.py      # Compiles final ESA PDF (Sonnet)
│   ├── qa_checker.py            # Validates completeness (Sonnet)
│   └── notifier.py              # Sends completion notifications
├── core/
│   ├── daemon.py                # Main daemon process
│   ├── pipeline.py              # Orchestrates skill execution order
│   ├── llm_router.py            # Routes to Haiku vs Sonnet based on task
│   └── state.py                 # Tracks project/document state
├── templates/
│   └── phase1_esa/              # ESA report templates
│       ├── cover_page.py
│       ├── toc.py
│       └── section_templates/
├── tests/
│   ├── test_classifier.py
│   ├── test_assembler.py
│   ├── test_qa.py
│   └── fixtures/                # Sample PDFs for testing
├── main.py                      # Entry point
├── requirements.txt
├── docker-compose.yaml          # For deployment
├── Dockerfile
└── README.md
```

## Skill Interface (base.py)

Every skill must implement this interface:

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, Optional
import logging

@dataclass
class SkillResult:
    success: bool
    data: Any
    error: Optional[str] = None
    metadata: Dict = None

class BaseSkill(ABC):
    def __init__(self, config: dict):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)

    @abstractmethod
    async def process(self, input_data: Any) -> SkillResult:
        """Process input and return result."""
        pass

    @abstractmethod
    def validate_input(self, input_data: Any) -> bool:
        """Validate input before processing."""
        pass

    def get_model(self) -> str:
        """Return which Claude model this skill uses. Override per skill."""
        return None  # No LLM needed by default
```

## Pipeline Flow

```
FTP Watcher (no LLM)
    ↓ new file detected
Document Classifier (Haiku)
    ↓ returns: {type: "sanborn_map", confidence: 0.97, project_id: "ODIC-2024-001"}
File Organizer (no LLM)
    ↓ moves/renames file into project folder structure
    ↓ checks: are all required documents present for this project?
Report Assembler (Sonnet) — triggered when all docs present
    ↓ compiles PDF following ESA template section order
QA Checker (Sonnet)
    ↓ validates: completeness, section ordering, required elements
    ↓ returns: {pass: true} or {pass: false, missing: ["Section 4.2", ...]}
Notifier (no LLM)
    ↓ emails/Slack notification to Eric's team with status
```

## Document Types to Classify

The classifier must identify these document types that appear in Phase I ESAs:

- **Sanborn Fire Insurance Maps** — historical land use maps
- **Topographic Maps** — USGS topo maps of the site area
- **Aerial Photographs** — historical aerial imagery
- **City Directories** — historical business/resident listings
- **Fire Insurance Maps (non-Sanborn)** — other fire insurance providers
- **Environmental Database Reports (EDR)** — regulatory database search results
- **Title Records** — property ownership history
- **Tax Records** — property tax documentation
- **Building Permits** — construction/renovation history
- **Site Photographs** — current condition photos from site visit
- **Regulatory Correspondence** — letters from EPA, state agencies
- **Prior Environmental Reports** — previous Phase I, Phase II, etc.
- **Client Correspondence** — emails, letters from the client
- **Lab Results** — soil, water, air sampling data (Phase II)
- **Other/Unknown** — flag for manual review

## Config File (config.yaml)

```yaml
ftp:
  host: ""           # ODIC's FTP server
  port: 22
  username: ""
  password: ""
  watch_directory: "/incoming"
  poll_interval_seconds: 30

llm:
  api_key_env: "ANTHROPIC_API_KEY"    # Read from env var
  classifier_model: "claude-haiku-4-5-20251001"
  reasoning_model: "claude-sonnet-4-5-20250929"
  max_retries: 3
  timeout_seconds: 60

pipeline:
  project_base_dir: "./projects"
  output_dir: "./completed_reports"
  max_concurrent_projects: 5
  auto_assemble_when_complete: true

qa:
  minimum_sections_required: 8
  require_site_photos: true
  require_edr: true
  require_topo: true

notifications:
  type: "email"       # email, slack, or both
  recipients: []
  smtp_host: ""
  smtp_port: 587
```

## ESA Template Section Order (esa_template.yaml)

```yaml
phase1_esa:
  sections:
    - id: cover_page
      name: "Cover Page"
      required: true
    - id: toc
      name: "Table of Contents"
      required: true
      auto_generated: true
    - id: executive_summary
      name: "Executive Summary"
      required: true
    - id: introduction
      name: "1.0 Introduction"
      required: true
    - id: site_description
      name: "2.0 Site Description"
      required: true
    - id: user_provided_info
      name: "3.0 User Provided Information"
      required: true
    - id: records_review
      name: "4.0 Records Review"
      required: true
      sub_sections:
        - id: edr_report
          name: "4.1 Environmental Database Report"
          doc_types: ["edr"]
        - id: regulatory_records
          name: "4.2 Regulatory Agency Records"
          doc_types: ["regulatory_correspondence"]
        - id: historical_use
          name: "4.3 Historical Use Information"
          doc_types: ["sanborn_map", "city_directory", "fire_insurance_map"]
    - id: historical_review
      name: "5.0 Historical Review"
      required: true
      sub_sections:
        - id: aerial_photos
          name: "5.1 Aerial Photographs"
          doc_types: ["aerial_photograph"]
        - id: topo_maps
          name: "5.2 Topographic Maps"
          doc_types: ["topographic_map"]
        - id: sanborn_maps
          name: "5.3 Sanborn Maps"
          doc_types: ["sanborn_map"]
    - id: site_reconnaissance
      name: "6.0 Site Reconnaissance"
      required: true
      doc_types: ["site_photograph"]
    - id: findings
      name: "7.0 Findings and Opinions"
      required: true
    - id: conclusions
      name: "8.0 Conclusions"
      required: true
    - id: appendices
      name: "Appendices"
      required: true
      sub_sections:
        - id: appendix_a
          name: "Appendix A - Site Photographs"
          doc_types: ["site_photograph"]
        - id: appendix_b
          name: "Appendix B - Historical Maps and Aerials"
          doc_types: ["sanborn_map", "topographic_map", "aerial_photograph"]
        - id: appendix_c
          name: "Appendix C - EDR Report"
          doc_types: ["edr"]
        - id: appendix_d
          name: "Appendix D - Regulatory Correspondence"
          doc_types: ["regulatory_correspondence"]
```

## LLM Router (llm_router.py)

```python
# Route to appropriate model based on task complexity
# Haiku: classification, renaming, simple extraction — fast + cheap
# Sonnet: report assembly, QA validation, reasoning — accurate + thoughtful

class LLMRouter:
    TASK_MODEL_MAP = {
        "classify": "classifier_model",      # Haiku
        "extract": "classifier_model",        # Haiku
        "rename": "classifier_model",         # Haiku
        "assemble": "reasoning_model",        # Sonnet
        "qa_check": "reasoning_model",        # Sonnet
        "summarize": "reasoning_model",       # Sonnet
        "notify_draft": "classifier_model",   # Haiku
    }
```

## Critical Requirements

1. **99% classification accuracy in production** — build confidence scoring into the classifier. Anything below 90% confidence gets flagged for manual review instead of auto-sorted.
2. **Never lose a document** — if any skill fails, the document stays in a `/failed` queue with full error logging. No silent drops.
3. **Idempotent processing** — re-running on the same file should not create duplicates.
4. **State persistence** — track which documents have been processed, which projects are complete, what's pending. Use SQLite or a simple JSON state file.
5. **Graceful degradation** — if the API is down, queue documents and retry. Don't crash the daemon.
6. **Chunking strategy** — Claude's context window is 200K tokens (~300 pages). For documents larger than 250 pages, implement chunking with overlap for classification. For report assembly, process section by section.

## Build Order

1. `base.py` — skill interface
2. `llm_router.py` — model routing
3. `document_classifier.py` — get classification working first with test PDFs
4. `file_organizer.py` — folder structure and renaming
5. `ftp_watcher.py` — FTP monitoring
6. `state.py` — state tracking
7. `pipeline.py` — orchestration
8. `report_assembler.py` — PDF compilation
9. `qa_checker.py` — validation
10. `notifier.py` — notifications
11. `daemon.py` — main daemon
12. `main.py` — entry point
13. Docker setup
14. Tests

## What NOT to Build

- No web UI yet — CLI and config files only for v1
- No user auth — single-tenant, runs on ODIC's infrastructure or yours
- No multi-LLM provider support — Anthropic only
- No skill marketplace — hardcoded pipeline for now
- No browser automation — FTP and API only for v1


<claude-mem-context>
# Recent Activity

### Feb 16, 2026

| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #282 | 11:10 PM | 🔵 | ODIC ESA Pipeline TypeScript Project Structure | ~350 |
</claude-mem-context>
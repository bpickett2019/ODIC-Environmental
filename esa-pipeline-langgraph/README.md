# ESA Pipeline - LangGraph Document Assembly & QC

AI-powered document assembly and quality control system for Environmental Site Assessment (ESA) reports. Built with LangGraph for deterministic pipeline orchestration with AI validation checkpoints.

## Overview

This system automates the compilation of Phase I and Phase II ESA reports from 30+ source documents. It replaces a manual process that takes 20-30 minutes per report with an automated pipeline that requires only ~5 minutes of human review time.

### Key Features

- **6-Stage LangGraph Pipeline**: INGEST → CLASSIFY → STRUCTURE → ASSEMBLE → VERIFY → QC → EXPORT
- **3-Tier Confidence System**: Automatic routing of AI decisions based on confidence + risk
- **AI-Powered Classification**: Uses Claude to classify documents into ESA taxonomy with confidence scoring
- **5 Parallel QC Validators**: Completeness, Cross-contamination, Structure, Content Integrity, Format
- **Human-in-the-Loop**: LangGraph `interrupt()` for classification review, appendix ordering, QC resolution
- **Page Count Reconciliation**: Hard gate ensuring zero lost pages (assembled pages == source pages)
- **SQLite Checkpointing**: Pause/resume pipeline, handle interruptions, roll back to previous stages
- **Intelligent File Splitting**: Auto-split at appendix boundaries when reports exceed 25MB

## 3-Tier Confidence System

Every AI decision in the pipeline is evaluated with both a **confidence score** and a **risk level**. The combination determines which tier the decision falls into:

### Tier 1: Auto-Approve (Green Lane)
- **Criteria**: Confidence >= 95% AND Risk = LOW
- **Actions**: Deterministic tasks like page counting, format detection, deduplication
- **Behavior**: System executes and logs silently
- **Example**: "Detected 47 pages in uploaded PDF" (100% confidence, low risk)

### Tier 2: Audit Trail (Yellow Lane)
- **Criteria**: Confidence >= 90% AND Risk = MEDIUM
- **Actions**: Classification of clear document types, format validation
- **Behavior**: Auto-approves BUT generates detailed audit entry
- **Escalation**: If 3+ medium-risk decisions score 90-94%, escalates to Tier 3
- **Example**: "Classified as Appendix C - EDR Report" (92% confidence, medium risk)

### Tier 3: Human Review (Red Lane)
- **Criteria**: Confidence < 90% OR Risk = HIGH
- **Actions**: Cross-contamination detection, missing sections, content integrity
- **Behavior**: System PAUSES and waits for human confirmation
- **Example**: "Potential cross-contamination: found 'ABC Corp' but project client is 'XYZ Inc'" (85% confidence, high risk)

### Risk Classification

| Risk Level | Description | Examples |
|------------|-------------|----------|
| **LOW** | Deterministic operations | Page counts, file hashes, format detection |
| **MEDIUM** | Classification, validation | Document type classification, structure validation |
| **HIGH** | Cross-contamination, content integrity | Project ID mismatch, missing required sections |

### Decision Tracking

All AI decisions are tracked in the pipeline state with:
- Timestamp
- Stage (CLASSIFY, STRUCTURE, QC, etc.)
- Action description
- Tier classification
- Confidence score
- Risk level
- Reasoning (for audit trail)
- Details (additional context)

The frontend displays these in the **Decision Log** component with filtering by tier.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (NextJS)                         │
│  File Upload → Classification Review → Appendix Order → QC → Export │
└─────────────────────────────────────────────────────────────────┘
                               │ WebSocket
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Backend (FastAPI)                           │
│                    REST API + WebSocket                          │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   LangGraph Pipeline                             │
│                                                                  │
│  ┌─────────┐   ┌──────────┐   ┌───────────┐   ┌──────────┐     │
│  │ INGEST  │ → │ CLASSIFY │ → │ STRUCTURE │ → │ ASSEMBLE │     │
│  └─────────┘   └──────────┘   └───────────┘   └──────────┘     │
│       │              │              │              │             │
│       │         ▼ interrupt    ▼ interrupt         │             │
│       │        Human Review   Appendix Order       │             │
│       │                                            ▼             │
│       │                                      ┌──────────┐        │
│       │                                      │  VERIFY  │        │
│       │                                      └──────────┘        │
│       │                                           │              │
│       │                                      ▼ interrupt         │
│       │                                    AI Verification       │
│       │                                           │              │
│       │        ┌────────┐   ┌────────┐           │              │
│       └──────→ │   QC   │ → │ EXPORT │ ◀─────────┘              │
│                └────────┘   └────────┘                          │
│                     │            │                               │
│                ▼ interrupt   ▼ interrupt                        │
│               QC Resolution  Final Signoff                      │
│                                                                  │
│  [SQLite Checkpointing + 3-Tier Decision Tracking]              │
└─────────────────────────────────────────────────────────────────┘
```

## Pipeline Stages

### 1. INGEST
- Accepts PDF, DOCX, JPG/PNG/TIFF uploads
- Extracts text using PyMuPDF and python-docx
- OCR via Tesseract for scanned documents
- Generates file hashes for deduplication
- Tags every file with project_id (cross-contamination prevention)

### 2. CLASSIFY (Dual-Pass Validation)
- **Pass 1**: Initial AI classification with confidence scoring (GPT-4o)
- **Pass 2**: Independent verification classification
- **Tiebreaker**: Resolves disagreements between passes
- Categories: main_body, appendix, supporting_record, excluded
- Distinguishes current report content from prior reports by other firms
- Confidence scoring with <90% threshold for human review
- Automatic approval for agreements ≥95% confidence

### 3. STRUCTURE
- Maps documents to ASTM E1527-21 template (Phase I) or Phase II template
- Detects missing required sections
- Proposes appendix ordering (A, B, C, etc.)
- Human-in-the-loop for appendix reordering (drag-drop)
- Outputs completeness score with blocking issues vs warnings

### 4. ASSEMBLE
- Merges PDFs in template order
- Page count validation (CRITICAL: assembled pages must equal source pages)
- Generates page mapping for TOC
- Triggers remediation if page mismatch detected

### 5. VERIFY (AI Verification)
- AI-generated verification report before human QC
- Section-by-section completeness check
- Confidence scoring per section with 3-tier classification
- Executive summary of report status
- Flags and recommendations
- Auto-approval for high-confidence reports (Tier 1)
- Human review interrupt for lower confidence (Tier 3)

### 6. QC (Quality Control)
Five parallel sub-validators:

| Validator | Checks |
|-----------|--------|
| **Completeness** | All sections present, no blanks, page reconciliation |
| **Cross-contamination** | Mismatched project IDs, addresses, company names |
| **Structure** | TOC accuracy, section ordering, appendix labels |
| **Content Integrity** | Executive summary matches findings (AI-powered) |
| **Format** | Consistent fonts/headers, no corruption |

- Each outputs individual score
- Weighted aggregate for overall pass/fail
- Specific actionable issues with locations
- Auto-fix option for fixable issues
- **Self-Correction Loops**: Up to 3 retries per validator
  - Validate → Auto-fix issues → Re-validate
  - 95%+ self-correction rate target
  - Escalates to human review after 3 failed attempts

### 7. EXPORT
- PDF output (primary)
- Intelligent splitting at appendix boundaries if >25MB
- QC summary document generation
- Final sign-off before delivery

## Frontend Components

### Decision Log
Real-time display of all AI decisions with:
- Tier badges (Tier 1/2/3 with color coding)
- Filter by tier
- Expandable details for each decision
- Confidence percentages
- Timestamps and stage indicators

### Completeness Report
Section-by-section progress display:
- Main sections vs appendices separation
- Status indicators (found/missing/partial)
- Confidence bars with tier classification
- AI summaries per section
- Issue details for flagged sections
- Filter to show only issues

### Verification Report
AI verification results display:
- Overall status with confidence percentage
- Stats bar (sections found/missing/total)
- Executive summary
- Flags requiring attention
- Expandable section checklist
- Recommendations list
- Raw markdown report toggle
- Approve/Request Changes actions

## Installation

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows
pip install -r requirements.txt

# Copy and configure environment
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY

# Run the server
uvicorn src.api.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000

## Usage (Rose's Workflow)

1. **Create Project**: Enter project ID, site address, report type (Phase I/II)
2. **Upload Files**: Drag-drop documents from FTP folder (any format)
3. **Review Classifications**: AI shows what it thinks each file is; confirm or correct flagged items
4. **Review Structure**: See proposed report order; drag-drop to reorder appendices
5. **Assemble**: One click; runs in background so you can work on another report
6. **Review QC Results**: See pass/fail with specific issues; click "auto-fix" or handle manually
7. **Export**: Choose format; auto-splits if needed; download final report

## API Endpoints

### Projects
- `POST /projects` - Create new project
- `GET /projects/{id}` - Get project status
- `DELETE /projects/{id}` - Delete project

### Files
- `POST /projects/{id}/upload` - Upload single file
- `POST /projects/{id}/upload-multiple` - Upload multiple files

### Pipeline
- `POST /pipeline/start` - Start pipeline for project
- `GET /pipeline/{thread_id}/status` - Get pipeline status
- `POST /pipeline/{thread_id}/resume` - Resume with human input

### Human Input
- `POST /pipeline/{thread_id}/classification-review` - Submit classification decisions
- `POST /pipeline/{thread_id}/appendix-order` - Submit appendix order
- `POST /pipeline/{thread_id}/qc-resolution` - Submit QC resolution
- `POST /pipeline/{thread_id}/final-signoff` - Submit final sign-off

### WebSocket
- `WS /ws/{thread_id}` - Real-time pipeline status updates

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Claude API key | Required |
| `UPLOAD_DIR` | Upload directory | `./uploads` |
| `OUTPUT_DIR` | Assembled reports dir | `./assembled_reports` |
| `EXPORT_DIR` | Export directory | `./exports` |
| `CLASSIFIER_MODEL` | Model for classification | `claude-haiku-4-5-20251001` |
| `REASONING_MODEL` | Model for QC/analysis | `claude-sonnet-4-5-20250929` |

## Technology Stack

- **Orchestration**: LangGraph (Python)
- **LLM**: OpenAI GPT-4o (streaming AI analysis, classification, QC)
- **Backup LLM**: Anthropic Claude (via langchain-anthropic)
- **PDF Processing**: PyMuPDF (fitz)
- **Document Conversion**: python-docx, Pillow
- **OCR**: Tesseract (pytesseract)
- **API**: FastAPI with WebSocket
- **Frontend**: Next.js 14, React, Tailwind CSS
- **State Persistence**: LangGraph SQLite checkpointing
- **Real-time Updates**: WebSocket streaming for live AI "thinking" display

## Success Criteria

- QC accuracy >= 99% on assembled reports
- Page reconciliation = 100% (zero lost pages)
- Rose's active time < 5 minutes per standard report
- Zero false confidence (asks human when unsure)
- Background processing (work on multiple reports)

## License

Proprietary - ODIC Environmental

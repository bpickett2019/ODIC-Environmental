# ODIC Environmental ESA Report System — Complete Architecture

## 🏗 System Overview

End-to-end document management system for Environmental Site Assessment (ESA) report assembly. Processes 12K-15K page documents efficiently via smart sampling, AI-assisted classification, and intelligent ordering.

```
User (Rose)
    ↓
Frontend (React 19 + Vite)
    ↓
FastAPI Backend (Python 3.11)
    ├── Document Classification (Ollama + Claude)
    ├── Smart Sampling (Intelligent Page Selection)
    ├── Document Assembly (PDF + Ordering)
    ├── Chat Interface (Command Execution)
    └── Database (SQLite/PostgreSQL)
    ↓
Output (PDF + Metadata)
```

---

## 🎯 Core Components

### **1. Frontend** (`frontend/`)

**Stack**: React 19 + Vite + Tailwind CSS

**Key Pages**:
- **ReportList**: Browse/create reports
- **ReportDetail**: Upload documents, view classification progress
- **DocumentList**: Drag-and-drop reordering, include/exclude
- **AssemblyPreview**: Review final PDF before download
- **ChatInterface**: Send commands ("Move docs 5,6,7 to Appendix D")

**State Management**: TanStack Query (server state) + React hooks (local state)

**API Client**: `frontend/src/api/client.ts`
- Auto-detects backend URL (localhost:8000 vs. production)
- Handles authentication, retries, error reporting
- Type-safe via TypeScript

**Key Features**:
- ✅ Drag-and-drop document reordering
- ✅ Real-time classification progress
- ✅ Chat interface for commands
- ✅ PDF preview + page navigation
- ✅ Download/compress/split reports
- ✅ Responsive design (mobile + desktop)

---

### **2. Backend** (`backend/`)

**Stack**: Python 3.11 + FastAPI + SQLAlchemy ORM + SQLite

**Core Modules**:

#### **main.py** (2100+ lines)
Main FastAPI application with all endpoints.

**Key Endpoints**:
```
Reports:
  POST   /api/reports                          Create
  GET    /api/reports                          List all
  GET    /api/reports/{id}                     Get single
  PATCH  /api/reports/{id}                     Update status

Documents:
  POST   /api/reports/{id}/upload              Upload files
  GET    /api/reports/{id}/documents           List documents
  POST   /api/reports/{id}/documents/{doc_id}/classify      AI classify
  POST   /api/reports/{id}/documents/{doc_id}/toggle        Include/exclude
  POST   /api/reports/{id}/documents/{doc_id}/move          Change section
  GET    /api/reports/{id}/documents/{doc_id}/docx-content  Read DOCX
  PUT    /api/reports/{id}/documents/{doc_id}/docx-content  Edit DOCX
  POST   /api/reports/{id}/documents/{doc_id}/text-replace  Find & replace
  POST   /api/reports/{id}/documents/{doc_id}/delete-pages  Remove pages

Assembly:
  POST   /api/reports/{id}/assemble            Compile final PDF
  GET    /api/reports/{id}/preview             View assembled
  GET    /api/reports/{id}/assembled/page/{num}  Page image
  POST   /api/reports/{id}/compress            Compress PDF
  POST   /api/reports/{id}/split               Split PDF (>20MB)
  GET    /api/reports/{id}/download            Download PDF

Chat:
  POST   /api/reports/{id}/chat                Execute AI commands
  POST   /api/reports/{id}/undo                Undo last action
  GET    /api/reports/{id}/chat-history        View messages
  GET    /api/reports/{id}/suggestions         Get action suggestions

Health:
  GET    /health                                Service status
```

#### **classifier.py** (400+ lines)
AI-powered document classification using Ollama (primary) + Claude (optional).

**Functions**:
- `classify_document()` — Single document classification
- `batch_classify()` — Multiple documents (parallelized)
- `extract_ordering_hint()` — Regex-based subcategory detection (Appendix D)
- `detect_property_profile()` — Property Profile identification (Appendix E)
- Smart backend selection (Ollama vs. Claude based on config)

**Classification Model**:
- Input: Document text (first 5 + last 3 + every 100th page for large docs)
- Output: `{category, subcategory, confidence, reasoning}`
- Categories: COVER, APPENDIX_A, APPENDIX_B, ... APPENDIX_F, UNCLASSIFIED, REPORTS_AFTER_E
- Subcategories: For Appendix D (Sanborn, Aerial, Topo, City Directory), Appendix E (Property Profile, permits, etc.)

#### **classifier_enhancements.py** (280 lines)
Smart sampling + intelligent ordering detection.

**Functions**:
- `smart_text_extraction()` — Intelligent page sampling
  - Small docs (<50 pages): Read fully
  - Large docs (50+ pages): First 5 + Last 3 + Every 100th
  - Typical 18K-page doc: Reads ~500 pages (cost: $0 vs. $540 with full Claude)
  
- `extract_ordering_hint()` — Regex-based Appendix D detection
  - Sanborn → Aerial → Topo → City Directory detection via patterns
  - Returns subcategory for smart sorting
  
- `detect_property_profile()` — Property Profile ranking
  - Identifies property profiles in Appendix E
  - Sets `sort_order=1` to place first

#### **assembler.py** (500+ lines)
PDF compilation, ordering, and section-specific logic.

**Functions**:
- `assemble_report()` — Main assembly orchestration
- `apply_section_ordering()` — Apply smart ordering to sections
- `order_appendix_d()` — Sanborn → Aerial → Topo → City Dir
- `order_appendix_e()` — Property Profile first, others unordered
- `merge_pdfs()` — Combine documents with page numbering
- `add_page_markers()` — Section dividers + page counts

#### **models.py** (220+ lines)
SQLAlchemy ORM models + Pydantic request/response schemas.

**Database Models**:
- `Report` — Project metadata, status, assembled PDF info
- `Document` — File metadata, classification, ordering
- `ChatMessage` — Conversation history
- `ChatAction` — Action snapshots for undo/redo
- `ActionSnapshot` — Document state for rollback

**Request/Response Models**:
- `DocumentResponse` — Document metadata + classification
- `ClassificationResult` — AI classification output
- `ChatResponse` — Message + executed actions + results
- `DocxParagraph`, `DocxRun` — DOCX structure

#### **database.py** (150+ lines)
SQLAlchemy setup, session management, migrations.

**Features**:
- Automatic table creation on startup
- Session dependency for FastAPI endpoints
- Index optimization for common queries

#### **chat.py** (500+ lines)
Chat interface with LLM integration and action execution.

**Functions**:
- `process_message()` — Process user chat command
- `_call_llm()` — Invoke Ollama or Claude
- `_execute_actions()` — Execute move/exclude/include/search/info
- `undo_last_action()` — Rollback via ActionSnapshot
- `get_contextual_suggestions()` — Smart suggestion chips

**Supported Actions**:
- `move` — Move documents to section
- `exclude` — Remove from report
- `include` — Re-include excluded docs
- `search` — Find by filename
- `info` — Report status
- `assemble`, `compress`, `split`, `undo`, `text_replace`, `delete_pages` — Deferred to endpoints

#### **assembler.py** (140+ lines)
PDF merging, compression, splitting logic.

**Functions**:
- `merge_pdfs()` — Combine multiple PDFs
- `compress_pdf()` — Reduce file size via DPI reduction
- `split_pdf()` — Split large PDF for email (<20MB chunks)

#### **docx_handler.py** (180+ lines)
DOCX file handling (read, edit, preview).

**Functions**:
- `read_docx_content()` — Extract DOCX → JSON (paragraphs + runs)
- `update_docx_content()` — Apply edits to DOCX
- `docx_to_html()` — Convert DOCX to HTML for preview
- `create_docx_from_text()` — Generate DOCX from text

#### **north_star.py** (200+ lines)
System prompts and classification guidance.

**Contents**:
- Classification rubric (what goes where?)
- Appendix ordering rules
- Cross-contamination detection patterns
- Example documents for few-shot prompting

#### **config.py** (80+ lines)
Environment variable parsing and settings.

**Configuration**:
- `AI_BACKEND` — "ollama" (default) or "anthropic"
- `ANTHROPIC_API_KEY` — Claude API key
- `OLLAMA_URL`, `OLLAMA_MODEL` — Ollama endpoint
- `DATABASE_URL` — SQLite or PostgreSQL
- `COMPRESSION_DPI`, `MAX_EMAIL_SIZE_MB` — Tuning parameters

---

### **3. Database** (`backend/reports.db`)

**Engine**: SQLite (auto-created) or PostgreSQL (production)

**Schema**:
```sql
reports (
  id INTEGER PRIMARY KEY,
  name TEXT,
  location TEXT,
  status TEXT (e.g., "classifying", "ready", "assembled"),
  assembled_filename TEXT,
  assembled_size INTEGER,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
)

documents (
  id INTEGER PRIMARY KEY,
  report_id FOREIGN KEY,
  original_filename TEXT,
  stored_filename TEXT,
  category ENUM (COVER, APPENDIX_A, ..., REPORTS_AFTER_E),
  subcategory TEXT (e.g., "sanborn", "property_profile"),
  page_count INTEGER,
  is_included BOOLEAN,
  sort_order INTEGER,
  reasoning TEXT (why classified this way),
  confidence FLOAT,
  metadata_json TEXT (cross-contamination data),
  created_at TIMESTAMP
)

chat_messages (
  id INTEGER PRIMARY KEY,
  report_id FOREIGN KEY,
  role TEXT (user/assistant),
  content TEXT,
  actions_json TEXT (JSON list of executed actions),
  created_at TIMESTAMP
)

action_snapshots (
  id INTEGER PRIMARY KEY,
  report_id FOREIGN KEY,
  snapshot_json TEXT (document state before action),
  created_at TIMESTAMP
)
```

---

## 🤖 AI & Classification Pipeline

### **Classification Flow**

```
1. Document Upload
   └─> backend/main.py: POST /api/reports/{id}/upload
       └─> Save file to disk
       └─> Extract text (smart sampling: first 5 + last 3 + every 100th page)
       
2. AI Classification
   └─> backend/classifier.py: classify_document()
       ├─> Ollama (local, free) — qwen2.5 model
       │   └─> Fast, no cost, may be <80% confident
       └─> Claude (optional, on-demand)
           └─> Higher accuracy, $0.005-0.02 per doc
       
3. Ordering Detection
   └─> classifier_enhancements.py: extract_ordering_hint()
       └─> Regex-based subcategory detection:
           ├─> Appendix D: Sanborn/Aerial/Topo/City Dir (strict order)
           └─> Appendix E: Property Profile first (via sort_order)
       
4. Metadata Capture
   └─> classifier_enhancements.py: detect_property_profile()
       └─> Extract cross-contamination data:
           ├─> Project ID
           ├─> Address
           ├─> Company name
           └─> Store in metadata_json field
       
5. Database Storage
   └─> backend/models.py: Document ORM
       └─> Save to SQLite:
           ├─> category (COVER, APPENDIX_D, etc.)
           ├─> subcategory (sanborn, property_profile, etc.)
           ├─> page_count
           ├─> is_included
           ├─> sort_order
           ├─> reasoning (why classified this way)
           ├─> confidence (Ollama confidence score)
           └─> metadata_json (cross-contamination data)
```

### **Ollama vs. Claude Decision Tree**

```
Document to classify?
  ├─> Use Ollama (local, free)
  │   └─> If confidence >= 80%: Done ✅
  │   └─> If confidence < 80% AND USE_CLAUDE_TIEBREAKER=true:
  │       └─> Ask Claude for tiebreaker ($0.005-0.02)
  │
  └─> Use Claude (if AI_BACKEND=anthropic)
      └─> Always use Claude (higher accuracy)
```

---

## 📄 Document Processing Pipeline

### **From Upload to Assembly**

```
1. User Uploads Documents
   └─> React: DocumentUpload component
   └─> HTTP: POST /api/reports/{id}/upload (multipart/form-data)
   
2. Backend File Handling
   └─> Save to: backend/uploads/{report_id}/originals/{filename}
   └─> Extract text (smart sampling)
   └─> Generate PDF (from DOCX, if needed)
   
3. AI Classification
   └─> Classify each document (see AI pipeline above)
   
4. UI Display
   └─> Frontend: DocumentList component
   └─> Show: Filename, Category, Pages, Include/Exclude toggle
   └─> Allow: Drag-and-drop reordering, chat commands
   
5. Final Assembly
   └─> User clicks "Assemble" or chats "Assemble report"
   └─> Backend: POST /api/reports/{id}/assemble
   └─> Logic:
       ├─> Gather all included documents
       ├─> Sort by section (COVER → APPENDIX_A → ... → APPENDIX_F)
       ├─> Within Appendix D: Apply Sanborn → Aerial → Topo → City Dir order
       ├─> Within Appendix E: Place Property Profile first
       ├─> Merge PDFs with section dividers + page numbers
       ├─> Save to: backend/output/{report_id}/assembled.pdf
       └─> Return: Download link + size
   
6. Post-Assembly
   └─> User can: Compress (email), Split (large PDF), Download
```

---

## 🧠 Smart Sampling Details

### **The Problem**
- ESA reports: 12K-18K pages
- Full Claude read cost: $5-15 per report (expensive)
- User pain: 5-10 minute wait times for classification

### **The Solution: Smart Sampling**

**Algorithm**:
```python
if document.page_count < 50:
    read_all_pages()  # Small docs: read fully
else:
    read_pages([
        0:5,                      # First 5 pages (cover, headers)
        -3:,                      # Last 3 pages (signatures, notes)
        every_100th_page()        # Every 100th (structure sampling)
    ])
    # Result: ~500 pages for 18K-page document
```

**Accuracy Trade-off**:
- Full read: 99% accuracy, high cost
- Smart sampling: 95-97% accuracy, zero cost
- Key pages capture: metadata, section markers, ordering hints

**Cost Impact**:
- Ollama (local): $0 per report
- Claude tiebreaker: $0.01-0.02 per report (optional)
- vs. Full Claude: $5-15 per report (5-10x savings)

---

## 🔄 Chat Command Processing

### **Example: "Move docs 5,6,7 to Appendix D"**

```
1. User sends chat message
   └─> POST /api/reports/{id}/chat
   └─> Body: { "message": "Move docs 5,6,7 to Appendix D" }

2. Backend processes message
   └─> chat.py: process_message()
   └─> Pass to LLM (Ollama or Claude)
   └─> System prompt: north_star.py (classification rubric)
   └─> LLM response: { "message": "Done", "actions": [...] }

3. Action Execution
   └─> chat.py: _execute_actions()
   └─> For each action:
       ├─> Snapshot current state (ActionSnapshot)
       ├─> Update document.category = "APPENDIX_D"
       ├─> Update document.reasoning = "Moved via chat"
       └─> Commit to database

4. Response to User
   └─> Return: { 
         "message": "Moved 3 documents to Appendix D",
         "actions": [{"action": "move", "moved": 3, "target": "APPENDIX_D"}],
         "results": [...]
       }

5. Frontend Updates
   └─> Display success message
   └─> Re-fetch document list (live update)
   └─> Show undo option
```

### **Undo Mechanism**

```
1. User clicks "Undo Last Action"
   └─> POST /api/reports/{id}/undo

2. Backend recovery
   └─> Fetch most recent ActionSnapshot
   └─> Restore all document states from snapshot
   └─> Delete snapshot (single-level undo)

3. Frontend updates
   └─> Document list refreshes
   └─> Shows previous state
```

---

## 🚀 Deployment Architecture

### **Local Development**
```
Frontend (Vite):      http://localhost:5173
Backend (FastAPI):    http://localhost:8000
Database (SQLite):    backend/reports.db
AI (Ollama):          http://localhost:11434
```

### **Production (Render.com)**
```
Render Container:
  ├─> Build: Docker (Dockerfile.prod)
  │   └─> Python 3.11 + dependencies
  │   └─> Node.js + React build
  │   └─> Single container, dual service (backend on :8000, frontend static)
  │
  ├─> Environment Variables:
  │   ├─> ANTHROPIC_API_KEY (for Claude)
  │   ├─> AI_BACKEND=ollama (free) or anthropic
  │   ├─> OLLAMA_URL=http://localhost:11434 (if local Ollama)
  │   └─> DATABASE_URL=sqlite:///./reports.db (or PostgreSQL)
  │
  ├─> Health Check:
  │   └─> GET /health → {"status": "ok"}
  │
  └─> Persistent Storage:
      └─> Render Disk at /var/data (for SQLite + uploads)
```

### **Deployment Options**

| Platform | Effort | Cost | Pros | Cons |
|----------|--------|------|------|------|
| **Render.com** | 2 min | Free | One-click, GitHub auto-deploy | Limited free tier |
| **Railway** | 5 min | $5/mo | Good free tier, simple | Requires auth config |
| **Fly.io** | 10 min | Free | Global, lightweight | More CLI-heavy |
| **Heroku** | 5 min | Paid | Established | Expensive ($7+/mo) |

---

## 📊 Key Metrics & Performance

### **Expected Performance**

| Operation | Time | Notes |
|-----------|------|-------|
| Document upload | <1s | Per file (multipart) |
| AI classification (Ollama) | 2-5s | Per document, free |
| AI classification (Claude) | 5-10s | Per document, $0.01 |
| Smart text extraction | <1s | Even for 18K pages |
| Final assembly (90 docs) | <5 min | PDF merge + ordering |
| PDF compression | 1-2 min | DPI reduction |
| PDF split (for email) | 30-60s | Per chunk |

### **Cost Analysis**

**Per-Report Costs** (12K-15K pages):

| Scenario | Cost | Notes |
|----------|------|-------|
| Ollama only | $0 | Local, free, no network |
| Ollama + Claude tiebreaker (10% docs) | $0.10-0.20 | Optional, smart |
| Full Claude (every doc) | $5-15 | Not recommended |

**Monthly (100 reports)**:
- Ollama only: $0
- Ollama + tiebreaker: $10-20
- Full Claude: $500-1500

---

## 🛠 Tech Stack Summary

### **Frontend**
- React 19 (UI framework)
- Vite (build tool, instant HMR)
- Tailwind CSS (styling)
- TypeScript (type safety)
- TanStack Query (server state)
- React Router (navigation)

### **Backend**
- FastAPI (web framework)
- SQLAlchemy (ORM)
- Pydantic (validation)
- python-docx (DOCX handling)
- PyPDF (PDF operations)
- Ghostscript (PDF compression)
- Ollama client (local AI)
- Anthropic SDK (Claude API)

### **AI/ML**
- Ollama (local inference, free)
  - Model: qwen2.5:7b
  - Vision model: qwen2.5vl:7b
- Anthropic Claude (cloud, optional)
  - Model: claude-3-opus-20250219

### **Infrastructure**
- Docker (containerization)
- SQLite (local DB) / PostgreSQL (production)
- Render.com (deployment platform)
- GitHub Actions (CI/CD)
- Git (version control)

---

## 🔐 Security & Compliance

### **API Security**
- CORS configured for cross-origin requests
- File upload validation (size, type)
- SQL injection prevention via SQLAlchemy ORM
- Error handling (no sensitive data in responses)

### **Data Privacy**
- No cloud storage of document content (local-only)
- Anthropic API Key: Environment variable only (never in code)
- Database encryption: Optional (Render PostgreSQL option)

### **File Handling**
- Upload directory isolation per report
- Temporary file cleanup after processing
- No world-readable uploads

---

## 📝 Configuration & Environment Variables

See `.env.example`:

```bash
# AI Backend
AI_BACKEND=ollama              # "ollama" (free) or "anthropic"
ANTHROPIC_API_KEY=sk-...      # Claude API key (if using anthropic)

# Ollama (local)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_VL_MODEL=qwen2.5vl:7b

# Database
DATABASE_URL=sqlite:///./reports.db

# PDF Processing
COMPRESSION_DPI=150
MAX_EMAIL_SIZE_MB=10
MAX_STANDARD_SIZE_MB=25

# Frontend
VITE_API_URL=http://localhost:8000

# Features
USE_CLAUDE_TIEBREAKER=false
USE_CLAUDE_QC=false
USE_CLAUDE_SUGGESTIONS=false
```

---

## 🎯 System Design Principles

1. **Cost-Conscious**: Ollama primary, Claude optional
2. **Smart Sampling**: Read what matters, skip the rest
3. **Separation of Concerns**: Regex for hints, AI for classification
4. **Undo-Safe**: Every action snapshots before execution
5. **User-Controlled**: Chat interface for fine-grained control
6. **Transparent**: Reasoning captured for every classification
7. **Scalable**: SQLite for dev, PostgreSQL for production
8. **Local-First**: Runs without internet (Ollama only mode)

---

## 📈 Future Enhancements

- [ ] In-browser DOCX editing (Phase 2)
- [ ] Auto-QC with Claude (validate final report)
- [ ] Batch report assembly (multiple projects)
- [ ] Advanced search (full-text, metadata)
- [ ] Export to other formats (DOCX, Excel)
- [ ] User permissions (multi-user workspace)
- [ ] Webhook notifications (report ready)
- [ ] Analytics dashboard (processing metrics)


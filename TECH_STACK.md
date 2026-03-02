# ODIC Environmental — Complete Tech Stack

---

## 🎨 FRONTEND

### **Core Framework**
- **React 19** — UI library, component-based architecture
- **TypeScript 5.3** — Type safety, IDE support
- **Vite 5.0** — Build tool, dev server, instant HMR

### **Styling & UI**
- **Tailwind CSS 3.4** — Utility-first CSS framework
- **PostCSS 8.4** — CSS processing, vendor prefixes
- **Autoprefixer 10.4** — Automatic browser compatibility

### **State Management**
- **TanStack React Query 5.25** — Server state management, caching, sync
- **React Hooks** — Local state (useState, useContext, useReducer)

### **Routing & Navigation**
- **React Router DOM 6.20** — SPA routing, dynamic navigation

### **File Handling & Uploads**
- **React Dropzone 14.2** — Drag-and-drop file uploads
- **Axios 1.6** — HTTP client for API calls

### **Document Viewing**
- **PDFJS (pdfjs-dist) 3.11** — PDF rendering in browser
- **react-pdf 7.5** — React wrapper for PDFJS

### **UI Components & Notifications**
- **React Hot Toast 2.4** — Toast notifications
- **clsx 2.0** — Conditional CSS classes

### **Utilities**
- **Date-fns 2.30** — Date formatting and manipulation
- **UUID 9.0** — Generate unique identifiers

### **Development Tools**
- **ESLint 8.55** — Code linting
- **TypeScript ESLint 6.13** — TypeScript linting
- **Prettier** (optional) — Code formatting

### **Build Process**
```
Vite (dev server) → TypeScript compiler → Babel (JSX)
  → Tailwind CSS → PostCSS → Autoprefixer → Minified bundle
```

---

## 🔧 BACKEND

### **Core Framework & Server**
- **FastAPI 0.109** — Web framework, async, type validation
- **Uvicorn 0.24** — ASGI server (development)
- **Gunicorn 21.2** — WSGI/ASGI server (production)
- **Python 3.11** — Runtime environment

### **Database & ORM**
- **SQLAlchemy 2.0** — ORM, database abstraction
- **Alembic 1.12** — Database migrations (schema versioning)
- **SQLite 3** — Embedded database (development/small deployments)
- **PostgreSQL 16** — Production database (optional, recommended for scale)
- **psycopg2-binary 2.9** — PostgreSQL Python driver

### **Data Validation & Serialization**
- **Pydantic 2.5** — Data validation, settings management, JSON parsing
- **python-multipart 0.0.6** — Multipart form data parsing (file uploads)

### **Document Processing**
- **PyPDF 4.0** — PDF reading, writing, merging, splitting, compression
- **python-docx 1.1** — DOCX file reading, writing, editing
- **Pillow 10.1** — Image processing, format conversion
- **pdf2image 1.16** — PDF to image conversion (PNG, JPEG)
- **ReportLab 4.0** — PDF generation from scratch

### **PDF Compression & Conversion**
- **Ghostscript** (system) — PDF compression, optimization via DPI reduction
- **LibreOffice** (system, optional) — DOCX/PPTX to PDF conversion
- **ImageMagick** (system, optional) — Image manipulation

### **AI & Machine Learning**
- **Anthropic SDK 0.28** — Claude API integration
- **requests 2.31** — HTTP client for Ollama API calls
- **asyncio/aiohttp** — Async HTTP for parallel classification

### **Utilities & Helpers**
- **python-dotenv 1.0** — .env file parsing
- **aiofiles 23.2** — Async file operations
- **logging** (stdlib) — Application logging

### **Development & Testing**
- **pytest 7.4** — Unit testing framework
- **pytest-asyncio 0.21** — Async test support
- **black 23.12** — Code formatter
- **flake8 6.1** — Linting
- **mypy 1.7** — Static type checking

### **Backend Architecture**
```
FastAPI app (main.py)
  ├── Routes & Endpoints (50+)
  ├── Dependency Injection (get_db, get_current_user)
  ├── Exception Handlers (HTTPException, ValidationError)
  └── CORS & Middleware

Core Modules:
  ├── classifier.py → AI classification (Ollama/Claude)
  ├── classifier_enhancements.py → Smart sampling + ordering hints
  ├── assembler.py → PDF compilation + section ordering
  ├── chat.py → Chat interface + LLM integration
  ├── docx_handler.py → DOCX preview/editing
  ├── north_star.py → System prompts + classification rubric
  ├── models.py → Pydantic + SQLAlchemy models
  ├── database.py → SQLAlchemy session + initialization
  └── config.py → Environment variable parsing

Database:
  ├── SQLAlchemy ORM (models.py)
  ├── SQLite (local) or PostgreSQL (production)
  └── Alembic migrations (optional)
```

---

## 🤖 AI & MACHINE LEARNING

### **Local AI (Free)**
- **Ollama** — Local LLM inference
  - Model: **qwen2.5:7b** (7 billion parameters, 4.5GB RAM)
  - Vision Model: **qwen2.5vl:7b** (for OCR)
  - Runtime: CPU or GPU (CUDA/Metal)
  - Cost: $0
  - Speed: 2-5 seconds per document
  - Reliability: Offline-capable

### **Cloud AI (Optional, Paid)**
- **Anthropic Claude API** (if `AI_BACKEND=anthropic`)
  - Model: **claude-3-opus-20250219** (best, slower, expensive)
  - Model: **claude-3-sonnet-20250229** (balanced)
  - Model: **claude-3-haiku-20250307** (fast, cheap)
  - Cost: $0.01-0.02 per document
  - Speed: 5-10 seconds per document
  - Reliability: Cloud-based, always available

### **Classification Pipeline**
```
Document Input
  ↓
Smart Sampling (first 5 + last 3 + every 100th page)
  ↓
Text Extraction
  ↓
AI Classification (Ollama primary → Claude fallback if tiebreaker enabled)
  ↓
Confidence Scoring
  ↓
Category Assignment (COVER, APPENDIX_A-F, UNCLASSIFIED)
  ↓
Metadata Extraction (ordering hints, cross-contamination data)
  ↓
Database Storage
```

### **System Prompts**
- **north_star.py** — Classification rubric, example documents, ordering rules
- Defines what goes in each Appendix
- Appendix D ordering logic (Sanborn → Aerial → Topo → City Dir)
- Appendix E logic (Property Profile first)

---

## 📊 DATABASE

### **Development (SQLite)**
- **File**: `backend/reports.db` (auto-created)
- **Location**: Local disk or Render persistent disk
- **Size limit**: ~100GB practical
- **Concurrency**: Single-user safe
- **Perfect for**: Development, testing, small deployments

### **Production (PostgreSQL)**
- **Database**: PostgreSQL 16+ (managed or self-hosted)
- **Connection Pool**: SQLAlchemy with psycopg2
- **Concurrent Users**: Unlimited
- **Size**: Unlimited (cloud-managed)
- **Backup**: Cloud provider handles it

### **Schema (SQLAlchemy Models)**

```python
# Core Tables
reports
├── id (PK)
├── name
├── location
├── status (classifying, ready, assembled)
├── assembled_filename
├── assembled_size
├── created_at
└── updated_at

documents
├── id (PK)
├── report_id (FK → reports)
├── original_filename
├── stored_filename
├── category (COVER, APPENDIX_A, ..., UNCLASSIFIED)
├── subcategory (sanborn, aerial, property_profile, etc.)
├── page_count
├── is_included (boolean)
├── sort_order (integer for ordering within section)
├── reasoning (why classified this way)
├── confidence (0.0-1.0 from AI)
├── metadata_json (cross-contamination data)
├── created_at
└── updated_at

chat_messages
├── id (PK)
├── report_id (FK → reports)
├── role (user/assistant)
├── content
├── actions_json (JSON list of executed actions)
├── created_at

action_snapshots
├── id (PK)
├── report_id (FK → reports)
├── snapshot_json (document state before action)
├── created_at
```

---

## 🐳 CONTAINERIZATION & DEPLOYMENT

### **Docker**
- **Dockerfile.prod** — Multi-stage build
  - Stage 1: Node build (frontend)
  - Stage 2: Python runtime (backend)
  - Single image: Both frontend (static) + backend (API)
  - Health check: `GET /health`
  - Exposed port: 8000

### **Docker Compose** (local development)
```yaml
services:
  backend (FastAPI)
  frontend (React dev server)
  ollama (AI inference)
  postgresql (optional database)
```

### **Deployment Platforms**

#### **Render.com (Recommended)**
- **Type**: PaaS (Platform as a Service)
- **Build**: Dockerfile or Nixpacks
- **Deployment**: `render.yaml`
- **Environment**: Python 3.11 + Node.js
- **Storage**: Persistent disk (/var/data) for SQLite
- **Free tier**: $7/month credit, auto-scaling
- **Database**: Optional managed PostgreSQL
- **Health checks**: Automatic (30s interval)
- **Auto-redeploy**: On git push to main
- **URL**: Automatic (odic-esa.onrender.com)

#### **Railway.app**
- **Type**: PaaS, developer-friendly
- **Build**: Docker or Heroku buildpack
- **Deployment**: `railway.json`
- **Free tier**: $5/month credit
- **Environment**: Automatic
- **Storage**: Ephemeral (use PostgreSQL for persistence)
- **Auto-redeploy**: GitHub webhook
- **Dashboard**: Good UI

#### **Fly.io**
- **Type**: Container deployment platform
- **Build**: Docker
- **Deployment**: `fly.toml`
- **Free tier**: Limited but available
- **Global**: Distributed deployment
- **Regions**: Multiple edge locations
- **CLI-based**: `flyctl` required
- **Fast**: Optimized for performance

#### **Traditional Hosting (Self-Managed)**
- **Docker**: Push to Docker Hub
- **Kubernetes**: Deploy via YAML
- **VM-based**: AWS EC2, DigitalOcean, Linode
- **Cost**: Pay-as-you-go

---

## 🔄 CI/CD & Git

### **GitHub**
- **Repository**: `bpickett2019/ODIC-Environmental`
- **Branch**: `main` (production)
- **Hosting**: GitHub.com

### **GitHub Actions**
- **Deploy workflow**: `.github/workflows/`
  - `railway-deploy.yml` — Auto-deploy to Railway on push
  - `flyio-deploy.yml` — Auto-deploy to Fly.io
  - `heroku-deploy.yml` — Auto-deploy to Heroku

### **Version Control**
- **Git**: Distributed version control
- **Commits**: Meaningful messages
- **Branching**: `main` = production-ready

---

## 🛠️ SYSTEM DEPENDENCIES

### **Required**
```
Python 3.11+         Backend runtime
Node.js 20+          Frontend build
pip                  Python package manager
npm                  Node package manager
Docker               Container engine (for deployment)
```

### **Optional (For Advanced Features)**
```
Ghostscript          PDF compression (optimize DPI)
Tesseract OCR        Optical character recognition
LibreOffice          Document format conversion
ImageMagick          Image manipulation
CUDA / Metal GPU     Ollama GPU acceleration (if available)
```

### **System Package Installation**

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install -y \
  python3.11 \
  python3-pip \
  nodejs \
  npm \
  docker.io \
  ghostscript \
  tesseract-ocr \
  libreoffice \
  imagemagick
```

**macOS:**
```bash
brew install python@3.11 node docker ghostscript tesseract
```

**Windows:**
- Docker Desktop
- Python 3.11 from python.org
- Node.js from nodejs.org
- Ghostscript from sourceforge.net

---

## 📦 DEPENDENCY MATRIX

### **Frontend Dependencies (22 packages)**
```
Core:        React 19, Vite 5, TypeScript 5.3
State:       TanStack Query 5
Routing:     React Router 6
UI:          Tailwind CSS 3.4, react-hot-toast
Documents:   PDFJS 3.11, react-pdf 7.5
Files:       Axios 1.6, react-dropzone 14
Utils:       Date-fns 2.30, UUID 9.0, clsx 2.0
Dev:         ESLint 8, TypeScript ESLint 6, Prettier (opt)
```

### **Backend Dependencies (25 packages)**
```
Framework:   FastAPI 0.109, Uvicorn 0.24, Gunicorn 21
Database:    SQLAlchemy 2.0, Alembic 1.12, psycopg2 2.9
Validation:  Pydantic 2.5, python-multipart 0.0.6
Documents:   PyPDF 4.0, python-docx 1.1, Pillow 10, pdf2image 1.16
AI:          Anthropic SDK 0.28, requests 2.31
Utils:       python-dotenv 1.0, aiofiles 23.2
Testing:     pytest 7.4, pytest-asyncio 0.21
Lint/Format: black 23, flake8 6.1, mypy 1.7
```

---

## 🎯 DEPLOYMENT TECH STACK

### **Infrastructure Code**
- **Render.yaml** — Render.com deployment config
- **Railway.json** — Railway deployment config
- **Fly.toml** — Fly.io deployment config
- **Procfile** — Heroku deployment config
- **Dockerfile.prod** — Production container image
- **.env.example** — Environment variable template

### **Networking**
- **HTTPS**: TLS/SSL (managed by platform)
- **CORS**: Configured for cross-origin requests
- **Health checks**: HTTP GET /health
- **Port**: 8000 (backend), 5173 (dev frontend)

### **Monitoring & Logging**
- **Platform logging**: Render/Railway/Fly dashboards
- **Application logging**: Python logging module
- **Error tracking**: Exceptions logged + returned (no sensitive data)
- **Performance**: Response time tracking (optional)

---

## 📊 COMPLETE STACK VISUALIZATION

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER BROWSER                              │
│  Chrome/Safari/Firefox (any modern browser)                      │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│                    FRONTEND (React 19)                            │
│ ├─ React (UI framework)                                          │
│ ├─ TypeScript (type safety)                                      │
│ ├─ Vite (build tool, dev server)                                 │
│ ├─ Tailwind CSS (styling)                                        │
│ ├─ React Router (navigation)                                     │
│ ├─ TanStack Query (server state)                                 │
│ ├─ Axios (HTTP client)                                           │
│ ├─ React Dropzone (file uploads)                                 │
│ └─ PDFJS (PDF rendering)                                         │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP/JSON
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│                  BACKEND (FastAPI)                                │
│ ├─ FastAPI (web framework)                                       │
│ ├─ SQLAlchemy (ORM)                                              │
│ ├─ Pydantic (validation)                                         │
│ │                                                                 │
│ ├─ Document Processing:                                          │
│ │  ├─ PyPDF (PDF operations)                                     │
│ │  ├─ python-docx (DOCX files)                                   │
│ │  ├─ Pillow (image processing)                                  │
│ │  └─ pdf2image (PDF → PNG)                                      │
│ │                                                                 │
│ ├─ AI Classification:                                            │
│ │  ├─ Ollama API (local, free)                                   │
│ │  └─ Anthropic SDK (Claude, optional)                           │
│ │                                                                 │
│ ├─ Chat Interface:                                               │
│ │  ├─ LLM integration                                            │
│ │  ├─ Action execution                                           │
│ │  └─ Conversation history                                       │
│ │                                                                 │
│ └─ PDF Assembly:                                                 │
│    ├─ PyPDF merge                                                │
│    ├─ Ghostscript compression                                    │
│    └─ Smart ordering logic                                       │
└────────────────────────┬────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ↓                ↓                ↓
   ┌─────────────┐ ┌──────────────┐ ┌──────────────┐
   │  DATABASE   │ │     AI       │ │  FILE STORAGE│
   │             │ │              │ │              │
   │ SQLite/PG   │ │ Ollama       │ │ /uploads/    │
   │             │ │ (local)      │ │ /output/     │
   │ reports.db  │ │              │ │              │
   │ documents   │ │ Claude API   │ │ PDFs, DOCXs  │
   │ messages    │ │ (optional)   │ │ Images       │
   │ snapshots   │ │              │ │              │
   └─────────────┘ └──────────────┘ └──────────────┘
```

---

## 🔐 SECURITY STACK

### **API Security**
- **CORS**: Cross-origin resource sharing (configured)
- **HTTPS**: TLS/SSL encryption (platform-managed)
- **Validation**: Pydantic models (input validation)
- **ORM**: SQLAlchemy (SQL injection prevention)

### **Secrets Management**
- **Environment variables**: Sensitive data (API keys)
- **Platform vault**: Render/Railway/Fly (encrypted storage)
- **Never in code**: .env, Dockerfile, git commits

### **File Security**
- **Upload isolation**: Per-report directories
- **Permissions**: Read-only after upload
- **Cleanup**: Temporary files deleted after processing

---

## 💾 STORAGE ARCHITECTURE

### **Local Development**
```
ODIC-Environmental/
├── backend/
│   ├── uploads/
│   │   └── {report_id}/
│   │       ├── originals/ (uploaded files)
│   │       ├── pdfs/ (converted files)
│   │       └── output/ (assembled report)
│   ├── reports.db (SQLite)
│   └── [source code]
├── frontend/
│   └── [source code]
└── [config files]
```

### **Production (Render.com)**
```
Persistent Disk (/var/data/)
├── reports.db (SQLite) OR connect to managed PostgreSQL
├── uploads/ (document storage)
└── output/ (assembled PDFs)
```

---

## 🚀 PERFORMANCE STACK

### **Frontend Performance**
- **Vite HMR**: Instant hot module replacement (dev)
- **Code splitting**: Automatic chunk splitting
- **Tree shaking**: Unused code removal
- **Minification**: Production bundle optimization
- **Gzip compression**: Browser request compression

### **Backend Performance**
- **Async/await**: Non-blocking I/O (FastAPI)
- **Connection pooling**: SQLAlchemy pool (database)
- **Caching**: TanStack Query (client-side)
- **Lazy loading**: Documents loaded on demand
- **Smart sampling**: Read ~500 pages instead of 18K

### **AI Performance**
- **Local Ollama**: 2-5 seconds per doc (no network latency)
- **Parallel classification**: AsyncIO for concurrent processing
- **Batch processing**: Multiple docs in parallel
- **Fallback logic**: Ollama → Claude if uncertain

---

## 🎓 LEARNING RESOURCES

### **Frontend**
- React: https://react.dev
- Vite: https://vitejs.dev
- Tailwind: https://tailwindcss.com
- TanStack Query: https://tanstack.com/query

### **Backend**
- FastAPI: https://fastapi.tiangolo.com
- SQLAlchemy: https://docs.sqlalchemy.org
- Pydantic: https://docs.pydantic.dev
- PyPDF: https://github.com/py-pdf/pypdf

### **AI**
- Ollama: https://ollama.ai
- Claude: https://console.anthropic.com
- qwen2.5: https://huggingface.co/Qwen/Qwen2.5-7B

### **DevOps**
- Docker: https://docs.docker.com
- Render: https://docs.render.com
- Railway: https://docs.railway.app
- Fly.io: https://fly.io/docs

---

## 📋 QUICK REFERENCE TABLE

| Layer | Technology | Purpose | Cost |
|-------|-----------|---------|------|
| **Frontend** | React 19 + Vite | UI | $0 |
| **Styling** | Tailwind CSS | CSS framework | $0 |
| **State** | TanStack Query | Server sync | $0 |
| **Backend** | FastAPI | Web API | $0 |
| **Database** | SQLite/PostgreSQL | Data storage | $0 (SQLite) |
| **ORM** | SQLAlchemy | Database abstraction | $0 |
| **Documents** | PyPDF + python-docx | File processing | $0 |
| **AI Local** | Ollama + qwen2.5 | Classification | $0 |
| **AI Cloud** | Claude API | Optional tiebreaker | $0.01-0.02/doc |
| **Compression** | Ghostscript | PDF optimization | $0 |
| **Containers** | Docker | Deployment | $0 |
| **Hosting** | Render.com | Cloud platform | Free tier ($7/mo credit) |

---

## 🎯 TOTAL COST OF OWNERSHIP

### **Development**
- **Hosting**: Free (local machine)
- **AI**: $0 (Ollama local)
- **Database**: $0 (SQLite local)
- **Total**: **$0**

### **Production (100 reports/month)**
- **Hosting**: ~$5/month (Render free tier)
- **AI**: $0 with Ollama, or ~$10-20 with Claude tiebreaker
- **Database**: $0 (SQLite) or ~$15/month (PostgreSQL)
- **Total**: **$5-35/month**

### **Scale (1000 reports/month)**
- **Hosting**: ~$50/month
- **AI**: $0 with Ollama, or ~$100-200 with Claude
- **Database**: ~$50/month (PostgreSQL)
- **Total**: **$100-300/month**

---

## ✅ TECH STACK SUMMARY

**This system is built with:**
- ✅ Modern, proven technologies (React, FastAPI, PostgreSQL)
- ✅ Strong type safety (TypeScript, Pydantic)
- ✅ Production-ready (async, pooling, error handling)
- ✅ Low cost (free AI option via Ollama)
- ✅ Scalable (containerized, cloud-ready)
- ✅ Well-documented (comprehensive guides)
- ✅ Open-source (no vendor lock-in)

**Perfect for:**
- Quick prototyping (2 min deploy)
- Production use (proven stack)
- Cost-sensitive operations ($0-35/month)
- Document processing (PyPDF, python-docx)
- AI integration (Ollama + Claude)


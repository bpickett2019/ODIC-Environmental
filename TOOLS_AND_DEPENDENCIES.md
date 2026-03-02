# Tools & Dependencies — Complete Manifest

## 🔧 Backend Dependencies

### **File: `backend/requirements.txt`**

#### **Web Framework & API**
```
fastapi==0.104.1              # Web framework
uvicorn==0.24.0               # ASGI server (local dev)
gunicorn==21.2.0              # Production server
```

#### **Database & ORM**
```
sqlalchemy==2.0.23            # ORM for database access
alembic==1.12.1               # Database migrations
psycopg2-binary==2.9.9        # PostgreSQL driver (production)
```

#### **Data Validation & Serialization**
```
pydantic==2.5.0               # Data validation & settings
python-multipart==0.0.6       # Form data parsing
```

#### **AI/ML Backends**
```
anthropic==0.7.1              # Claude API SDK
requests==2.31.0              # HTTP client (Ollama)
```

#### **Document Processing**
```
pypdf==3.17.1                 # PDF reading & manipulation
python-docx==1.1.0            # DOCX file handling
pillow==10.1.0                # Image processing (PDF→PNG)
pdf2image==1.16.3             # PDF→image conversion
```

#### **PDF Compression & Conversion**
```
reportlab==4.0.7              # PDF generation
```

#### **System Tools**
```
python-pptx==0.6.21           # PowerPoint handling (future)
pytesseract==0.3.10           # OCR (optional, for scanned PDFs)
```

#### **Utilities & Helpers**
```
python-dotenv==1.0.0          # .env file parsing
aiofiles==23.2.1              # Async file operations
httpx==0.25.2                 # Async HTTP (optional)
```

#### **Development & Testing**
```
pytest==7.4.3                 # Unit testing
pytest-asyncio==0.21.1        # Async test support
black==23.12.0                # Code formatting
flake8==6.1.0                 # Linting
mypy==1.7.1                   # Type checking
```

---

## 🎨 Frontend Dependencies

### **File: `frontend/package.json`**

#### **Core Framework**
```json
{
  "dependencies": {
    "react": "^19.0.0",                        // UI framework
    "react-dom": "^19.0.0",                    // DOM rendering
    "react-router-dom": "^6.20.0",            // Navigation
    "vite": "^5.0.0"                          // Build tool
  }
}
```

#### **State Management & Data Fetching**
```json
{
  "dependencies": {
    "@tanstack/react-query": "^5.25.0",       // Server state management
    "@tanstack/react-query-devtools": "^5.25.0" // Debugging
  }
}
```

#### **UI Components & Styling**
```json
{
  "dependencies": {
    "tailwindcss": "^3.4.0",                  // Utility CSS
    "postcss": "^8.4.32",                     // CSS processing
    "autoprefixer": "^10.4.16",               // Vendor prefixes
    "clsx": "^2.0.0",                         // Conditional classes
    "react-hot-toast": "^2.4.1"               // Toast notifications
  }
}
```

#### **File & Form Handling**
```json
{
  "dependencies": {
    "react-dropzone": "^14.2.3",              // Drag-and-drop uploads
    "axios": "^1.6.2"                         // HTTP client
  }
}
```

#### **PDF & Document Viewing**
```json
{
  "dependencies": {
    "pdfjs-dist": "^3.11.174",                // PDF rendering (browser)
    "react-pdf": "^7.5.0"                     // React PDF component
  }
}
```

#### **Utilities**
```json
{
  "dependencies": {
    "date-fns": "^2.30.0",                    // Date formatting
    "uuid": "^9.0.1"                          // Unique IDs
  }
}
```

#### **Development Tools**
```json
{
  "devDependencies": {
    "typescript": "^5.3.3",                   // Type safety
    "@types/react": "^18.2.37",               // React types
    "@types/react-dom": "^18.2.15",           // DOM types
    "@types/node": "^20.10.0",                // Node types
    "eslint": "^8.55.0",                      // Linting
    "@typescript-eslint/eslint-plugin": "^6.13.1"
  }
}
```

---

## 🐳 Docker & Infrastructure

### **File: `Dockerfile.prod`**

**Multi-stage build** (optimized for production):

```dockerfile
# Stage 1: Backend build
FROM python:3.11-slim as backend
WORKDIR /app/backend
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Stage 2: Frontend build
FROM node:20-alpine as frontend
WORKDIR /app/frontend
COPY package.json package-lock.json .
RUN npm ci
COPY . .
RUN npm run build

# Stage 3: Runtime
FROM python:3.11-slim
WORKDIR /app
COPY --from=backend /app/backend ./backend
COPY --from=frontend /app/frontend/dist ./frontend/dist
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Features**:
- ✅ Optimized image size (multi-stage)
- ✅ No build artifacts in final image
- ✅ Backend + frontend in single container
- ✅ Health check endpoint

### **File: `docker-compose.yml`** (local development)

```yaml
version: '3.8'
services:
  backend:
    build: ./backend
    ports:
      - "8000:8000"
    volumes:
      - ./backend:/app/backend
    environment:
      - PYTHONUNBUFFERED=1
      - DATABASE_URL=sqlite:///./reports.db
      - AI_BACKEND=ollama
      - OLLAMA_URL=http://ollama:11434
    depends_on:
      - ollama
      - db

  frontend:
    build: ./frontend
    ports:
      - "5173:5173"
    volumes:
      - ./frontend:/app/frontend
    environment:
      - VITE_API_URL=http://localhost:8000

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=odic
      - POSTGRES_USER=odic
      - POSTGRES_PASSWORD=changeme
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

volumes:
  ollama_data:
  postgres_data:
```

---

## 🚀 Deployment Tools

### **Render.com** (`render.yaml`)

```yaml
services:
  - type: web
    name: odic-environmental
    runtime: docker
    dockerfilePath: Dockerfile.prod
    startCommand: gunicorn backend.main:app --bind 0.0.0.0:8000
    envVars:
      - key: ANTHROPIC_API_KEY
        sync: false  # Set manually in Render dashboard
      - key: AI_BACKEND
        value: ollama
      - key: DATABASE_URL
        value: sqlite:///./reports.db
    healthCheckPath: /health
```

### **Railway.app** (`railway.json`)

```json
{
  "build": {
    "builder": "dockerfile",
    "dockerfilePath": "Dockerfile.prod"
  },
  "deploy": {
    "startCommand": "gunicorn backend.main:app --bind 0.0.0.0:8000"
  }
}
```

### **Fly.io** (`fly.toml`)

```toml
app = "odic-esa"
primary_region = "sjc"

[build]
dockerfile = "Dockerfile.prod"

[services]
internal_port = 8000
force_https = true

[[services.ports]]
port = 80
handlers = ["http"]

[[services.ports]]
port = 443
handlers = ["tls", "http"]
```

### **GitHub Actions Workflows**

**`railway-deploy.yml`**: Auto-deploy on `git push main`
```yaml
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Deploy to Railway
        uses: railway-app/actions-deploy@v1
        with:
          token: ${{ secrets.RAILWAY_TOKEN }}
          service: ${{ secrets.RAILWAY_SERVICE_ID }}
```

Similar workflows for Fly.io and Heroku (see `.github/workflows/`).

---

## 🛠️ System Tools & Binaries

### **Required (Auto-installed)**
```
Python 3.11+        # Backend runtime
Node.js 20+         # Frontend build
pip                 # Python package manager
npm                 # Node package manager
```

### **Optional (System-dependent)**
```
Ghostscript         # PDF compression (/usr/bin/gs)
Tesseract           # OCR for scanned PDFs (/usr/bin/tesseract)
LibreOffice         # DOCX/PPTX conversion (soffice)
ImageMagick         # Image processing (convert)
```

**Installation** (Ubuntu/Debian):
```bash
sudo apt-get update
sudo apt-get install -y ghostscript tesseract-ocr libreoffice imagemagick
```

**Check installation**:
```bash
gs --version
tesseract --version
soffice --version
convert --version
```

---

## 🤖 AI/ML Engines

### **Ollama** (Local, Free)

**Installation**: https://ollama.ai

**Models Used**:
```
qwen2.5:7b          # Text classification (7B params, ~4.5GB RAM)
qwen2.5vl:7b        # Vision (optical character recognition)
```

**Download & Run**:
```bash
ollama pull qwen2.5:7b
ollama pull qwen2.5vl:7b
ollama serve        # Starts on http://localhost:11434
```

**System Requirements**:
- RAM: 8GB minimum (12GB+ recommended)
- Disk: 10GB per model
- GPU: Optional (CPU works, slower)

**API Endpoint**:
```
POST http://localhost:11434/api/generate
Content-Type: application/json

{
  "model": "qwen2.5:7b",
  "prompt": "Classify this document...",
  "stream": false
}
```

### **Anthropic Claude** (Cloud, Optional)

**Installation**:
```bash
pip install anthropic
```

**API Key**:
- Get from: https://console.anthropic.com
- Environment variable: `ANTHROPIC_API_KEY=sk-...`
- **Never commit to git!**

**Models Available**:
```
claude-3-opus-20250219      # Best (slower, expensive)
claude-3-sonnet-20250229    # Fast & capable
claude-3-haiku-20250307     # Fastest (cheaper)
```

**API Usage** (via Anthropic SDK):
```python
from anthropic import Anthropic

client = Anthropic()
message = client.messages.create(
    model="claude-3-opus-20250219",
    max_tokens=1024,
    messages=[{"role": "user", "content": "..."}]
)
```

---

## 📦 Database Engines

### **SQLite** (Development/Small Deployment)

- **File**: `backend/reports.db` (auto-created)
- **No setup required** (included with Python)
- **Max ~100GB** (single-file limitation)
- **Single-user** (not concurrent-safe)

**Connection String**:
```
sqlite:///./reports.db
```

### **PostgreSQL** (Production)

**Installation** (Docker):
```bash
docker run -d --name postgres \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  postgres:16-alpine
```

**Connection String**:
```
postgresql://user:password@localhost:5432/odic
```

**Render.com PostgreSQL**:
- One-click provision in Render dashboard
- Connection string auto-populated

---

## 🔍 Development & Debugging Tools

### **Backend**

**Local Testing**:
```bash
cd backend
python -m pytest            # Run all tests
python -m pytest -v         # Verbose
pytest tests/test_classifier.py  # Single file
```

**Type Checking**:
```bash
mypy backend/                # Check types
```

**Linting**:
```bash
flake8 backend/
black --check backend/
```

**API Documentation**:
```
http://localhost:8000/docs              # Swagger UI
http://localhost:8000/redoc             # ReDoc
```

### **Frontend**

**Dev Server**:
```bash
cd frontend
npm run dev          # Vite dev server (port 5173)
```

**Build**:
```bash
npm run build        # Production build
npm run preview      # Test production build locally
```

**Type Checking**:
```bash
npx tsc --noEmit    # Check types
```

**Linting**:
```bash
npm run lint        # ESLint
```

---

## 📊 Monitoring & Observability

### **Logging**

**Backend Logs** (FastAPI):
```
INFO:     Uvicorn running on http://0.0.0.0:8000
DEBUG:    classifier_enhancements - smart_text_extraction starting
ERROR:    Failed to classify document: timeout
```

**Frontend Logs** (React):
```
[api/client.ts] POST /api/reports/1/chat
[components/DocumentList] Re-fetching documents...
```

### **Health Checks**

```bash
curl http://localhost:8000/health
# Output: {"status": "ok"}
```

### **Performance Monitoring** (Optional)

```bash
# CPU/Memory usage
top -p $(pgrep -f uvicorn)

# Python profiling
python -m cProfile -s cumtime backend/main.py
```

---

## 🔐 Environment & Secrets

### **Local Development** (`.env`)

```bash
# Create from template
cp .env.example .env

# Edit .env (never commit!)
ANTHROPIC_API_KEY=sk-ant-...
AI_BACKEND=ollama
OLLAMA_URL=http://localhost:11434
DATABASE_URL=sqlite:///./reports.db
```

### **Production** (Render.com, Railway, etc.)

**Set via deployment platform UI** (never in `Dockerfile` or git):
```
ANTHROPIC_API_KEY = sk-ant-...
AI_BACKEND = ollama
DATABASE_URL = postgresql://...
```

**GitHub Actions Secrets** (for CI/CD):
```bash
gh secret set RAILWAY_TOKEN --body $TOKEN
gh secret set RENDER_API_KEY --body $KEY
```

---

## 📋 Summary: Tools by Purpose

| Purpose | Tool | Installation | Usage |
|---------|------|--------------|-------|
| **Web Framework** | FastAPI | `pip install fastapi` | Backend API |
| **Database** | SQLAlchemy + SQLite/PostgreSQL | `pip install sqlalchemy` | Data persistence |
| **AI (Local)** | Ollama + qwen2.5 | `ollama.ai` + `ollama pull` | Classification |
| **AI (Cloud)** | Anthropic Claude | `pip install anthropic` | Tiebreaker/QC |
| **Document Processing** | pypdf, python-docx, PIL | `pip install` | PDF/DOCX handling |
| **Frontend** | React + Vite + Tailwind | `npm install` | UI |
| **Deployment** | Docker + Render/Railway/Fly | Docker Desktop | Cloud hosting |
| **Testing** | pytest | `pip install pytest` | Unit/integration tests |
| **CI/CD** | GitHub Actions | Built-in to GitHub | Auto-deploy |

---

## 🎯 Quick Reference: What Tool Does What?

- **FastAPI**: Handles HTTP requests, routes, validation
- **SQLAlchemy**: Database queries, ORM, migrations
- **Ollama**: Local AI inference, free, no API key needed
- **Claude**: Cloud AI, high accuracy, costs money
- **PyPDF**: Read/modify PDFs, merge, split, compress
- **python-docx**: Read/write DOCX files, preserve formatting
- **React**: Frontend UI, state management, routing
- **Vite**: Lightning-fast dev server, production build
- **Tailwind**: CSS utility classes, responsive design
- **Docker**: Package app for deployment
- **Render/Railway/Fly**: Cloud hosting, auto-scaling, monitoring


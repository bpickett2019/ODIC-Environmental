# BMAD Phase 3: Architecture Decisions (Continued)
## ADRs 008-011: Deployment Blockers & Fixes
**Date**: 2026-03-02 02:55 AM  
**Architect**: Winston  
**Input**: PHASE_1_ANALYSIS.md + PHASE_2_PRD.md  
**Status**: COMPLETE

---

## ADR-008: Python Dependency Management Strategy

**Status**: ACCEPTED ✅

### Decision
Use `pip` + `requirements.txt` (not Poetry/Pipenv) to manage dependencies. Add 5 missing critical dependencies to requirements.txt before deployment.

### Rationale
- **Simplicity**: requirements.txt is Docker-native, no extra tooling needed
- **Compatibility**: FastAPI ecosystem tools support it natively
- **Performance**: Pip is fastest for Docker builds
- **Team preference**: Established in existing setup

### Missing Dependencies
```
pypdfium2==1.18.0        # PDF page rendering (used by main.py:render_page)
pdf2image==1.17.0        # Fallback PDF rendering
anthropic==0.28.0        # Claude API (listed but verify version)
ollama==0.2.0            # Local Ollama client (optional, fallback)
opencv-python==4.8.0     # Image processing + OCR support
```

### Implementation
1. Add lines to `backend/requirements.txt`
2. Test locally: `pip install -r backend/requirements.txt`
3. Docker build: `docker build -f Dockerfile.prod -t odic:latest .`
4. Verify: `python -c "import pypdfium2; import anthropic; import ollama"`

### Risks & Mitigations
- **pip-resolver conflicts**: Test in clean venv
- **Breaking API changes**: Pin exact versions (done above)
- **Docker build timeout**: These packages have precompiled wheels, should be fast

---

## ADR-009: Frontend Build & Static Serving Strategy

**Status**: ACCEPTED ✅

### Decision
Build frontend as part of Docker build process (multi-stage: Node → Python). Copy build artifacts to `backend/static/` for serving by FastAPI.

### Rationale
- **Single container**: Unified deployment (one image = full stack)
- **Version control**: Frontend build happens at deploy time (always in sync)
- **Simplicity**: No pre-built artifacts in git, no binary conflicts
- **Cost-effective**: Render/Fly.io bill per container, not per build

### Build Pipeline
```dockerfile
# Stage 1: Node build
FROM node:18 as frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --legacy-peer-deps
COPY frontend .
RUN npm run build

# Stage 2: Python runtime
FROM python:3.11-slim
...
# Copy frontend artifacts
COPY --from=frontend-build /app/frontend/dist ./static
```

### Implementation
1. Dockerfile.prod already has this ✅ (no changes needed)
2. Local build: `npm ci --legacy-peer-deps && npm run build`
3. Copy dist: `cp -r frontend/dist backend/static` (for local dev)
4. Test: `curl http://localhost:8000/` should serve index.html

### Frontend Serving Code
```python
# backend/main.py (lines ~100)
from fastapi.staticfiles import StaticFiles

app.mount("/", StaticFiles(directory="static", check_dir=False), name="static")
```

### Risks & Mitigations
- **npm build failure**: Tailwind peer deps handled with `--legacy-peer-deps`
- **Missing dist on deploy**: GitHub Actions will rebuild as part of Docker build
- **Large Docker image**: React build is ~5MB, acceptable

---

## ADR-010: Deployment Platform & Multi-Platform Strategy

**Status**: ACCEPTED ✅

### Decision
**Primary**: Render.com (Flask-like simplicity)  
**Secondary**: Fly.io (free tier available)  
**Rejected**: Vercel (60s timeout < 300s assembly time)

### Comparison

| Factor | Render | Fly.io | Vercel |
|--------|--------|--------|--------|
| Timeout | No limit | No limit | **60s ❌** |
| Cost | $7/mo | Free tier | Free tier |
| Python | ✅ | ✅ | ❌ (serverless only) |
| Persistent storage | ✅ | ✅ volumes | ❌ |
| Docker support | ✅ | ✅ | ✅ (with workarounds) |
| Setup complexity | Low | Low | High |
| Scaling | Manual | Manual | Auto |

### Implementation Strategy

#### Option 1: Render.com (Recommended)
```bash
# Deployment steps
git push origin main
# Render auto-deploys via webhook
# Sets env vars: ANTHROPIC_API_KEY, DATABASE_URL, etc.
# Health check: /health endpoint
# Done in 2-3 minutes
```

**Render.yaml** (already exists, minimal updates):
```yaml
services:
  - type: web
    name: odic-esa
    env: docker
    buildCommand: ""  # Use Dockerfile.prod
    startCommand: "python -m uvicorn main:app --host 0.0.0.0 --port 8000"
    envVars:
      - key: ANTHROPIC_API_KEY
        value: (set in Render dashboard)
      - key: DATABASE_URL
        value: "sqlite:////data/reports.db"
```

#### Option 2: Fly.io (Alternative)
```bash
flyctl launch  # Creates fly.toml
# Config already exists
flyctl secrets set ANTHROPIC_API_KEY=sk-ant-...
flyctl deploy
```

**Fly.toml** (already exists, ready to use):
- Mounts persistent volume at `/data` ✅
- Health check configured ✅
- Port 8000 exposed ✅

### Environment Variables (Both Platforms)
```bash
# Required
ANTHROPIC_API_KEY=sk-ant-oat01-SDTNBb2FNQf3fYU6NcbWJSRZqJDZHy4p2M4N3mmnRq6bAaDtUSUnwG9GWMEbE7UAQnU nwqS7lABp6Mcdla-GxA-6vfLWQAA

# Optional (defaults to below if not set)
AI_BACKEND=anthropic  # or "ollama"
DATABASE_URL=sqlite:////data/reports.db
LIBREOFFICE_PATH=soffice  # Should find via $PATH
GHOSTSCRIPT_PATH=gs
TESSERACT_PATH=tesseract
```

### Why NOT Vercel
- Vercel serverless functions timeout at 60 seconds
- ODIC PDF assembly takes 300+ seconds (5 minutes)
- Would need to split: frontend (Vercel) + backend (separate container)
- More complex deployment, more potential failure points
- **Verdict**: Not worth the complexity for single-container app

### Why Render Over Railway
- Railway previously had deployment failures (noted in summary)
- Render has better FastAPI support
- Simpler configuration UI
- Better documentation

### Risks & Mitigations
- **Cold start**: Render might take 10-15s on first request after inactivity
  - Mitigation: Use paid tier ($7/mo) to avoid cold starts
- **Database persistence**: SQLite persists across container restarts ✅
- **Buildpack vs Docker**: Render auto-detects, use Dockerfile.prod to be explicit

---

## ADR-011: API Key Management & Fallback Strategy

**Status**: ACCEPTED ✅

### Decision
Require ANTHROPIC_API_KEY in production (set via environment variable). Provide Ollama fallback for local development (optional). Warn but don't fail if both unavailable.

### Rationale
- **Cost efficiency**: Claude handles 95% of classifications correctly ($0.01-0.02/doc)
- **Reliability**: Ollama is optional, prevents hard dependency
- **Flexibility**: Supports both local (dev) and cloud (prod) workflows
- **Graceful degradation**: Fallback chain prevents cascading failures

### Fallback Chain (in classifier.py & chat.py)

```python
# Priority 1: Anthropic Claude (production)
if settings.AI_BACKEND == "anthropic" and settings.ANTHROPIC_API_KEY:
    return await _classify_with_anthropic(user_message)

# Priority 2: Ollama (local development)
elif settings.AI_BACKEND == "ollama":
    return await _classify_with_ollama(user_message)

# Priority 3: Basic classification (fallback)
else:
    logger.warning("No AI backend configured, using filename-based classification")
    return classify_by_filename_legacy(filename)
```

### Configuration

**Production (Render/Fly.io)**:
```bash
ANTHROPIC_API_KEY=sk-ant-...          # REQUIRED
AI_BACKEND=anthropic                  # Use Claude
```

**Local Development**:
```bash
ANTHROPIC_API_KEY=sk-ant-...          # Optional
AI_BACKEND=ollama                     # Use local Ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
```

**Offline Mode** (neither available):
```bash
# Will fall back to filename-based classification
# Warning logged: "No AI backend configured..."
```

### Implementation in config.py

```python
class Settings(BaseSettings):
    AI_BACKEND: str = "ollama"  # Default to local
    ANTHROPIC_API_KEY: str = os.environ.get("ANTHROPIC_API_KEY", "")
    CLAUDE_MODEL: str = "claude-sonnet-4-20250514"
    OLLAMA_URL: str = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    
    # Validation warning
    @validator('ANTHROPIC_API_KEY')
    def validate_api_key(cls, v):
        if not v:
            logger.warning("⚠️ ANTHROPIC_API_KEY not set - will use Ollama fallback")
        return v
```

### Cost Impact
- **$0 with Ollama**: If running locally
- **$0.01-0.02 per document** with Claude: Smart sampling reduces cost by 95%
- **Production estimate**: 100 reports/month = $1.50-3.00

### Security
- ✅ Never commit API key to git
- ✅ Use environment variables only
- ✅ Render dashboard hides values
- ✅ Fly.io secrets work similarly

### Risks & Mitigations
- **API rate limits**: Claude has generous limits (1000/min)
  - Mitigation: Add rate limiting in main.py if needed
- **API quota exceeded**: Monitor daily usage
  - Mitigation: Set up Anthropic spending alert in dashboard
- **Ollama unavailable**: Falls back to filename classification
  - Acceptable for MVP

---

## ADR-012: System Dependency Management (LibreOffice, Ghostscript, Tesseract)

**Status**: ACCEPTED ✅

### Decision
Include all three system packages in Docker image (libreoffice, ghostscript, tesseract-ocr). Document local installation for development. Use which() to find executables.

### Rationale
- **Docker self-contained**: Image includes everything needed
- **No external service deps**: Don't rely on host system
- **Consistent behavior**: Same packages everywhere
- **Fallback paths**: config.py checks customizable paths

### Dockerfile.prod
```dockerfile
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    ghostscript \
    libreoffice \
    curl \
    && rm -rf /var/lib/apt/lists/*
```

Status: ✅ Already in Dockerfile.prod (no changes needed)

### Local Development Setup
Document in SYSTEM_REQUIREMENTS.md:

**Ubuntu/Debian**:
```bash
sudo apt-get install libreoffice ghostscript tesseract-ocr
```

**macOS**:
```bash
brew install libreoffice ghostscript tesseract
```

**Windows**:
Download installers + add to PATH

### Verification in config.py
```python
LIBREOFFICE_PATH: str = os.environ.get("LIBREOFFICE_PATH", "soffice")
GHOSTSCRIPT_PATH: str = os.environ.get("GHOSTSCRIPT_PATH", "gs")
TESSERACT_PATH: str = os.environ.get("TESSERACT_PATH", "tesseract")

# Check availability at startup
for tool, path in [("LibreOffice", LIBREOFFICE_PATH), ...]:
    try:
        subprocess.run([path, "--version"], capture_output=True, timeout=5)
        logger.info(f"✓ {tool} found at {path}")
    except:
        logger.warning(f"⚠️ {tool} not found - some features will be unavailable")
```

### Risks & Mitigations
- **Docker image size**: LibreOffice adds ~300MB
  - Mitigation: Accept tradeoff for functionality (Fly.io free tier covers it)
- **Build time**: Docker build takes 3-5 minutes (apt-get install is slow)
  - Mitigation: Render/Fly.io build servers are fast, acceptable
- **LibreOffice process resource usage**: Heavy for large batches
  - Mitigation: Already using async + smart sampling

---

## Summary of ADRs 8-12

| ADR | Decision | Risk | Status |
|-----|----------|------|--------|
| 008 | Add missing deps to requirements.txt | Low | ✅ ACCEPTED |
| 009 | Multi-stage Docker build (Node → Python) | Low | ✅ ACCEPTED |
| 010 | Render.com primary, Fly.io secondary | Medium | ✅ ACCEPTED |
| 011 | Anthropic primary, Ollama fallback | Low | ✅ ACCEPTED |
| 012 | System packages in Docker image | Low | ✅ ACCEPTED |

---

**End of Phase 3 - Ready for Phase 4 Implementation**

# Deployment Setup Guide
## ODIC Environmental ESA Report Assembly System

**Last Updated**: 2026-03-02  
**Status**: Ready for production deployment

---

## Quick Start (Render.com - Recommended)

### Step 1: Deploy to Render
```bash
git push origin main
# Go to: https://dashboard.render.com/
# Or use one-click: https://render.com/deploy?repo=https://github.com/bpickett2019/ODIC-Environmental
```

### Step 2: Configure Environment
In Render Dashboard → Environment:
```
AI_BACKEND=anthropic
ANTHROPIC_API_KEY=sk-ant-oat01-SDTNBb2FNQf3fYU6NcbWJSRZqJDZHy4p2M4N3mmnRq6bAaDtUSUnwG9GWMEbE7UAQnU nwqS7lABp6Mcdla-GxA-6vfLWQAA
DATABASE_URL=sqlite:////data/reports.db
LIBREOFFICE_PATH=soffice
GHOSTSCRIPT_PATH=gs
TESSERACT_PATH=tesseract
```

### Step 3: Health Check
```bash
curl https://your-app.onrender.com/health
# Should return: {"status":"ok"}
```

### Step 4: Test
- Open: https://your-app.onrender.com
- Upload a PDF
- Run assembly

---

## Alternative Deployments

### Option 2: Fly.io
```bash
flyctl launch
# Prompts for app name, region (sfo recommended)
# Uses existing fly.toml
flyctl secrets set ANTHROPIC_API_KEY=sk-ant-...
flyctl deploy
```

### Option 3: Local Docker
```bash
docker build -f Dockerfile.prod -t odic:latest .
docker run -p 8000:8000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e AI_BACKEND=anthropic \
  odic:latest
```

---

## Environment Variables

### Required for Production
- **ANTHROPIC_API_KEY** (string): Claude API key for document classification
  - Obtain from: https://console.anthropic.com
  - Cost: ~$0.01-0.02 per document

### Optional
- **AI_BACKEND** (string): "anthropic" (default) or "ollama"
- **DATABASE_URL** (string): SQLite path, defaults to backend/reports.db
- **LIBREOFFICE_PATH** (string): Path to soffice binary, defaults to "soffice"
- **GHOSTSCRIPT_PATH** (string): Path to gs binary, defaults to "gs"
- **TESSERACT_PATH** (string): Path to tesseract binary, defaults to "tesseract"

### Development-Only
- **OLLAMA_URL** (string): Ollama server address, defaults to http://localhost:11434
- **OLLAMA_MODEL** (string): Model to use, defaults to qwen2.5:7b

---

## System Requirements

### Deployment Platform (Render/Fly.io)
- Docker support ✅
- Python 3.11+ ✅
- 512MB RAM minimum
- 1GB disk space minimum
- Internet access for API calls

### Local Development
**Ubuntu/Debian:**
```bash
sudo apt-get install python3.11 python3-pip libreoffice ghostscript tesseract-ocr
```

**macOS:**
```bash
brew install python@3.11 libreoffice ghostscript tesseract node
```

**Windows:**
- Python 3.11: https://www.python.org
- LibreOffice: https://www.libreoffice.org
- Ghostscript: https://www.ghostscript.com
- Tesseract: https://github.com/UB-Mannheim/tesseract/wiki
- Node.js: https://nodejs.org

---

## Build & Test Checklist

Before deploying to production:

### Local Validation
- [ ] `python backend/main.py` starts without errors
- [ ] `curl http://localhost:8000/health` returns 200
- [ ] Frontend loads at `http://localhost:8000`
- [ ] PDF upload works
- [ ] Document classification works (via AI)
- [ ] Report assembly completes in <5 minutes

### Docker Validation
- [ ] `docker build -f Dockerfile.prod -t odic:test .` succeeds
- [ ] `docker run -p 8000:8000 odic:test` starts successfully
- [ ] Health check passes via curl
- [ ] Frontend UI loads
- [ ] Test upload works

### Platform Validation (Post-Deploy)
- [ ] Health endpoint responds at `{url}/health`
- [ ] API endpoints respond at `{url}/api/reports`
- [ ] Frontend loads and is interactive
- [ ] Test upload completes
- [ ] Test assembly completes <5 min
- [ ] No errors in platform logs

---

## Troubleshooting

### Build Fails: "No module named 'pypdfium2'"
**Cause**: requirements.txt missing dependencies  
**Fix**: Rebuild Docker image - requirements.txt now includes all deps

### Docker Build Timeout
**Cause**: LibreOffice installation is slow  
**Fix**: This is normal, can take 3-5 minutes. Be patient or upgrade to paid tier.

### Deployment 504 (Gateway Timeout)
**Cause**: PDF assembly is taking too long  
**Fix**: Should not happen with intelligent sampling. Check logs:
```
curl {url}/logs
```

### LibreOffice Conversion Error
**Cause**: `.soffice` binary not found  
**Fix**: Already in Docker image. If local error, install:
```bash
sudo apt-get install libreoffice
```

### Anthropic API Key Not Set
**Cause**: Environment variable missing or wrong value  
**Fix**: Set in platform dashboard:
```
ANTHROPIC_API_KEY=sk-ant-oat01-SDTNBb2FNQf3fYU6NcbWJSRZqJDZHy4p2M4N3mmnRq6bAaDtUSUnwG9GWMEbE7UAQnU nwqS7lABp6Mcdla-GxA-6vfLWQAA
```

### Database File Not Found
**Cause**: Render/Fly.io doesn't persist /app directory  
**Fix**: Set `DATABASE_URL=/data/reports.db` (both platforms support `/data` mount)

---

## Monitoring & Logs

### Render.com
- Dashboard: https://dashboard.render.com/
- Logs: Click service → "Logs" tab
- Metrics: Memory, CPU, request count

### Fly.io
```bash
flyctl logs -a odic-esa
flyctl monitoring -a odic-esa
```

### Local Docker
```bash
docker logs {container_id}
docker stats {container_id}  # CPU/Memory usage
```

---

## Performance Expectations

| Operation | Time | Cost |
|-----------|------|------|
| Single PDF upload | <5s | ~$0.005 |
| Classify 10 docs | <10s | ~$0.02 |
| Assemble 50-doc report | 2-4 min | ~$0.50 |
| Full 90-doc report | 4-5 min | ~$0.90 |

**Note**: Costs assume Anthropic Claude. Ollama (local) is free but slower for large batches.

---

## Rollback Plan

If deployment fails:

1. **Check Render dashboard** for build errors
2. **Review recent commits** - last working version before the issue
3. **Rollback to previous** deployment in Render dashboard (1-click)
4. **Local testing** - test fixes locally before re-pushing

---

## Next Steps

1. Choose deployment platform (Render recommended)
2. Click deploy link or manually push to main
3. Configure environment variables
4. Run health check
5. Test with sample PDFs
6. Validate with 6384674-ESAI project (554 files)

**Estimated deployment time**: 5-10 minutes (including build)

---

**Questions?** See README.md or ARCHITECTURE.md for more context.

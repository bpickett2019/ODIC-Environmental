# BMAD Phase 2: Product Requirements & Fix Plan
## ODIC Environmental ESA Report Assembly System
**Date**: 2026-03-02 02:50 AM  
**Planning Team**: John (PM) + Sally (UX)  
**Input**: PHASE_1_ANALYSIS.md  
**Status**: COMPLETE

---

## Fix Priority & Roadmap

### Release 1: Deployment-Ready (Today, 2 hours)
**Goal**: Eliminate 14 blockers, achieve B+/A grade

| Issue | Fix | Owner | Effort | Blocker |
|-------|-----|-------|--------|---------|
| 1 | Add missing deps to requirements.txt | Bob (Backend) | 5 min | YES |
| 2 | Build frontend (npm run build) | Amelia (Frontend) | 2 min | YES |
| 3 | Verify LibreOffice in Docker | Bob | 5 min | YES |
| 4 | Verify Ghostscript in Docker | Bob | 5 min | YES |
| 5 | Verify Tesseract in Docker | Bob | 5 min | YES |
| 8 | Document API key setup | John | 2 min | YES |
| 11 | Update config for persistent DB | Bob | 5 min | YES |
| 13 | Fix render.yaml configs | Bob | 5 min | YES |

**Subtotal**: ~35 minutes

### Release 2: Functionality Complete (Phase 4, 1-2 hours)
**Goal**: All features working end-to-end

| Issue | Fix | Owner | Effort | Blocker |
|-------|-----|-------|--------|---------|
| 10 | Mount static directory properly | Bob | 5 min | Medium |
| 12 | Add DOCX editing UI | Amelia | 1-2 hours | Low |
| 14 | Re-enable deployment workflow | Bob | 5 min | Medium |

**Subtotal**: 1.5-2.5 hours

### Release 3: Optimization (Post-Deployment)
**Goal**: Performance tuning, monitoring

| Item | Task | Effort |
|------|------|--------|
| Caching | Add redis/in-memory caching for classifications | 1 hour |
| Logging | Set up structured logging for production | 30 min |
| Monitoring | Add APM (Sentry/New Relic) | 1 hour |

---

## Fix Strategy by Category

### Dependencies (Issue 1)
**Current**: 17 dependencies  
**Missing**: 5  
**Action**: Add to `backend/requirements.txt`:

```
pypdfium2==1.18.0
pdf2image==1.17.0
ollama==0.2.0
opencv-python==4.8.0
```

Note: `anthropic==0.28.0` already listed but may need version check.

---

### Frontend Build (Issue 2)
**Current**: Source code exists, no dist build  
**Action**:
```bash
cd frontend
npm ci --legacy-peer-deps
npm run build
cp -r dist ../backend/static
```

**Time**: 2 minutes (builds are fast with Vite)

---

### System Dependencies (Issues 3-5)
**Current**: Docker includes them ✅  
**Risk**: Build might timeout on resource-constrained hosts  
**Action**: 
- ✅ Keep in Dockerfile.prod (libreoffice, ghostscript, tesseract-ocr)
- Document local setup: SYSTEM_REQUIREMENTS.md updated
- Add installation script for Windows/macOS

---

### Environment Configuration (Issues 8, 11)
**Current**: Hardcoded defaults  
**Action**: Create deployment guide with required env vars:

```bash
# Render.com environment:
AI_BACKEND=anthropic
ANTHROPIC_API_KEY=sk-ant-xxx
DATABASE_URL=sqlite:////data/reports.db
LIBREOFFICE_PATH=soffice
GHOSTSCRIPT_PATH=gs
TESSERACT_PATH=tesseract

# OR use Ollama:
AI_BACKEND=ollama
OLLAMA_URL=http://localhost:11434
```

---

### Deployment Platform (Issue 7)
**Recommendation**: 
- ❌ **NOT Vercel** (60s timeout limit, assembly needs 300s)
- ✅ **Render.com** (preferred - persistent storage, Python support)
- ✅ **Fly.io** (alternative - free tier, good performance)

**Decision**: Use Render.com (better DX, simpler setup)

---

## Success Criteria

### Before Phase 4 Starts
- [ ] PHASE_1_ANALYSIS.md complete (input for planning) ✅
- [ ] PHASE_2_PRD.md complete with priorities ✅
- [ ] Deployment platform decision made: **Render.com**
- [ ] Environment variable checklist ready

### After Phase 4 Fixes
- [ ] All 14 blockers resolved
- [ ] `docker build -f Dockerfile.prod .` succeeds
- [ ] Local test: `python backend/main.py` runs without errors
- [ ] Local test: Frontend accessible at `http://localhost:8000`
- [ ] Local test: API endpoints respond correctly

### After Phase 5 Deployment
- [ ] App deployed to Render.com
- [ ] Health check: `curl {url}/health` → 200 OK
- [ ] Upload test: Single PDF works
- [ ] Assembly test: 10-doc report completes in <5 min
- [ ] Chat test: Document questions answered via AI
- [ ] 6384674-ESAI validation: 554 files, 90 selected, <5 min assembly

---

## Phase 3 Architecture Decisions

**ADR-008**: Use requirements.txt for missing deps (not poetry/pipenv)  
**ADR-009**: Frontend build as part of Docker build (not pre-built)  
**ADR-010**: Render.com as primary deployment target  
**ADR-011**: ANTHROPIC_API_KEY required for production (Ollama optional)  

---

## Phase 4 Implementation Task List

### Task 1: Update Python Dependencies (Bob)
- Edit `backend/requirements.txt`
- Add 5 missing deps
- Test: `pip install -r requirements.txt`

### Task 2: Build Frontend (Amelia)
- `cd frontend && npm run build`
- Verify `frontend/dist/` created
- Copy to backend static dir

### Task 3: Verify Docker Build (Bob)
- `docker build -f Dockerfile.prod -t odic:latest .`
- Ensure: Node build stage succeeds, Python deps install, all system packages present

### Task 4: Update Config Files (Bob)
- Fix render.yaml (ensure frontend build step)
- Update environment variable docs
- Add deployment setup guide

### Task 5: Local Testing (Team)
- Run: `docker build & docker run -p 8000:8000`
- Test API: `/health`, `/api/reports`, `/api/reports/{id}`
- Test UI: `http://localhost:8000`
- Test assembly: Single document, then 10 documents

### Task 6: Re-enable Deployment (Bob)
- Rename `render-deploy.yml.disabled` → `.github/workflows/render-deploy.yml`
- Commit: `chore: enable Render deployment workflow`
- Configure Render secrets: ANTHROPIC_API_KEY

### Task 7: Deploy & Validate (Rose - Phase 5)
- Click: Deploy on Render
- Health check: `curl {url}/health`
- Upload test: PDF file
- Assembly test: 10-doc report
- Validation: 6384674-ESAI project (554 files)

---

## Risk Assessment

### High Risk
- **Issue 7 (Vercel timeout)**: Mitigated by using Render instead ✅
- **System package build time**: Docker build might timeout on shared CI runners
  - Mitigation: Use Render's native buildpacks OR split into layers
- **Ollama connectivity**: May fail if not running
  - Mitigation: Default to Anthropic, make Ollama optional

### Medium Risk
- **Frontend build peer deps**: Already handled with `--legacy-peer-deps` ✅
- **Database migration**: SQLite auto-creates, but production backup needed
  - Mitigation: Document backup procedure

### Low Risk
- **DOCX editing**: Phase 2 incomplete but not critical for MVP
  - Mitigation: Can add post-deployment

---

## Communication & Handoff

**To Phase 3 (Winston - Architect)**:
- PHASE_1_ANALYSIS.md (14 blockers identified)
- PHASE_2_PRD.md (priorities + success criteria)
- Fix strategy: 14 blockers → 8 critical (Release 1) + 3 medium (Release 2)
- Platform decision: **Render.com**

**From Phase 3**:
- ADRs 8-11 (dependency management, frontend, deployment, API keys)
- Detailed fix specs for each blocker

**To Phase 4 (Bob + Amelia)**:
- ARCHITECTURE_DECISIONS.md with ADRs
- Task list (7 specific implementation tasks)
- Success criteria per task

**To Phase 5 (Rose - DevOps)**:
- Deployment checklist (health check, test data, validation)
- Rollback plan if needed
- Monitoring setup

---

## Timeline

| Phase | Duration | End Date |
|-------|----------|----------|
| Phase 1 (Analysis) | 10 min | 02:45 AM ✅ |
| Phase 2 (Planning) | 10 min | 02:55 AM ✅ |
| Phase 3 (Solutioning) | 10 min | 03:05 AM |
| Phase 4 (Implementation) | 1.5 hours | 04:35 AM |
| Phase 5 (Deployment) | 30 min | 05:05 AM |
| **Total** | **2 hours** | **05:05 AM** |

---

**End of PRD - Ready for Phase 3 Architecture Decisions**

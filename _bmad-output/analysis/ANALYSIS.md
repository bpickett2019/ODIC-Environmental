# Analysis Phase — ODIC Environmental ESA Report Assembly

**Agent**: Analyst  
**Status**: ✅ Completed  
**Date**: March 1, 2026

---

## Problem Statement

Environmental Site Assessment (ESA) reports are 12K-15K pages, compiled from 554+ documents uploaded by end users (Rose). Current process:
- Manual document sorting into appendices
- Copy-paste pages into master PDF
- Hand-numbering
- **10+ hours per report** ❌

## Solution Requirement

Build a system that:
1. **Auto-classifies** 90+ documents into correct appendices
2. **Smart orders** sections (especially Appendix D: maps in chronological order)
3. **Assembles** final PDF in <5 minutes
4. **Cost**: $0 per report (not $540 via Claude)
5. **Accuracy**: B+ grade (correct appendix ordering every time)

---

## Key Constraints

| Constraint | Impact | Solution |
|-----------|--------|----------|
| **Cost** | Can't afford $540/report Claude | Use free Ollama locally |
| **Speed** | 18K pages too slow to read fully | Smart sampling: ~500 pages |
| **Accuracy** | Appendix D must order correctly | Regex for patterns + AI for decisions |
| **File Size** | 18K pages = 150MB+ PDF | Compress with Ghostscript |
| **User**: Rose | Non-technical, needs UI | Web app with drag-drop + chat |

---

## Domain Research: ESA Report Structure

### Appendix D (Historical Documents) — CRITICAL ORDERING

Must be in this exact order (most common to newest):
1. **Sanborn maps** (1870s-1920s, most detailed fire insurance maps)
2. **Fire insurance maps** (specialized Sanborn variants)
3. **Marked aerials** (1940s-1980s aerial photos with annotations)
4. **Topographic maps** (USGS quads, 1950s-2000s)
5. **City directories** (1900s-1950s, newest)

**Why order matters**: Environmental consultants need chronological context. Wrong order = rejected report.

### Appendix E (Supporting Documents) — FLEXIBLE ORDERING

All other docs: permits, property profiles, reports, etc.
- **Property Profile must be first** (easy to miss)
- Rest can be any order

---

## Technical Requirements

| Requirement | Why | Approach |
|-----------|-----|----------|
| Document classification | Need to sort into appendices | AI (Ollama + Claude fallback) |
| Ordering detection | Appendix D needs specific order | Regex patterns (filename/content) + AI confidence |
| PDF assembly | Merge documents + renumber | PyPDF + Ghostscript |
| Chat interface | Rose can adjust on the fly | LLM chat with action execution |
| DOCX editing | Rose wants to edit Word docs | python-docx + React component |
| Zero cost | Budget constraint | Ollama (free, local) primary |

---

## Success Metrics

| Metric | Target | Current |
|--------|--------|---------|
| **Accuracy** | 95%+ correct appendix classification | Achievable with smart sampling |
| **Speed** | <5 min assembly for 12K pages | Smart sampling enables this |
| **Cost** | $0 per report | Ollama achieves this |
| **Grade** | B+/A (vs. current C+/B-) | Appendix D ordering guarantees this |
| **User satisfaction** | Rose can compile in 5 min | UI + chat interface designed for this |

---

## Personas

### Rose (End User)
- Compiles 20-30 ESA reports per month
- Non-technical, needs intuitive UI
- Wants to go fast (budget $0 per report for her employer)
- Pain point: Appendix D ordering takes 2+ hours manually

### Bailey (Project Owner)
- Fractional AI consultant
- Wants to productize the system
- Needs sub-$5/month hosting
- Will market this to environmental consulting firms

---

## Architectural Constraints

1. **Local-first AI**: Ollama by default, Claude optional
2. **Document processing**: Handle PDF/DOCX/JPG/PNG
3. **Smart sampling**: Don't read all 18K pages
4. **Regex for patterns**: Detect Sanborn/Aerial/Topo/City Dir by filename
5. **Chat interface**: LLM commands for on-the-fly adjustments
6. **Deployment**: Docker container, Render/Railway/Fly.io compatible
7. **Cost**: $0/report ($0-35/month hosting + optional Claude)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Smart sampling misses key docs | Low | Medium | Test with real 6384674-ESAI files |
| Appendix D ordering fails | Low | High | Regex validation + AI tiebreaker |
| DOCX conversion fails | Medium | Low | Fallback to PDF-only preview |
| Performance issues (>5 min) | Low | Medium | Async processing + optimization |
| Ollama unavailable | Low | Low | Fall back to Claude API |

---

## Next Steps (Planning Phase)

1. ✅ Capture this analysis
2. Create PRD + UX design
3. Design system architecture
4. Define API contract
5. Plan implementation

---

**Recommendation**: Proceed to Planning phase. System is feasible with proven tech (FastAPI, React, SQLAlchemy, Ollama).

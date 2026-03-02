# Product Requirements Document (PRD)

**Product**: ODIC Environmental ESA Report Assembly System  
**Owner**: Bailey (Fractional AI Consultant)  
**Version**: 1.0  
**Date**: March 1, 2026

---

## Executive Summary

Web application that assembles 12K-15K page Environmental Site Assessment (ESA) reports from 554+ uploaded documents in <5 minutes, with zero cost per report.

**Target user**: Rose (ESA report compiler)  
**Primary metric**: Time to compile report drops from 10+ hours to <5 minutes

---

## Product Goals

1. **Accuracy**: B+/A grade (correct Appendix D ordering guaranteed)
2. **Speed**: <5 minutes for 12K-page report assembly
3. **Cost**: $0 per report (no per-document AI costs)
4. **Usability**: Rose can operate without technical training
5. **Extensibility**: Can be productized to other consulting firms

---

## User Stories

### Story 1: Upload & Auto-Classify
```
As Rose, I want to upload 90 ESA documents
So that the system automatically sorts them into appendices
Acceptance: 
- Upload PDF/DOCX/JPG files
- System classifies within 30 seconds
- I see correct category for each doc
```

### Story 2: Fix Ordering Issues
```
As Rose, I want to move documents if classified wrong
So that the final report is accurate
Acceptance:
- Chat: "Move docs 5,6,7 to Appendix D"
- Drag-and-drop reordering (optional)
- Undo available if I make mistakes
```

### Story 3: Assemble Report
```
As Rose, I want to click "Assemble" and get final PDF
So that I can deliver to clients
Acceptance:
- Click button (or chat: "Assemble report")
- Takes <5 minutes
- PDF auto-compressed for email
- Page numbers correct
```

### Story 4: Edit DOCX Files
```
As Rose, I want to preview and edit DOCX documents
So that I don't have to re-upload edited versions
Acceptance:
- View DOCX content in browser
- Edit paragraphs inline
- Save changes
- PDF version auto-updated
```

---

## Feature List

### MVP (Phase 1)
- ✅ Document upload (PDF, DOCX, JPG, PNG)
- ✅ AI classification (Ollama + Claude fallback)
- ✅ Smart sampling (18K pages → 500 pages)
- ✅ Intelligent ordering (Appendix D, E)
- ✅ PDF assembly + page numbering
- ✅ Chat interface (move, exclude, include, assemble)
- ✅ Basic DOCX preview
- ✅ Docker deployment
- ✅ Render/Railway/Fly.io support

### Phase 2 (Post-Launch)
- ⏳ In-browser DOCX editing
- ⏳ Performance monitoring
- ⏳ Error tracking (Sentry)
- ⏳ Multi-user support
- ⏳ Batch report assembly

---

## Technical Approach

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **AI Backend** | Ollama (primary) + Claude (optional) | Free for most cases, pay-per-use for tiebreakers |
| **Page Sampling** | First 5 + Last 3 + Every 100th | Reads ~500 pages, captures metadata |
| **Ordering** | Regex for hints + AI for confidence | Fast, reliable, costs $0 |
| **Frontend** | React 19 + TypeScript | Modern, type-safe, familiar |
| **Backend** | FastAPI + SQLAlchemy | Fast, async, good ORM |
| **Database** | SQLite (dev) + PostgreSQL (prod) | Simple, scalable |
| **Deployment** | Docker + Render/Railway/Fly.io | Single container, 2-3 min setup |
| **Cost** | $0 per report ($5-35/month hosting) | Meets budget requirement |

---

## Success Criteria

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| **Speed** | <5 min for 12K pages | Timer on PDF assembly |
| **Accuracy** | 95%+ correct classification | Test with 6384674-ESAI |
| **Cost** | $0 per report | No Claude calls in default mode |
| **Usability** | Rose needs <5 min training | User guide + intuitive UI |
| **Reliability** | 99% uptime | Render/Railway monitoring |
| **Grade** | B+/A (vs C+/B-) | Stakeholder evaluation |

---

## Timeline

| Phase | Duration | Owner |
|-------|----------|-------|
| Analysis | 2 hours | ✅ Complete |
| Planning | 3 hours | ✅ Complete |
| Solutioning | 4 hours | ✅ Complete |
| Implementation | 8 hours | ✅ 95% complete |
| Deployment | 2 hours | ⏳ Pending |
| **Total** | **~20 hours** | |

---

## Dependencies

- Python 3.11+
- Node.js 20+
- LibreOffice (document conversion)
- Ghostscript (PDF compression)
- Ollama (if using local AI)
- Render/Railway/Fly.io account (for cloud)

---

## Constraints

1. **Cost**: Must be <$0.10/report for end user
2. **Performance**: <5 minutes for assembly
3. **Accuracy**: Appendix D ordering must be 100% correct
4. **File size**: Output PDF <150MB for email
5. **User skill**: Rose is non-technical, needs intuitive UI

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Smart sampling misses docs | Test with real 6384674-ESAI data before launch |
| Ollama unavailable | Claude fallback configured |
| PDF too large | Auto-compress with Ghostscript |
| Appendix ordering wrong | Regex validation + user can fix via chat |

---

## Success Definition

✅ Rose can compile a 12K-page ESA report from 554 documents in <5 minutes of active time, with zero AI costs, and 95%+ accuracy on Appendix ordering.

---

**Status**: ✅ Ready for Solutioning Phase

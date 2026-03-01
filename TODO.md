# ODIC ESA Report Assembly System - Task List (85 Tasks, 12 Phases)

## Phase 1: Project Setup & Server Foundation (7 tasks)
- [x] 1. Create backend directory structure (backend/, skills/, core/, config/, uploads/, projects/)
- [x] 2. Create requirements.txt with all dependencies (fastapi, uvicorn, pymupdf, pillow, reportlab, openai, python-multipart, aiofiles)
- [x] 3. Create main FastAPI app with CORS, health check endpoint
- [x] 4. Create config system (env vars for LLM endpoint/key/model, upload limits, project dirs)
- [x] 5. Create project state manager (JSON-file based, create/load/save per project)
- [x] 6. Create error handling middleware and structured logging
- [x] 7. Verify: uvicorn starts without errors, health check returns 200

## Phase 2: File Upload & ZIP Processing (8 tasks)
- [x] 8. Create chunked upload endpoint (POST /api/upload) supporting up to 2GB
- [x] 9. Create ZIP extraction with streaming (never load entire ZIP into memory)
- [x] 10. Create file inventory endpoint - returns list of extracted files with metadata
- [x] 11. Create project creation endpoint (POST /api/projects)
- [x] 12. Create project listing endpoint (GET /api/projects)
- [x] 13. Create project detail endpoint (GET /api/projects/{id})
- [x] 14. Handle corrupt/invalid ZIP files gracefully (flag, don't crash)
- [x] 15. Verify: can upload a test ZIP and get file inventory back

## Phase 3: File Conversion (7 tasks)
- [x] 16. Create file type detector (PDF, DOCX, DOC, JPG, PNG, TIFF, BMP)
- [x] 17. Create image-to-PDF converter (Pillow → reportlab, maintain aspect ratio)
- [x] 18. Create Word-to-PDF converter (LibreOffice headless subprocess)
- [x] 19. Create conversion pipeline that normalizes all files to PDF
- [x] 20. Handle corrupt/unreadable files (flag as corrupt, skip, never crash)
- [x] 21. Create conversion status tracking in project state
- [x] 22. Verify: mixed file types all convert to PDF

## Phase 4: Text Extraction (6 tasks)
- [x] 23. Create PDF text extractor using PyMuPDF (fitz)
- [x] 24. Handle scanned/image-only PDFs (flag for OCR, extract what's possible)
- [x] 25. Extract metadata: page count, file size, content hash for dedup
- [x] 26. Create text extraction endpoint (GET /api/projects/{id}/documents/{doc_id}/text)
- [x] 27. Store extracted text in project state per document
- [x] 28. Verify: text extracts from PDFs correctly

## Phase 5: LLM Router (6 tasks)
- [x] 29. Create LLM router using OpenAI-compatible client (openai pip package)
- [x] 30. Configure via env vars: OPENAI_API_BASE, OPENAI_API_KEY, OPENAI_MODEL
- [x] 31. Create graceful fallback when no API key (rule-based classification)
- [x] 32. Create retry logic with exponential backoff
- [x] 33. Create token/cost tracking per request
- [x] 34. Verify: LLM router connects (or gracefully fails if no key)

## Phase 6: Document Classification (9 tasks)
- [x] 35. Create classification taxonomy matching ESA structure (15+ doc types)
- [x] 36. Create LLM classification prompt with authorship detection
- [x] 37. Create rule-based fallback classifier (keyword matching)
- [x] 38. Classify each doc: type, confidence 0-100, reasoning string
- [x] 39. Detect authorship: is this authored by ODIC or another firm?
- [x] 40. Flag reference reports (non-ODIC authored) separately
- [x] 41. Create classification endpoint (POST /api/projects/{id}/classify)
- [x] 42. Create AI reasoning storage - every classification stores reasoning
- [x] 43. Verify: classifier returns valid JSON with classification, confidence, reasoning

## Phase 7: Report Assembly & Template (9 tasks)
- [x] 44. Create ESA template structure (sections, appendices A-F, ordering rules)
- [x] 45. Create template auto-detection: Template A (with reliance letter) vs Template B (without)
- [x] 46. Map classified documents to template sections
- [x] 47. Enforce Appendix D ordering: Sanborn → Aerials → Topos → City Directories
- [x] 48. Place reference reports (non-ODIC) AFTER Appendix E, BEFORE Appendix F
- [x] 49. Create assembly state with section-document mapping
- [x] 50. Create assembly endpoints (GET/PUT /api/projects/{id}/assembly)
- [x] 51. Store assembly reasoning (why each doc placed where) for AI panel
- [x] 52. Verify: assembler produces correct template order

## Phase 8: Frontend Setup (7 tasks)
- [x] 53. Initialize React + Vite + Tailwind CSS project
- [x] 54. Create app layout with header, sidebar navigation
- [x] 55. Create project list page
- [x] 56. Create new project dialog
- [x] 57. Create API client service (fetch wrapper with error handling)
- [x] 58. Create WebSocket or SSE connection for real-time updates
- [x] 59. Verify: frontend renders, dev server starts

## Phase 9: Frontend Document View & Classification (8 tasks)
- [x] 60. Create file upload component with drag-and-drop ZIP upload
- [x] 61. Create upload progress bar (chunked upload progress)
- [x] 62. Create document list view showing all files with status
- [x] 63. Create classification trigger button
- [x] 64. Create AI reasoning panel - shows classification, confidence, reasoning per doc
- [x] 65. Create real-time classification progress (SSE updates as each doc classifies)
- [x] 66. Show reliance letter detection result in AI panel
- [x] 67. Verify: frontend connects to backend, shows real-time classification

## Phase 10: Frontend Assembly & Review (7 tasks)
- [x] 68. Create assembly view showing template structure with mapped documents
- [x] 69. Create drag-and-drop document reorder within sections
- [x] 70. Create drag-and-drop move documents between sections
- [x] 71. Create add/remove document from assembly
- [x] 72. Create AI reasoning panel for assembly (why each doc placed where)
- [x] 73. Show Template A vs B decision with reasoning
- [x] 74. Verify: assembly view renders with drag-and-drop working

## Phase 11: Export & PDF Merge (7 tasks)
- [x] 75. Create appendix divider page generator (reportlab)
- [x] 76. Create PDF merger (PyMuPDF) - merge all docs in assembly order
- [x] 77. Create image compression (300 DPI max) during merge
- [x] 78. Create auto-split at 25MB at section boundaries
- [x] 79. Create export endpoint (POST /api/projects/{id}/export)
- [x] 80. Create download endpoint for exported files
- [x] 81. Verify: export produces valid merged PDF with divider pages

## Phase 12: End-to-End Integration (4 tasks)
- [x] 82. Full flow test: upload ZIP → classify → review → assemble → export
- [x] 83. Error recovery: corrupt files skip gracefully, no crashes
- [x] 84. Performance: 2GB ZIP upload streams without memory issues
- [x] 85. Verify: complete end-to-end flow works

---
**Progress: 85/85 tasks complete**

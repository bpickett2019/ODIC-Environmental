# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Environmental Report Assembler for ODIC Environmental. Automates Phase I ESA report assembly: upload documents, classify them into report sections, reorder, preview, assemble into a single PDF, and compress. A properly assembled report is typically 1,000–4,000 pages.

## Running

```bash
# Backend (FastAPI on :8000)
cd backend && python3 -m uvicorn main:app --port 8000 --reload

# Frontend (Vite on :5173, proxies /api → :8000)
cd frontend && npm run dev

# Lint frontend
cd frontend && npm run lint

# Build frontend
cd frontend && npm run build
```

Backend requires a `.env` file in `backend/` with `ANTHROPIC_API_KEY` if using Claude for classification. Default AI backend is Ollama (local, free).

## Architecture

**Backend** (`backend/`): Single FastAPI app. All routes in `main.py`. No test infrastructure.

- `main.py` — All API routes + upload/classification/assembly orchestration (~1300 lines)
- `classifier.py` — Two-tier: regex filename matching (handles 98%+) → AI fallback (Ollama or Anthropic)
- `assembler.py` — Merges PDFs with pypdf, groups by SectionCategory, sorts within sections
- `converter.py` — Converts non-PDF formats to PDF (LibreOffice for docx/vsd, Pillow/ReportLab for images, sips for HEIC)
- `compressor.py` — Ghostscript-based PDF compression with quality presets
- `database.py` — SQLAlchemy ORM, SQLite. Two tables: `reports` and `documents`
- `models.py` — Pydantic schemas and enums (SectionCategory, DocumentStatus, ReportStatus)
- `config.py` — Pydantic Settings with all config (paths, AI backend, external tool paths, section order)

**Frontend** (`frontend/`): React 18 + TypeScript + Vite + Tailwind 4 (via Vite plugin, no tailwind.config).

- `App.tsx` — No router. State-based view switching.
- `stores/reportStore.ts` — Single Zustand store for all app state
- `api/client.ts` — Axios client + custom SSE stream consumer for POST-based Server-Sent Events
- Components detailed in redesign section below

**Data flow**: Frontend → axios → Vite proxy → FastAPI. Long operations use SSE via `fetch()` + `ReadableStream` (not EventSource, since they're POST requests).

**File storage**: `uploads/{report_id}/originals/` (UUID-named), `uploads/{report_id}/pdfs/`, `uploads/{report_id}/output/` (assembled). All served via `FileResponse`.

## External Tool Dependencies

LibreOffice (`soffice`), Ghostscript (`gs`), Tesseract (`tesseract`) — must be installed on the system. macOS `sips` used for HEIC conversion.

---

## PRIORITY: Full Frontend Redesign

The current UI is not user-friendly. It requires too many manual clicks (upload → click classify → wait → click assemble → wait → navigate to preview). The redesign makes it a **single-page, zero-manual-step experience**.

### The Flow
1. User drops a folder/zip → system **immediately** starts the full pipeline (convert → classify → deduplicate → detect compiled reports → assemble)
2. Progress bar shows real-time status → "Converting 554 files... Classifying... Assembling..."
3. When done → **full assembled PDF preview takes over the main area** with a sidebar showing report structure
4. User reviews by scrolling through the assembled report. Sidebar highlights current section.
5. If something is wrong → user expands a section in sidebar, reclassifies/removes/reorders docs
6. After changes → "Re-assemble" button appears → one click → preview updates

### What's Wrong Now
- Left panel is cramped — filenames aren't visible, only file sizes show
- Preview pane is empty and useless until you click individual docs
- "AI Classify" and "Assemble Report" are separate manual buttons — should be automatic after upload
- No assembled report preview on the main screen — it's the primary thing the user needs to see
- Upload zone takes up prime screen real estate after files are uploaded
- Section headers don't show full appendix labels
- 6 documents in Cover/Write-Up including a 1,702-page compiled report that shouldn't be there (bugs listed below)

### New Layout: Single-Page Dashboard
```
┌──────────────────────────────────────────────────────────────────┐
│ HEADER: Project name (editable) | Status | Re-assemble | Download│
├────────────────────────┬─────────────────────────────────────────┤
│                        │                                         │
│  SIDEBAR (380px)       │  MAIN AREA (flex-1)                    │
│                        │                                         │
│  [+ Add more files]    │  Before upload:                        │
│                        │    Full-screen centered drop zone       │
│  ┌─ Report TOC ─────┐ │                                         │
│  │ Reliance Letter   │ │  During processing:                    │
│  │ E&O Insurance     │ │    Progress overlay with file counts   │
│  │ Cover / Write-Up  │ │                                         │
│  │ APPENDIX A – Maps │ │  After assembly:                       │
│  │ APPENDIX B – Phot │ │    FULL PDF PREVIEW of assembled report│
│  │ APPENDIX C – Data │ │    (scrollable, zoomable iframe)       │
│  │ APPENDIX D – Hist │ │                                         │
│  │ APPENDIX E – Agen │ │  After changes:                        │
│  │ Reports After E   │ │    Same preview but "Re-assemble"      │
│  │ APPENDIX F – Qual │ │    button appears in header            │
│  │                   │ │                                         │
│  │ ⚠ Excluded (3)   │ │                                         │
│  │ ❌ Errors (2)     │ │                                         │
│  └───────────────────┘ │                                         │
│                        │                                         │
├────────────────────────┴─────────────────────────────────────────┤
│ FOOTER: 1,847 pages · 24.3 MB (from 116 MB) | Compress | Email  │
└──────────────────────────────────────────────────────────────────┘
```

### Component Structure
```
App.tsx
└── ReportDashboard.tsx              (single-page main view)
    ├── UploadOverlay.tsx            (full-screen drop zone — shown when no files)
    ├── ProcessingOverlay.tsx        (progress bar during pipeline)
    ├── Sidebar.tsx                  (report structure / TOC)
    │   ├── SidebarSection.tsx       (one appendix section, expandable)
    │   │   └── DocRow.tsx           (one document — filename, pages, confidence, actions)
    │   ├── ExcludedPanel.tsx        (auto-excluded docs with reasoning + re-include toggle)
    │   └── ErrorPanel.tsx           (failed conversions + "Retry All" button)
    ├── PDFPreview.tsx               (main area — assembled report in iframe)
    └── ActionBar.tsx                (footer — pages, size, compress, download, email)
```

### Sidebar Section Requirements
Each section shows:
- **Full appendix label**: "APPENDIX D – Historical Records Research"
- **Doc count and page count**: "8 docs · 342 pages"
- **Status icon**: ✅ has docs | ⚠️ empty | 🔴 has errors
- **Expandable** — click to see individual documents
- **Each document row**: filename (always visible, truncated with tooltip), page count, small confidence dot (green/amber/red), classification reason in small gray text
- **Actions per doc**: reclassify dropdown, exclude toggle, preview icon, move up/down
- **Drag-and-drop** between sections to reclassify

### Excluded & Errors (Bottom of Sidebar)
- **Excluded**: Auto-excluded by AI (compiled reports, old versions). Each shows reasoning. Toggle to re-include.
- **Errors**: Failed conversions. "Retry All" button calls reprocess-errors endpoint.

### Upload Behavior
- Upload zone is full-screen centered ONLY when no files exist
- After upload, collapses to a small "+ Add more files" link at top of sidebar
- Dropping files triggers the ENTIRE pipeline automatically — no manual classify/assemble buttons
- Progress shown via SSE in a centered overlay

### Preview Behavior
- After assembly, main area shows FULL assembled PDF (iframe with Content-Disposition: inline)
- Scroll-spy: as user scrolls PDF, sidebar highlights current section
- Click section in sidebar → jumps to that point in PDF
- This is the PRIMARY view — the whole point of the tool

### After Manual Changes
- Any reclassify/exclude/reorder sets `hasUnsavedChanges = true`
- Orange "Re-assemble" button appears in header
- Click → runs assembly only (fast, no re-classify) → preview updates
- Button disappears after successful re-assembly

---

## PRIORITY: Backend Bug Fixes

### Bug 1: HEIC Conversion Crashes (74 files failing)
**File:** `backend/converter.py` — `_convert_heic_to_pdf()`

pillow_heif fails with "Metadata not correctly assigned" on iPhone HEIC photos. macOS `sips` handles them fine.

**Fix:** Try sips first, fall back to pillow_heif:
```python
def _convert_heic_to_pdf(input_path, output_dir):
    output_path = output_dir / f"{input_path.stem}.pdf"
    # Try macOS sips first (handles problematic HEIC metadata)
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_jpg = tmp.name
        subprocess.run(
            ["sips", "-s", "format", "jpeg", str(input_path), "--out", tmp_jpg],
            capture_output=True, timeout=30, check=True,
        )
        img = Image.open(tmp_jpg).convert("RGB")
        _image_to_pdf_page(img, output_path)
        Path(tmp_jpg).unlink(missing_ok=True)
        return output_path
    except Exception as e:
        logger.warning(f"sips failed: {e}, trying pillow_heif...")
    # Fallback: pillow_heif (non-macOS)
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
        img = Image.open(input_path).convert("RGB")
        _image_to_pdf_page(img, output_path)
        return output_path
    except Exception as e:
        logger.error(f"HEIC conversion failed for {input_path.name}: {e}")
        return None
```

### Bug 2: Images Misclassified by Folder Patterns (521 of 554 docs affected)
**File:** `backend/classifier.py` — `classify_by_filename()`

Folder patterns (BLA-, EC_Attachments_, SMEH_*, Geotracker at 0.85 confidence) run BEFORE image detection. Photos in those subfolders get classified as REPORTS_AFTER_E instead of APPENDIX_B. This is the single biggest classification bug.

**Fix:** In the folder patterns block, skip image files so they fall through to image classification:
```python
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".tiff", ".tif", ".gif", ".bmp"}
ext_lower = Path(filename).suffix.lower()

if ext_lower not in IMAGE_EXTENSIONS:
    for pattern, category, reason in folder_patterns:
        if re.search(pattern, path_lower):
            return ClassificationResult(...)
# Images skip folder patterns → fall through to image classification → APPENDIX_B
```

### Bug 3: ESAI Compound Filename Patterns Missing
**File:** `backend/classifier.py` — filename patterns list

Files like `6384674-ESAI-Aerials_1.pdf` don't match. Add to strong filename patterns:
```python
(r"esai[_-]?aerials?|aerials?[_-]?\d*\.pdf", SectionCategory.APPENDIX_D, "aerials", "ESAI Aerial photographs"),
(r"esai[_-]?sanborn", SectionCategory.APPENDIX_D, "sanborn", "ESAI Sanborn maps"),
(r"esai[_-]?topos?[_-]?\d*", SectionCategory.APPENDIX_D, "topos", "ESAI Topographic maps"),
(r"esai[_-]?city[_-]?dir", SectionCategory.APPENDIX_D, "city_directory", "ESAI City directory"),
(r"esai[_-]?radius", SectionCategory.APPENDIX_C, None, "ESAI Radius report"),
(r"esai[_-]?report", SectionCategory.COVER_WRITEUP, None, "ESAI Report"),
```

### Bug 4: Compiled Reports Get Included in Assembly
**File:** `backend/main.py` — upload processing flow

The full 1,702-page previously-assembled report gets uploaded alongside source docs, classified as COVER_WRITEUP, and assembled into the new report (ballooning to 14,000+ pages).

**Do NOT use page count thresholds.** Use content fingerprinting — detect compiled reports by their internal structure:
```python
def is_compiled_report(pdf_path: Path) -> bool:
    text = extract_first_n_pages_text(pdf_path, n=30).lower()
    appendix_markers = ["appendix a", "appendix b", "appendix c",
                        "appendix d", "appendix e", "appendix f"]
    found = sum(1 for m in appendix_markers if m in text)
    has_toc = "table of contents" in text
    has_reliance = "reliance" in text and "letter" in text
    return found >= 3 and (has_toc or has_reliance)

def extract_first_n_pages_text(pdf_path: Path, n: int = 30) -> str:
    import pypdf
    try:
        reader = pypdf.PdfReader(str(pdf_path))
        return "".join(reader.pages[i].extract_text() or "" for i in range(min(n, len(reader.pages))))
    except Exception:
        return ""
```

If detected → `doc.is_included = False` with reasoning. User can override in QA sidebar.

### Bug 5: Multiple Versions of Same Document All Included
**File:** `backend/main.py`

6 files classified as COVER_WRITEUP including 4 revisions of the same DOCX. Only newest should be used.

**Fix:** After classification, deduplicate by normalized filename:
```python
def deduplicate_documents(documents):
    from collections import defaultdict
    groups = defaultdict(list)
    for doc in documents:
        base = re.sub(r'[_-]?(v\d+|rev\d+|final|draft|copy|\(\d+\))', '', doc.original_filename.lower())
        base = Path(base).stem
        groups[base].append(doc)
    for base, versions in groups.items():
        if len(versions) <= 1:
            continue
        versions.sort(key=lambda d: d.file_modified or d.uploaded_at, reverse=True)
        for old in versions[1:]:
            old.is_included = False
            old.reasoning = f"Superseded by newer version: {versions[0].original_filename}"
```

### Bug 6: Reprocess Failed Conversions Endpoint
**Files:** `backend/main.py`, `frontend/src/api/client.ts`, `frontend/src/stores/reportStore.ts`, UI

Create `POST /api/reports/{report_id}/reprocess-errors` — retries all error-status documents with the fixed converter. Returns `{ fixed, remaining_errors }`. Frontend "Retry All" button in the ErrorPanel.

### Bug 7: DOCX Tracked Changes Visible in Output
**File:** `backend/converter.py`

When converting DOCX to PDF, accept all tracked changes and render as "no markup" view. No strikethrough text, no red/pink revision marks, no comment bubbles. All text should be black. Use python-docx to programmatically accept tracked changes before passing to LibreOffice if needed.

---

## Automatic Pipeline (No Manual Buttons)

When files are uploaded, run this full pipeline automatically via SSE:

1. **Convert** all files to PDF (sips for HEIC, LibreOffice for DOCX, Pillow for images)
2. **Classify** every document (filename patterns first → Ollama fallback → OCR for scanned PDFs)
3. **Detect compiled reports** (content fingerprint first 30 pages)
4. **Deduplicate** versions (keep newest, exclude older)
5. **Auto-name** report (extract project number + address from cover doc via Ollama)
6. **Assemble** final PDF (merge all included docs in template order, no divider pages)
7. **Frontend switches** from processing overlay to full PDF preview

Push progress via SSE: "Converting 234/554..." → "Classifying..." → "Assembling..." → "Done! 1,847 pages"

---

## Report Template (Strict Order)

### With Reliance Letter
1. Reliance Letter
2. E&O Insurance
3. Cover / Write-Up (Phase I ESA body)
4. APPENDIX A – Property Location Map & Plot Plan
5. APPENDIX B – Property & Vicinity Photographs
6. APPENDIX C – Database Report (Radius)
7. APPENDIX D – Historical Records Research (sub-order: Sanborn → Aerials → Topos → City Directory)
8. APPENDIX E – Public Agency Records / Other Relevant Documents
9. Reports After E (permits, city records, county records, GeoTracker)
10. APPENDIX F – Qualifications of Environmental Professional

### Without Reliance Letter
Same but skip #1.

### Rules
- No AI-generated divider pages. Documents flow directly section to section.
- Within APPENDIX D, enforce sub-order: Sanborn → Aerials → Topos → City Directory
- Photos (HEIC/JPG/PNG) → APPENDIX B unless filename clearly indicates otherwise
- Match the north star documents: `6384578-ESAI-Report.pdf` and `6384642-ESAI-Report.pdf`

---

## Hard Constraints

1. **All auto-exclusions are overridable.** Nothing permanently deleted. Sets `is_included = False` with `reasoning` string.
2. **No hardcoded page count limits** for compiled report detection. Content fingerprinting only.
3. **A good report is 1,000–4,000 pages.** Individual source docs can be hundreds of pages.
4. **Preview endpoints must use `Content-Disposition: inline`**, not `attachment`.
5. **Filenames must always be visible** in sidebar document rows.
6. **Assembled PDF preview is the main view** — not hidden behind clicks.
7. **No AI-generated content in the report** — no emails, no dividers, no generated text. System only organizes and merges.
8. **DOCX tracked changes:** Accept all, render as "no markup", all text black.
9. **Never modify document content.** Only convert formats and merge PDFs.
10. **Compression must maintain readability.** Reports go to clients and regulators.

## Visual Design

- Clean, professional, minimal — environmental consulting firm context
- White/light gray background, sidebar with subtle gray borders
- Accent: deep blue (#1e40af) primary, green success, amber warning, red errors
- System font stack — no custom fonts needed
- Show filenames always, confidence as small colored dots, page counts everywhere
- Dense but readable — power user (Rose) reviews 500+ docs
- Desktop only — no responsive needed

## Testing With Real Data

Sample folder: `/Users/bp/Desktop/Dev & Code/esa-test/6384674ESAI/`
- 554 files, 74 HEIC, multiple DOCX revisions, one 1,702-page compiled report
- North stars: `6384578-ESAI-Report.pdf` and `6384642-ESAI-Report.pdf`
- After all fixes: assembled report should be 1,000–4,000 pages matching north star structure

## Key Patterns

- Drag-and-drop between sections reclassifies (PUT to update category); within section reorders
- `main.py` contains compiled-report detection and deduplication logic
- Classification confidence drives UI: green dot (high) / amber (low) / blue (manual)
- SSE endpoints (`upload-folder-stream`, `classify-stream`) return `EventSourceResponse` from `sse-starlette`
- 10-minute axios timeouts on long operations

<claude-mem-context>

</claude-mem-context>
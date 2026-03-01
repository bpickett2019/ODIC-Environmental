# ESA Report Assembly & QC — Agentic System Spec

## Context for Ralph

We're building an AI-powered document assembly and quality control system for **Environmental Site Assessments (Phase I & Phase II ESA reports)**. The end user is **Rose**, a report compiler at an environmental consulting firm. She currently spends hours manually pulling files from FTP folders, ordering appendices, compiling reports, converting formats, and QC-ing everything by hand.

**The current prototype is broken.** It scores 0.4% on QC, cross-contaminates between projects, can't detect missing sections, and has no real intelligence behind it — just a Python automation script. We need to replace this with a true agentic pipeline using **LangGraph** for DAG-based orchestration.

**Non-negotiable from the client:** Accuracy > Speed. If Rose has to second-guess the tool every time, it's worse than doing it manually. The client (Hannah) said this explicitly. The QC layer is the make-or-break feature, not the assembly speed.

---

## Architecture Overview

Use **LangGraph** for stateful, DAG-based agent orchestration. This is NOT a chatbot — it's a deterministic pipeline with AI checkpoints. Each node in the graph is a specialized agent or function with a single responsibility.

### Pipeline DAG

```
[INGEST] → [CLASSIFY] → [STRUCTURE] → [ASSEMBLE] → [QC] → [EXPORT]
    ↑                                                   |
    └──────────── REMEDIATION LOOP ←────────────────────┘
```

Each stage has a deterministic automation layer (fast, cheap) and an AI validation layer (accurate, expensive). Run automation first, AI second. Don't burn tokens on things regex and heuristics can handle.

---

## Stage 1: INGEST

**Purpose:** Accept any file format Rose throws at it. She works with Word docs, PDFs, photos from field workers, and files pulled from 30+ sources per project.

**Inputs:** Word (.docx), PDF, images (JPG/PNG/TIFF), potentially .doc legacy files

**Agent responsibilities:**
- Accept uploads in any supported format — do NOT require Rose to pre-convert anything
- Convert all inputs to a normalized internal format (PDF pages + extracted text + metadata)
- For Word docs: extract text, preserve structure (headings, TOC, page breaks)
- For images: OCR with confidence scoring (flag low-confidence OCR results for human review)
- For PDFs: extract text layer; if scanned/image-only, run OCR
- Generate a file manifest with: filename, format, page count, file size, OCR confidence (if applicable), hash (for dedup)

**State output:**
```python
{
    "project_id": str,
    "files": [
        {
            "id": str,
            "original_filename": str,
            "format": str,
            "page_count": int,
            "size_bytes": int,
            "text_content": str,
            "ocr_confidence": float | None,
            "content_hash": str,
            "metadata": dict
        }
    ]
}
```

**Critical:** Tag every file with the project_id at ingest. The cross-contamination bug in the current system (project '6384578ESAI' bleeding into '1212 E Ash Ave') happened because project context wasn't enforced at the file level. Every single file must be stamped with its project.

---

## Stage 2: CLASSIFY

**Purpose:** Determine what each document IS — which section of the ESA report it belongs to, or if it's irrelevant and should be excluded.

**This is where the current system completely fails.** It can't tell the difference between our Phase 1 report content and a previous report from another company that's included as a reference/record. The client flagged this exact issue: "the previous Report is an actual additional document, quote-unquote, like a record, like a reference thing, not part of the main Report."

**Agent responsibilities:**
- Classify each document into ESA report taxonomy:
  - **Main Report Body:** Executive Summary, Introduction, Site Description, Environmental Setting, Historical Use, Regulatory Database Review, Vapor Assessment, Findings/Conclusions/Recommendations
  - **Appendices:** Appendix A (Site Plan/Maps), Appendix B (Site Photographs), Appendix C (Historical Sources — Sanborn Maps, City Directories, Aerial Photos), Appendix D (Regulatory Records), Appendix E (EDR Report), Appendix F (Qualifications), plus custom appendices per project
  - **Supporting Records:** Previous reports from other entities (NOT part of main report — reference material only)
  - **Excluded:** Irrelevant files, duplicates, drafts, internal notes
- For each classification, output a confidence score
- Flag anything below 85% confidence for Rose's manual review
- Detect when a document belongs to a DIFFERENT project or entity (cross-contamination prevention)

**AI prompt guidance for classification:**
```
You are an Environmental Site Assessment document classifier. Given the text content of a document, classify it into the ESA report structure.

CRITICAL DISTINCTION: Previous environmental reports conducted by OTHER companies on the same site are SUPPORTING RECORDS (Appendix material), NOT part of the main report body. Look for:
- Different company letterheads
- Different project numbers
- Dated reports that predate the current assessment
- References to other firms' work

These go into the records/references appendix, never into the main report sections.
```

**State output:** Each file gets a `classification` object added:
```python
{
    "category": str,          # "main_body" | "appendix" | "supporting_record" | "excluded"
    "section": str,           # e.g., "executive_summary", "appendix_c_sanborn_maps"
    "appendix_letter": str,   # if appendix
    "confidence": float,
    "flags": [str],           # e.g., ["possible_cross_contamination", "low_ocr_quality"]
    "reasoning": str          # AI's explanation for classification
}
```

---

## Stage 3: STRUCTURE

**Purpose:** Determine the correct ordering of all classified documents and validate completeness against the ESA report template.

**Agent responsibilities:**
- Load the project's report template/structure (Phase I vs Phase II have different required sections)
- Map classified documents to template slots
- Detect missing required sections and flag them
- Determine appendix ordering based on standard ESA conventions OR project-specific overrides
- Allow Rose to drag-and-drop reorder appendices (UI interaction point)
- Validate Table of Contents structure against actual content

**Phase I ESA Required Sections (ASTM E1527-21 standard):**
1. Executive Summary
2. Introduction (purpose, scope, significant assumptions, limitations)
3. Site Description (location, legal description, current use, adjoining properties)
4. User Provided Information
5. Records Review (standard environmental record sources, historical use)
6. Site Reconnaissance
7. Interviews
8. Findings (recognized environmental conditions)
9. Conclusions
10. Recommendations
11. Qualifications of Environmental Professionals
12. Appendices (in order: site maps, photos, historical sources, regulatory records, EDR, qualifications)

**Completeness check output:**
```python
{
    "template": "phase_1_astm_e1527",
    "sections_found": [...],
    "sections_missing": [...],        # CRITICAL — must be resolved before assembly
    "sections_extra": [...],          # unexpected sections for review
    "appendix_order": [...],          # proposed order with drag-drop override option
    "completeness_score": float,      # percentage of required sections present
    "blocking_issues": [...],         # must fix before proceeding
    "warnings": [...]                 # should review but not blocking
}
```

---

## Stage 4: ASSEMBLE

**Purpose:** Compile all documents into the final report in correct order with proper pagination, TOC, and formatting.

**Agent responsibilities:**
- Merge documents in the order defined by Stage 3
- Generate or update Table of Contents with accurate page numbers
- Ensure consistent formatting (headers, footers, page numbering)
- Handle page-level operations: insert section breaks, maintain appendix separators
- Track total page count and validate against source materials (the current system lost 104 pages on a 3,776-page document — this is unacceptable)

**Page reconciliation (CRITICAL):**
```python
# After assembly, validate:
source_total_pages = sum(file.page_count for file in classified_files if file.category != "excluded")
assembled_page_count = get_page_count(assembled_report)

if assembled_page_count != source_total_pages:
    missing = source_total_pages - assembled_page_count
    # Trigger remediation loop — AI must identify and recover missing pages
    # Log exactly which source files' pages are missing
```

**Assembly output:** Compiled document + assembly manifest showing source-to-page mapping.

---

## Stage 5: QC (Quality Control) — THE MOST IMPORTANT STAGE

**Purpose:** Validate the assembled report is accurate, complete, and free of errors before Rose signs off.

**This is what the client cares about most.** The current system's 0.4% QC score is the core problem. This stage needs multiple independent validation passes, not one monolithic check.

### QC Sub-Agents (run in parallel where possible):

**5A. Completeness Validator**
- All required sections present
- All appendices accounted for
- No blank pages where content should be
- Page count reconciliation passes

**5B. Cross-Contamination Detector**
- Scan for project IDs, addresses, company names that don't match current project
- Check headers/footers for mismatched project info
- Verify Appendix content matches its label (Appendix A should be maps, not city directories)
- Flag any content from prior/other reports that's been placed in the wrong section

**5C. Structure Validator**
- TOC page numbers match actual page locations
- Sections appear in correct order per ASTM standard
- Appendix letters are sequential and correctly labeled
- No duplicate sections

**5D. Content Integrity Checker**
- AI reads executive summary and validates it references findings that actually exist in the report
- Site address/description is consistent throughout document
- Dates are consistent (report date, site visit date, etc.)
- Professional certifications referenced in qualifications section

**5E. Format Validator**
- Consistent fonts, headers, footers throughout
- No corrupt pages or rendering issues
- Images are present and not broken
- Page orientation correct (some appendices may be landscape)

### QC Output:
```python
{
    "qc_passed": bool,
    "overall_score": float,           # weighted score across all sub-agents
    "confidence_level": float,        # AI's confidence in its own QC assessment
    "blocking_issues": [
        {
            "agent": str,             # which sub-agent found it
            "severity": "critical",
            "description": str,
            "location": str,          # page number or section
            "auto_fixable": bool,
            "suggested_fix": str
        }
    ],
    "warnings": [...],
    "ai_notes": str,                  # free-form observations for Rose
    "section_scores": {
        "completeness": float,
        "cross_contamination": float,
        "structure": float,
        "content_integrity": float,
        "formatting": float
    }
}
```

### Remediation Loop
If QC fails:
1. Present issues to Rose with "Auto-fix?" option per issue
2. For auto-fixable issues (reordering, TOC regeneration, page recovery): fix and re-run QC
3. For manual issues (content decisions, ambiguous classifications): pause and wait for Rose's input
4. Re-run ONLY the affected QC sub-agents after fixes, not the entire pipeline
5. Maximum 3 auto-remediation loops before forcing human review

---

## Stage 6: EXPORT

**Purpose:** Generate final deliverables in the formats Rose needs, respecting file size limits.

**Agent responsibilities:**
- Export as PDF (primary) and/or Word (.docx)
- If file exceeds size limit (client uses 25MB per file upload limit), intelligently split:
  - Split at appendix boundaries (never mid-section)
  - Generate a manifest showing which appendices are in which file
  - Name files clearly: `ProjectID_Report_Part1of3.pdf`
- Compress images to reduce file size without destroying quality
- Generate a QC summary document (separate file) with all AI notes and confidence scores

**Export output:**
```python
{
    "files": [
        {"filename": str, "size_bytes": int, "page_count": int, "sections_included": [str]}
    ],
    "qc_summary": str,           # path to QC summary document
    "total_parts": int,
    "compression_applied": bool,
    "export_format": str          # "pdf" | "docx" | "both"
}
```

---

## LangGraph Implementation Notes

### State Schema
Define a single `ReportState` TypedDict that flows through the entire graph. Each node reads what it needs and writes its outputs. Use LangGraph's `Annotated` reducers for list fields that accumulate across nodes.

### Checkpointing
Enable LangGraph persistence so Rose can:
- Pause and resume assembly
- Review intermediate results
- Roll back to a previous stage if she catches something
- Handle interruptions (she mentioned having to drop one report for a rush job and come back later)

### Human-in-the-Loop Nodes
Use LangGraph's `interrupt()` for:
- Classification review (when confidence < 85%)
- Appendix reordering (drag-and-drop UI)
- QC issue resolution (auto-fix yes/no decisions)
- Final sign-off before export

### Model Selection
Use Claude (Anthropic) for:
- Document classification (long-context strength for reading full documents)
- QC content integrity checks (nuanced understanding of ESA report standards)
- Cross-contamination detection (comparing project metadata)

Use cheaper/faster models or deterministic code for:
- OCR
- Page counting
- TOC validation (regex + page number matching)
- File format conversion
- Size calculations and splitting logic

### Error Handling
- Every node must be idempotent (re-runnable without side effects)
- If any node fails, the pipeline pauses and surfaces the error to Rose — never silently skip
- Log every decision the AI makes with reasoning (for audit trail)
- Never auto-fix without logging what was changed and why

---

## Rose's Workflow (What She Actually Sees)

1. **Create new project** → enters project ID, address, report type (Phase I/II)
2. **Upload files** → drag and drop from FTP folder, any format accepted
3. **Review classifications** → AI shows what it thinks each file is, Rose confirms or corrects (only flagged items need attention)
4. **Review structure** → sees proposed report order, can drag-and-drop reorder appendices
5. **Assemble** → one click, runs in background so she can work on another report
6. **Review QC results** → sees pass/fail with specific issues, clicks "auto-fix" or handles manually
7. **Export** → chooses format, auto-splits if needed, downloads

**Time target:** A report that currently takes Rose 20-30 minutes to compile should take under 5 minutes of her active time (review + clicks), with the pipeline doing the rest in the background.

---

## What NOT to Build

- Do NOT build a chatbot interface. Rose doesn't want to "talk" to the AI. She wants a workflow UI with clear steps and one-click actions.
- Do NOT use a single monolithic LLM call for QC. That's what the current system does and it produces a useless 0.4% score with vague errors.
- Do NOT assume all reports follow the same structure. Each project is unique — the system must handle variation while enforcing minimum standards.
- Do NOT skip the remediation loop. One-pass assembly without self-correction is why the current prototype loses 104 pages and cross-contaminates projects.
- Do NOT over-rely on AI where deterministic code works. Page counting, file size math, TOC page number matching — these are code problems, not AI problems.

---

## Success Criteria

- **QC accuracy ≥ 99%** on assembled reports (no missed cross-contamination, no missing sections, correct ordering)
- **Page reconciliation = 100%** (zero lost pages between source files and assembled report)
- **Rose's active time < 5 minutes** per standard report assembly
- **Zero false confidence** — if the system isn't sure, it asks Rose rather than guessing wrong
- **Background processing** — Rose can start one report assembling and go work on another

---

## Technical Stack

- **Orchestration:** LangGraph (Python)
- **LLM:** Anthropic Claude (primary for classification + QC), with fallback
- **PDF Processing:** PyMuPDF (fitz) for extraction, reportlab or pikepdf for assembly
- **OCR:** Tesseract or cloud OCR for image-based documents
- **Document Conversion:** python-docx for Word, Pillow for images
- **State Persistence:** LangGraph checkpointing (SQLite or Postgres)
- **UI:** React frontend with drag-and-drop, real-time pipeline status via WebSocket
# ODIC Environmental — Canonical Report Structure Analysis

## Source Documents
- **6384578-ESAI** (3,776 pages) — SBA loan-type ESA with Reliance Letter
- **6384642-ESAI** (2,344 pages) — Standard ESA with clear appendix structure

---

## Canonical ESAI Report Structure (Phase I ESA)

Based on analysis of both reference PDFs and ODIC workflow notes, the canonical
compilation order for a Phase I Environmental Site Assessment is:

### Front Matter (Pre-Report)
| Order | Component | Source | Notes |
|-------|-----------|--------|-------|
| 1 | Cover Page | GENERATED | Property address, project number, date, client, ODIC footer |
| 2 | Transmittal Letter | GENERATED | ODIC letterhead, addressed to client, signed by EP |
| 3 | Reliance Letter | GENERATED (conditional) | Only for SBA loans (SOP 50 10 8). Addressed to lender. |
| 4 | E&O Insurance Certificate | UPLOADED | ACORD form — always the same doc per year |
| 5 | EP Declaration | GENERATED (conditional) | Declaration of Environmental Professional qualifications |

### Table of Contents
| Order | Component | Source | Notes |
|-------|-----------|--------|-------|
| 6 | Table of Contents | GENERATED | Auto-generated with page numbers after assembly |

### Report Body
| Order | Component | Source | Notes |
|-------|-----------|--------|-------|
| 7 | Executive Summary | GENERATED | AI-written summary of findings, tables |
| 8 | Findings & Recommendations | GENERATED | Conclusions, RECs, HRECs, CRECs, de minimis |
| 9 | 1.0 Introduction | GENERATED | Scope, purpose, ASTM E1527-21 definitions, limitations |
| 10 | 2.0 Property Description | GENERATED | Project info, improvements, setting, geology, hydrology |
| 11 | 3.0 Property Reconnaissance | GENERATED | Site visit observations, adjoining properties, non-scope items |
| 12 | 4.0 Property and Vicinity History | GENERATED | Historical use review, Sanborn maps, aerials, directories, topo maps, oil/gas wells |
| 13 | 5.0 Standard Environmental Records Research | GENERATED | Database review, property listings, surrounding sites, VEC |
| 14 | 6.0 User Provided Information | GENERATED | User questionnaire, title records, interviews |
| 15 | 7.0 References | GENERATED | Sources consulted |

### Appendices
| Order | Component | Source | Notes |
|-------|-----------|--------|-------|
| 16 | Appendix A Divider | GENERATED | "APPENDIX A — Property Location Map / Plot Plan" |
| 17 | Location Map (Figure 1) | UPLOADED | Site location map showing regional context |
| 18 | Plot Plan (Figure 2) | UPLOADED | Property plot plan with groundwater flow direction |
| 19 | Appendix B Divider | GENERATED | "APPENDIX B — Property & Vicinity Photographs" |
| 20 | Photographs | UPLOADED | Grid layout: 6 photos per page with captions |
| 21 | Appendix C Divider | GENERATED | "APPENDIX C — Regulatory Database Report" |
| 22 | EDR Radius Map Report | UPLOADED | From EDR/Lightbox — typically 1000-3000+ pages |
| 23 | Appendix D Divider | GENERATED | "APPENDIX D — Historical Records Research" |
| 24 | Sanborn Maps | UPLOADED | Historical fire insurance maps |
| 25 | Aerial Photographs | UPLOADED | Historical aerial images |
| 26 | Topographic Maps | UPLOADED | Historical USGS topo maps (if available) |
| 27 | City Directories | UPLOADED | Historical directory listings |
| 28 | Appendix E Divider | GENERATED | "APPENDIX E — Public Agency Records / Other Documents" |
| 29 | Supporting Documents | UPLOADED | FOIA responses, agency correspondence, permits, etc. |
| 30 | Appendix F Divider | GENERATED | "APPENDIX F — Qualifications of Environmental Professional" |
| 31 | EP Qualifications | UPLOADED | Resume/CV of the Environmental Professional(s) |

---

## Differences Between the Two Reference Reports

### Report 6384578 (SBA Type)
- Starts with **Reliance Letter** (SOP 50 10 8) instead of Cover Page
- Has SBA-specific requirements section after Executive Summary
- No explicit appendix divider pages visible in structure
- Photos appear as a single page (page 57) before EDR data
- EP Qualifications at very end (pages 3774-3776)

### Report 6384642 (Standard Type)
- Starts with blank page, then proper **Cover Page**
- Has **Transmittal Letter** after cover
- Clear **Appendix A-F dividers** with styled headers
- Photographs span 4 pages in grid layout
- Better organized section structure

### Key Insight
Report 6384642 represents the more modern/complete ODIC format. Report 6384578
appears to be an older or SBA-specific variation. The pipeline should support
both patterns through configurable assembly templates.

---

## Report Subsection Detail

### 2.0 Property Description
- 2.1 Project Information (table format)
- 2.2 Property Improvements (table format)
- 2.3 Property Occupants and Use (table format)
- 2.4 Geology / Hydrogeology
- 2.5 Groundwater Information

### 3.0 Property Reconnaissance
- 3.1 Limiting Conditions
- 3.2 Methodology and Observations
- 3.3 Interior/Exterior Observations (tabular checklist)
- 3.4 Current Uses of Adjoining Properties (N/S/E/W table)
- 3.5 Non-Scope, Non-CERCLA Items (series of tables: asbestos, LBP, radon, mold, wetlands, flood, methane, PFAS, etc.)

### 4.0 Property and Vicinity History
- 4.1 History Summary / Previous Reports
- 4.2 Sanborn Map Company Fire Insurance Maps
- 4.3 Historical Aerial Photographs (year-by-year table)
- 4.4 Historical Topographic Maps
- 4.5 Historical City/Telephone Directories
- 4.6 Building Department Records
- 4.7 Oil and Gas Well Records
- 4.8 Other Historical Records

### 5.0 Standard Environmental Records Research
- 5.1 Procedure
- 5.2 Subject Property: Federal/State/Local Listings (tables)
- 5.3 Surrounding Sites: Federal Agency Listings (distance tables)
- 5.4 Surrounding Sites: State/Local Agency Listings
- 5.5 Vapor Encroachment Condition (VEC/VES analysis)

### 6.0 User Provided Information
- 6.1 User Provided Information (questionnaire)
- 6.2 Title Records
- 6.3 Interviews

---

## Document Types the Classifier Must Recognize

### Front Matter Documents
1. **cover_page** — ODIC-branded cover with property/project info
2. **transmittal_letter** — ODIC letterhead letter to client
3. **reliance_letter** — SBA/lender reliance letter (SOP 50 10 8)
4. **insurance_certificate** — ACORD E&O insurance form
5. **ep_declaration** — Environmental Professional declaration statement

### Report Body
6. **report_body** — The main Phase I ESA narrative (sections 1.0-7.0)
7. **executive_summary** — Executive Summary section (when separate)
8. **findings_recommendations** — Findings & Recommendations (when separate)

### Appendix Content
9. **location_map** — Figure 1: Site Location Map
10. **plot_plan** — Figure 2: Site Plot Plan
11. **site_photographs** — Property and vicinity photos (grid layout)
12. **edr_report** — EDR/Lightbox Radius Map Report (huge, 1000+ pages)
13. **sanborn_maps** — Historical Sanborn Fire Insurance Maps
14. **aerial_photographs** — Historical aerial photos
15. **topographic_maps** — Historical USGS topographic maps
16. **city_directories** — Historical city/telephone directory listings
17. **agency_records** — Government agency correspondence, FOIA, permits
18. **ep_qualifications** — Environmental Professional resume/CV
19. **appendix_divider** — Generated appendix separator pages

### Supplemental / Other Report Types
20. **rsra_report** — Regulatory Search / Radius Analysis report body
21. **drv_report** — Database Radius Verification report body
22. **eca_report** — Environmental Compliance Audit report body
23. **phase2_report** — Phase II ESA report body
24. **iaq_report** — Indoor Air Quality report body
25. **supporting_document** — Catch-all for unlabeled/miscellaneous docs
26. **blank_page** — Empty/blank page (to be removed or kept as spacer)

---

## Assembly Templates by Report Type

### ESAI (Phase I Environmental Site Assessment)
```
cover → transmittal → [reliance_letter?] → insurance → [ep_declaration?]
→ TOC
→ executive_summary → findings → report_body(1.0-7.0)
→ appendix_a(location_map, plot_plan)
→ appendix_b(photographs)
→ appendix_c(edr_report)
→ appendix_d(sanborns, aerials, topos, directories)
→ appendix_e(agency_records, supporting_docs)
→ appendix_f(ep_qualifications)
```

### RSRA (Regulatory Search / Radius Analysis)
```
cover → transmittal → insurance
→ TOC
→ report_body
→ appendix(edr_report)
→ appendix(supporting_docs)
```

### DRV (Database Radius Verification)
```
cover → transmittal → insurance
→ TOC
→ report_body
→ appendix(edr_report)
```

### ECA (Environmental Compliance Audit)
```
cover → transmittal → insurance
→ TOC
→ report_body
→ appendix(photographs)
→ appendix(supporting_docs)
```

### ESAII (Phase II ESA)
```
cover → transmittal → insurance
→ TOC
→ executive_summary → findings → report_body
→ appendix(location_map, plot_plan)
→ appendix(photographs)
→ appendix(lab_results)
→ appendix(boring_logs)
→ appendix(supporting_docs)
→ appendix(ep_qualifications)
```

### IAQ (Indoor Air Quality)
```
cover → transmittal → insurance
→ TOC
→ report_body
→ appendix(photographs)
→ appendix(lab_results)
→ appendix(supporting_docs)
```

---

## Formatting Observations

### Page Headers
- Every report body page has: "Phase I Environmental Site Assessment Report"
- Project number line: "Project No. 6384642-ESAI"
- Page number: "- X -" centered
- Footer: "ODIC Environmental"

### Section Headers
- Major sections (1.0, 2.0, etc.) are bold, slightly larger
- Subsections (2.1, 2.2) are bold, normal size with small-caps style

### Tables
- Used extensively for property info, observations, agency listings
- Gray/shaded header rows
- Bordered cells

### Appendix Dividers
- Centered text on otherwise blank page
- "Odic Environmental" header
- "APPENDIX X" in caps
- Descriptive subtitle below in small caps

### Photo Pages
- 2x3 grid (6 photos per page)
- Caption below each photo describing view direction
- "Odic Environmental" header on each page

---

## AI Classification Strategy

The classifier needs to handle these realities:
1. **EDR reports are 50-90% of total pages** — must be identified quickly and passed through
2. **Report body sections flow continuously** — the AI must understand section boundaries
3. **Photos are visual, not text-based** — need image classification
4. **Maps/plans are visual** — need image classification
5. **Insurance certificates have a distinctive ACORD format** — pattern matching
6. **Appendix dividers are sparse text pages** — easy to identify
7. **Blank pages exist** — strip or preserve as needed

### Recommended Classification Approach
1. **Quick-scan first 10 pages** to identify front matter pattern and report type
2. **Identify the EDR report start** (distinctive formatting with TC numbers, MAP FINDINGS headers)
3. **Classify report body pages** by section headers and page numbers
4. **Use image analysis** for photos, maps, and plans
5. **Everything between report body end and EP qualifications** is appendix content
6. **EP qualifications** are always at the very end (distinctive resume format)

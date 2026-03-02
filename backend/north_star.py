"""North Star Reference — ground truth for ESA report structure.

Extracted from actual ODIC reports:
- 6384674-ESAI-REPORT_compressed.pdf (1,702 pages)
- Additional ODIC reports for cross-reference

This reference is embedded in AI prompts so the model knows what a
correctly assembled report looks like.
"""

# This is the actual structure of a correctly assembled ODIC Phase I ESA report.
# The AI uses this as its primary reference when classifying documents and
# reviewing the assembly manifest.

NORTH_STAR_MANIFEST = """
=== REFERENCE: Correctly Assembled ODIC Phase I ESA Report ===
(Project 6384674 — 1199 El Camino Real, San Bruno, CA 94066)
Total: 1,702 pages from ~90 included documents (out of 554 uploaded)

SECTION BREAKDOWN:

E&O Insurance — 1 doc, 1 page
  What's here: Certificate of Liability Insurance (ACORD form)
  Example: E&O 2025-26.pdf

Cover / Write-Up — 1-2 docs, ~46 pages
  What's here: The main Phase I ESA report body authored by ODIC Environmental.
  Contains table of contents, executive summary, site description, findings,
  conclusions, recommendations. This is the CORE document — the actual assessment.
  Example: 6384674 ESAI - 1199 El Camino Real, San Bruno, California 94066.docx
  CRITICAL: Only documents written BY ODIC Environmental belong here. Nothing else.
  If Cover/Write-Up has less than 20 pages, the main body is probably missing.

Appendix A — 3 docs, 3 pages
  What's here: Site location maps and plot plans only.
  Example: Site Plot Plan - 6384674 ESAI.vsd, Site Location Map - 6384674 ESAI.vsd
  These are diagrams/drawings, NOT photographs.

Appendix B — 1-2 docs, 7 pages
  What's here: Site visit photographs taken by ODIC staff during the property inspection.
  Usually a Photo Appendix PDF containing a grid of labeled photos showing
  building exteriors, parking lots, grounds, adjacent properties.
  Example: Photo Appendix - 6384674 ESAI-rev-mam.pdf
  NOTE: Individual HEIC photos from the iPhone also go here, but the north star
  report compiled them into a single Photo Appendix PDF. Either format is fine.

Appendix C — 1-2 docs, 1,257 pages
  What's here: The EDR Radius environmental database search report.
  This is a single massive document with database listings of nearby regulated
  facilities (LUST, UST, RCRA, CERCLIS, etc.).
  Example: Radius report PDF
  It's normal for this to be 200-1,500 pages.

Appendix D — ~10 docs, 188 pages (in this exact sub-order)
  What's here: Historical records research, in four sub-groups:
  1. Sanborn fire insurance maps (oldest year -> newest) — hand-drawn building maps
  2. Aerial photographs (oldest -> newest) — overhead views with dates
  3. Topographic maps (oldest -> newest) — USGS contour maps
  4. City directory pages (oldest -> newest) — typed business/resident listings

Appendix E — ~15 docs, 196 pages
  What's here: Public agency records and regulatory correspondence.
  These are SHORT documents (1-20 pages each) FROM government agencies:
  - BAAQMD air quality permits (1-5 pages)
  - DTSC regulatory letters (1-3 pages)
  - RWQCB correspondence (1-5 pages)
  - UST underground storage tank forms (1-3 pages)
  - CERS hazardous materials certifications (1-2 pages)
  - Property profiles from title companies (5-15 pages)
  - City/county inspection reports (1-10 pages)
  - Building permits, fire department permits (1-5 pages)

  KEY DISTINCTION: If it's a short document FROM a government agency
  (permit, letter, form, certificate, inspection report) -> APPENDIX E.
  If it's a long technical report FROM a consulting firm -> REPORTS AFTER E.

Reports After E — 0-10 KEY docs, 0-500 pages (NOT the entire archive)
  What's here: Only the MOST IMPORTANT technical reports from other firms.
  In the north star, this section had 0 pages — everything was in Appendix E.
  For contaminated sites, you might include:
  - The initial site investigation report
  - The most recent monitoring report
  - The closure/No Further Action letter
  - The UST removal report
  You do NOT include 20 years of quarterly monitoring reports.
  If this section has more than 500 pages, most documents should be excluded.

Appendix F — 1 doc, 4 pages
  What's here: Resume/qualifications of the Environmental Professional.
  Contains certifications, licenses, education, professional experience.

=== WHAT WAS EXCLUDED (464 out of 554 documents) ===

- 1 compiled report (the previous assembly of this same project — 1,702 pages)
- ~14 duplicate file versions (older revisions of the same document)
- ~440 GeoTracker quarterly monitoring reports spanning 2003-2025
  (routine data not needed for Phase I ESA — kept as reference but not included)
- ~10 miscellaneous files not relevant to the assessment

=== KEY INSIGHT ===
Rose (the human compiler) curated 90 documents out of 554 uploaded.
The system should help identify the ~90 that matter, not blindly include all 554.
For the GeoTracker archive specifically: include 5-10 key documents, not 440.
"""

TYPICAL_SECTION_RANGES = {
    "EO_INSURANCE": {"min_pages": 1, "max_pages": 3, "min_docs": 1, "max_docs": 1},
    "COVER_WRITEUP": {"min_pages": 20, "max_pages": 80, "min_docs": 1, "max_docs": 3},
    "APPENDIX_A": {"min_pages": 1, "max_pages": 10, "min_docs": 1, "max_docs": 5},
    "APPENDIX_B": {"min_pages": 2, "max_pages": 100, "min_docs": 1, "max_docs": 80},
    "APPENDIX_C": {"min_pages": 100, "max_pages": 1500, "min_docs": 1, "max_docs": 3},
    "APPENDIX_D": {"min_pages": 30, "max_pages": 300, "min_docs": 3, "max_docs": 20},
    "APPENDIX_E": {"min_pages": 20, "max_pages": 300, "min_docs": 3, "max_docs": 30},
    "REPORTS_AFTER_E": {"min_pages": 0, "max_pages": 500, "min_docs": 0, "max_docs": 15},
    "APPENDIX_F": {"min_pages": 2, "max_pages": 10, "min_docs": 1, "max_docs": 2},
}

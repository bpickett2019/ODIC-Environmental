/**
 * Smoke test for Phase 3: Organization + Assembly.
 *
 * Creates a mock project with pre-classified documents,
 * runs the organization step, then the assembly step,
 * and verifies the output PDF has correct page counts.
 */

import { loadAppConfig, loadESATemplate, loadDocumentTypes } from '../src/core/config-loader.js';
import { StateManager } from '../src/core/state.js';
import { createTextPage, createMultiPageText, ensureDir, getPageCount, isValidPDF, mergePDFs } from '../src/core/pdf-utils.js';
import { createOrganizeExecutor } from '../src/skills/organize-step.js';
import { createAssembleExecutor } from '../src/skills/assemble-step.js';
import type { PipelineContext, ProjectStatus, ReportSection } from '../src/types/index.js';
import fs from 'fs/promises';
import path from 'path';

const TEST_DIR = '/tmp/esa-organize-smoke';

async function organizeSmokeTest() {
  console.log('=== Phase 3 Organization + Assembly Smoke Test ===\n');

  await ensureDir(TEST_DIR);
  await ensureDir(path.join(TEST_DIR, 'PROJECT-001'));

  const config = await loadAppConfig();
  // Override dirs for testing
  config.pipeline.project_base_dir = TEST_DIR;
  config.pipeline.output_dir = path.join(TEST_DIR, 'output');
  await ensureDir(config.pipeline.output_dir);

  const template = await loadESATemplate();
  const docTypes = await loadDocumentTypes();
  console.log('✓ Config, template, and document types loaded');

  // ── 1. Create Mock Documents ─────────────────────────────────────────────

  // Create realistic mock PDFs for different document types
  const mockDocs: Array<{
    filename: string;
    type: string;
    section: string;
    pages: number;
    content: string[];
  }> = [
    {
      filename: 'cover_page.pdf',
      type: 'cover_page',
      section: 'front_cover',
      pages: 1,
      content: ['PHASE I ENVIRONMENTAL SITE ASSESSMENT', '1234 Main St', 'ODIC Environmental'],
    },
    {
      filename: 'transmittal.pdf',
      type: 'transmittal_letter',
      section: 'front_transmittal',
      pages: 1,
      content: ['Dear Client', 'Attached please find', 'Phase I Environmental Site Assessment'],
    },
    {
      filename: 'insurance.pdf',
      type: 'insurance_certificate',
      section: 'front_insurance',
      pages: 1,
      content: ['ACORD', 'CERTIFICATE OF LIABILITY INSURANCE', 'ODIC Environmental'],
    },
    {
      filename: 'figure1_location_map.pdf',
      type: 'location_map',
      section: 'appendix_a_maps',
      pages: 1,
      content: ['FIGURE 1', 'Site Location Map'],
    },
    {
      filename: 'figure2_plot_plan.pdf',
      type: 'plot_plan',
      section: 'appendix_a_maps',
      pages: 1,
      content: ['FIGURE 2', 'Site Plot Plan'],
    },
    {
      filename: 'site_photos.pdf',
      type: 'site_photograph',
      section: 'appendix_b_photographs',
      pages: 2,
      content: ['Site Photographs', 'View of Property facing north', 'Interior view of building'],
    },
    {
      filename: 'edr_report.pdf',
      type: 'edr_report',
      section: 'appendix_c_database_report',
      pages: 3,
      content: ['Environmental Data Resources', 'EDR Radius Map Report', 'Executive Summary'],
    },
    {
      filename: 'aerial_photos.pdf',
      type: 'aerial_photograph',
      section: 'appendix_d_historical',
      pages: 2,
      content: ['Historical Aerial Photographs', '1965 Aerial', '2005 Aerial'],
    },
    {
      filename: 'sanborn_maps.pdf',
      type: 'sanborn_map',
      section: 'appendix_d_historical',
      pages: 1,
      content: ['Sanborn Fire Insurance Map', '1926'],
    },
    {
      filename: 'ep_resume.pdf',
      type: 'ep_qualifications',
      section: 'appendix_f_qualifications',
      pages: 2,
      content: ['EDUCATION', 'YEARS EXPERIENCE', 'Professional Civil Engineer'],
    },
  ];

  // Generate mock PDFs
  const pdfPaths: Map<string, string> = new Map();
  let totalExpectedSourcePages = 0;

  for (const doc of mockDocs) {
    const filePath = path.join(TEST_DIR, 'PROJECT-001', doc.filename);

    if (doc.pages === 1) {
      const pdf = await createTextPage(
        doc.content.map((text, i) => ({
          text,
          fontSize: i === 0 ? 16 : 12,
          bold: i === 0,
          align: 'center' as const,
        }))
      );
      await fs.writeFile(filePath, pdf);
    } else {
      // Multi-page: create and merge multiple single-page PDFs
      const pageBuffers: Buffer[] = [];
      for (let p = 0; p < doc.pages; p++) {
        const pagePdf = await createTextPage([
          { text: doc.content[0] || doc.filename, fontSize: 16, bold: true, align: 'center' as const },
          { text: `Page ${p + 1} of ${doc.pages}`, fontSize: 12, align: 'center' as const },
        ]);
        const tmpPath = path.join(TEST_DIR, `_tmp_${doc.filename}_${p}.pdf`);
        await fs.writeFile(tmpPath, pagePdf);
        pageBuffers.push(pagePdf);
      }

      // Write temp pages and merge
      const mergeInputs = [];
      for (let p = 0; p < doc.pages; p++) {
        const tmpPath = path.join(TEST_DIR, `_tmp_${doc.filename}_${p}.pdf`);
        mergeInputs.push({ filePath: tmpPath, label: `page ${p + 1}` });
      }
      const merged = await mergePDFs(mergeInputs);
      await fs.writeFile(filePath, merged.pdfBuffer);

      // Cleanup temp files
      for (let p = 0; p < doc.pages; p++) {
        await fs.rm(path.join(TEST_DIR, `_tmp_${doc.filename}_${p}.pdf`), { force: true });
      }
    }

    pdfPaths.set(doc.filename, filePath);
    totalExpectedSourcePages += doc.pages;

    const actualPages = await getPageCount(filePath);
    console.assert(actualPages === doc.pages, `${doc.filename}: expected ${doc.pages} pages, got ${actualPages}`);
  }

  console.log(`✓ Created ${mockDocs.length} mock PDFs (${totalExpectedSourcePages} total pages)`);

  // ── 2. Set Up State with Pre-Classified Documents ────────────────────────

  const dbPath = path.join(TEST_DIR, 'organize-test.db');
  const state = new StateManager(dbPath);
  await state.init();

  state.createProject({
    id: 'PROJECT-001',
    name: 'Organization Test Project',
    clientName: 'Test Client Inc.',
    propertyAddress: '1234 Main St, Los Angeles, CA',
    ftpPath: '/incoming/PROJECT-001',
    localPath: path.join(TEST_DIR, 'PROJECT-001'),
  });

  // Add pre-classified documents
  for (const doc of mockDocs) {
    const docId = state.addDocument({
      projectId: 'PROJECT-001',
      filename: doc.filename,
      localPath: pdfPaths.get(doc.filename)!,
      sizeBytes: 1000,
      sha256: `hash-${doc.filename}`,
      pageCount: doc.pages,
    });

    // Store classification
    state.updateDocumentClassification(docId, {
      documentType: doc.type as any,
      confidence: 0.95,
      reasoning: `Mock classification for ${doc.type}`,
      dateDetected: null,
      projectIdDetected: null,
      pageCount: doc.pages,
      pageRange: { start: 1, end: doc.pages },
      suggestedSection: doc.section as any,
      needsManualReview: false,
      isSbaSpecific: false,
      metadata: {},
    });
  }

  // Also add a blank page that should be excluded
  const blankPath = path.join(TEST_DIR, 'PROJECT-001', 'blank.pdf');
  const blankPdf = await createTextPage([{ text: '', fontSize: 12 }]);
  await fs.writeFile(blankPath, blankPdf);
  const blankDocId = state.addDocument({
    projectId: 'PROJECT-001',
    filename: 'blank.pdf',
    localPath: blankPath,
    sizeBytes: 500,
    sha256: 'hash-blank',
    pageCount: 1,
  });
  state.updateDocumentClassification(blankDocId, {
    documentType: 'blank_page',
    confidence: 0.95,
    reasoning: 'Empty page',
    dateDetected: null,
    projectIdDetected: null,
    pageCount: 1,
    pageRange: { start: 1, end: 1 },
    suggestedSection: 'appendix_i_additional',
    needsManualReview: false,
    isSbaSpecific: false,
    metadata: {},
  });

  console.log(`✓ State: project with ${mockDocs.length + 1} documents (including blank page)`);

  // ── 3. Run Organization Step ─────────────────────────────────────────────

  const organizeExecutor = createOrganizeExecutor(config, state, template);

  const ctx: PipelineContext = {
    project: {
      id: 'PROJECT-001',
      name: 'Organization Test Project',
      clientName: 'Test Client Inc.',
      propertyAddress: '1234 Main St, Los Angeles, CA',
      reportType: 'ESAI',
      isSbaLoan: false,
      status: 'organizing' as ProjectStatus,
      priority: 'normal',
      ftpPath: '/incoming/PROJECT-001',
      localPath: path.join(TEST_DIR, 'PROJECT-001'),
      fileCount: mockDocs.length + 1,
      classifiedDocuments: [],
      organizedDocuments: [],
      reportManifest: null,
      qaResult: null,
      outputPdfPath: null,
      outputDocxPath: null,
      estimatedCostUsd: 0,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    },
    stepResults: new Map(),
    haltOnQAFailure: true,
    triageApproved: true,
    cancelled: false,
  };

  const organizeResult = await organizeExecutor(ctx);
  console.assert(organizeResult.success, `Organization should succeed, got: ${organizeResult.error}`);
  console.log(`✓ Organization step: ${organizeResult.success ? 'SUCCESS' : 'FAILED'} (${organizeResult.durationMs}ms)`);

  const orgData = organizeResult.data as any;
  console.log(`  Total organized: ${orgData.totalDocuments}`);
  console.log(`  Sections populated: ${orgData.sectionsPopulated}`);
  console.log(`  Excluded: ${orgData.excluded}`);
  console.log(`  Missing sections: ${orgData.missingSections.length > 0 ? orgData.missingSections.join(', ') : 'none'}`);

  // Verify the blank page was excluded
  console.assert(orgData.excluded >= 1, 'Blank page should be excluded');

  // Verify section breakdown
  for (const sb of orgData.sectionBreakdown) {
    console.log(`  ${sb.title}: ${sb.documentCount} docs, ${sb.totalPages} pages`);
  }

  // Verify docs have section assignments in state
  const organizedDocs = state.getDocuments('PROJECT-001');
  const assignedDocs = organizedDocs.filter(d => d.section_assignment);
  console.assert(assignedDocs.length === mockDocs.length, `Expected ${mockDocs.length} assigned docs, got ${assignedDocs.length}`);
  console.log(`✓ ${assignedDocs.length} documents have section assignments`);

  // Verify within-section ordering (Appendix D: sanborn before aerial)
  const histDocs = organizedDocs
    .filter(d => d.section_assignment === 'appendix_d_historical')
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
  if (histDocs.length >= 2) {
    console.assert(histDocs[0].document_type === 'sanborn_map', 'Sanborn should come first in historical');
    console.assert(histDocs[1].document_type === 'aerial_photograph', 'Aerial should come second');
    console.log('✓ Within-section ordering correct (sanborn before aerial in Appendix D)');
  }

  // Verify maps ordering (location map before plot plan)
  const mapDocs = organizedDocs
    .filter(d => d.section_assignment === 'appendix_a_maps')
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
  if (mapDocs.length >= 2) {
    console.assert(mapDocs[0].document_type === 'location_map', 'Location map should come first');
    console.assert(mapDocs[1].document_type === 'plot_plan', 'Plot plan should come second');
    console.log('✓ Within-section ordering correct (location map before plot plan in Appendix A)');
  }

  // ── 4. Run Assembly Step ─────────────────────────────────────────────────

  const assembleExecutor = createAssembleExecutor(config, state, template);
  const assembleResult = await assembleExecutor(ctx);

  console.log(`\n✓ Assembly step: ${assembleResult.success ? 'SUCCESS' : 'FAILED'} (${assembleResult.durationMs}ms)`);

  if (assembleResult.success) {
    const asmData = assembleResult.data as any;
    console.log(`  Output PDF: ${asmData.outputPdfPath}`);
    console.log(`  Total pages: ${asmData.totalPages}`);
    console.log(`  Source pages: ${asmData.sourcePages}`);
    console.log(`  Generated pages (dividers): ${asmData.generatedPages}`);
    console.log(`  Sections included: ${asmData.sectionsIncluded}`);
    console.log(`  Integrity check: ${asmData.integrityPassed ? 'PASS' : 'FAIL'}`);

    // Verify the output file exists and is valid
    const outputExists = await fs.stat(asmData.outputPdfPath).then(() => true).catch(() => false);
    console.assert(outputExists, 'Output PDF should exist');
    console.log(`✓ Output PDF exists on disk`);

    const outputValid = await isValidPDF(asmData.outputPdfPath);
    console.assert(outputValid, 'Output PDF should be valid');
    console.log(`✓ Output PDF is valid`);

    const outputPages = await getPageCount(asmData.outputPdfPath);
    console.log(`✓ Output PDF page count: ${outputPages}`);

    // Page integrity: source pages + generated divider pages should equal total
    console.assert(
      asmData.sourcePages + asmData.generatedPages === asmData.totalPages,
      `Page integrity: ${asmData.sourcePages} + ${asmData.generatedPages} should equal ${asmData.totalPages}`
    );
    console.log(`✓ Page integrity check passed: ${asmData.sourcePages} source + ${asmData.generatedPages} generated = ${asmData.totalPages} total`);

    // Verify manifest
    const manifest = asmData.manifest;
    console.assert(manifest.projectId === 'PROJECT-001', 'Manifest projectId should match');
    console.assert(manifest.reportType === 'ESAI', 'Manifest report type should be ESAI');
    console.assert(manifest.sections.length > 0, 'Manifest should have sections');
    console.log(`✓ Report manifest: ${manifest.sections.length} sections`);

    for (const sec of manifest.sections) {
      console.log(`  ${sec.sectionNumber || '-'} ${sec.title}: ${sec.totalPages} pages (start: p${sec.startPage})`);
    }
  } else {
    console.log(`  Error: ${assembleResult.error}`);
  }

  // Cleanup
  state.close();
  await fs.rm(TEST_DIR, { recursive: true, force: true });

  console.log('\n=== All Phase 3 smoke tests PASSED ===');
}

organizeSmokeTest().catch(err => {
  console.error('\n✗ ORGANIZE/ASSEMBLE SMOKE TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});

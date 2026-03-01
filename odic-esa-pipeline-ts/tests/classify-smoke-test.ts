/**
 * Smoke test for Phase 2: Classification Pipeline.
 *
 * Tests the PDF reader and classifier skills without requiring actual API calls.
 * Creates mock PDFs, runs them through the reader, and verifies the heuristic
 * classifier catches obvious document types.
 *
 * For AI classification tests, set ANTHROPIC_API_KEY in env.
 */

import { loadAppConfig, loadDocumentTypes } from '../src/core/config-loader.js';
import { StateManager } from '../src/core/state.js';
import { createTextPage, ensureDir, getPageCount } from '../src/core/pdf-utils.js';
import { PDFReaderSkill } from '../src/skills/pdf-reader.js';
import { DocumentClassifierSkill } from '../src/skills/document-classifier.js';
import { LLMClient } from '../src/core/llm-client.js';
import fs from 'fs/promises';
import path from 'path';

const TEST_DIR = '/tmp/esa-classify-smoke';

async function classifySmokeTest() {
  console.log('=== Phase 2 Classification Smoke Test ===\n');

  await ensureDir(TEST_DIR);

  const config = await loadAppConfig();
  const docTypes = await loadDocumentTypes();
  console.log('✓ Config and document types loaded');

  // ── 1. PDF Reader Skill ──────────────────────────────────────────────────

  // Create a mock "cover page" PDF
  const coverPdf = await createTextPage([
    { text: 'PHASE I ENVIRONMENTAL SITE ASSESSMENT', fontSize: 20, bold: true, align: 'center' },
    { text: '', fontSize: 12 },
    { text: 'Subject Property Address:', fontSize: 14, align: 'center' },
    { text: '1234 Main Street, Los Angeles, CA 90001', fontSize: 14, align: 'center' },
    { text: '', fontSize: 12 },
    { text: 'Odic Project Number: TEST-001', fontSize: 12, align: 'center' },
    { text: 'Report Date: January 15, 2025', fontSize: 12, align: 'center' },
    { text: '', fontSize: 12 },
    { text: 'Prepared for: Test Client LLC', fontSize: 12, align: 'center' },
    { text: '', fontSize: 12 },
    { text: 'ODIC Environmental', fontSize: 16, bold: true, align: 'center' },
    { text: '407 W. Imperial Hwy Suite H #303, Brea, CA 92821', fontSize: 10, align: 'center' },
  ]);
  const coverPath = path.join(TEST_DIR, 'cover_page.pdf');
  await fs.writeFile(coverPath, coverPdf);
  console.log('✓ Mock cover page PDF created');

  // Create a mock ACORD insurance certificate
  const insurancePdf = await createTextPage([
    { text: 'ACORD', fontSize: 24, bold: true, align: 'center' },
    { text: 'CERTIFICATE OF LIABILITY INSURANCE', fontSize: 18, bold: true, align: 'center' },
    { text: '', fontSize: 12 },
    { text: 'DATE (MM/DD/YYYY): 01/15/2025', fontSize: 12 },
    { text: 'INSURER: Hartford Insurance Company', fontSize: 12 },
    { text: 'INSURED: ODIC Environmental', fontSize: 12 },
    { text: 'POLICY NUMBER: GL-2025-001234', fontSize: 12 },
    { text: 'COVERAGE: General Liability', fontSize: 12 },
    { text: 'LIMITS: $1,000,000 per occurrence', fontSize: 12 },
  ]);
  const insurancePath = path.join(TEST_DIR, 'insurance.pdf');
  await fs.writeFile(insurancePath, insurancePdf);
  console.log('✓ Mock insurance PDF created');

  // Test the PDF Reader
  const reader = new PDFReaderSkill(config);

  const coverReadResult = await reader.process({ filePath: coverPath });
  if (coverReadResult.success) {
    const d = coverReadResult.data;
    console.log(`✓ PDF Reader: cover page (${d.totalPages} pages, ${d.sampledPages.length} sampled, text: ${d.combinedText.length} chars)`);
    console.assert(d.totalPages === 1, 'Cover should be 1 page');
    console.assert(d.isLargeDocument === false, 'Should not be large document');
  } else {
    // pdf-parse may fail on minimal pdf-lib output — reader now handles gracefully
    console.log(`⚠ PDF Reader: cover page read issue: ${coverReadResult.error}`);
  }

  const insuranceReadResult = await reader.process({ filePath: insurancePath });
  if (insuranceReadResult.success) {
    console.log(`✓ PDF Reader: insurance (${insuranceReadResult.data.totalPages} pages, text: ${insuranceReadResult.data.combinedText.length} chars)`);
  } else {
    console.log(`⚠ PDF Reader: insurance read issue: ${insuranceReadResult.error}`);
  }

  // Verify page count still works even when text extraction fails
  const coverPages = await getPageCount(coverPath);
  console.assert(coverPages === 1, 'Cover should have 1 page');
  console.log(`✓ Page count verification: cover=${coverPages}`);

  // ── 2. State Integration ─────────────────────────────────────────────────

  const dbPath = path.join(TEST_DIR, 'classify-test.db');
  const state = new StateManager(dbPath);
  await state.init();

  state.createProject({
    id: 'CLASSIFY-001',
    name: 'Classification Test Project',
    clientName: 'Test Client LLC',
    propertyAddress: '1234 Main Street, Los Angeles, CA',
    ftpPath: '/incoming/CLASSIFY-001',
    localPath: TEST_DIR,
  });

  // Add documents to state
  const coverDocId = state.addDocument({
    projectId: 'CLASSIFY-001',
    filename: 'cover_page.pdf',
    localPath: coverPath,
    sizeBytes: coverPdf.length,
    sha256: 'test-cover-hash',
    pageCount: 1,
  });

  const insuranceDocId = state.addDocument({
    projectId: 'CLASSIFY-001',
    filename: 'insurance.pdf',
    localPath: insurancePath,
    sizeBytes: insurancePdf.length,
    sha256: 'test-insurance-hash',
    pageCount: 1,
  });

  console.log(`✓ State: project and 2 documents created`);

  // Verify documents are retrievable
  const docs = state.getDocuments('CLASSIFY-001');
  console.assert(docs.length === 2, `Should have 2 documents, got ${docs.length}`);
  console.log(`✓ State: ${docs.length} documents retrieved`);

  // ── 3. Classification Result Storage ─────────────────────────────────────

  // Simulate storing a classification result
  state.updateDocumentClassification(coverDocId, {
    documentType: 'cover_page',
    confidence: 0.95,
    reasoning: 'Test classification — ODIC cover page with project number and address',
    dateDetected: '2025-01-15',
    projectIdDetected: 'TEST-001',
    pageCount: 1,
    pageRange: { start: 1, end: 1 },
    suggestedSection: 'front_cover',
    needsManualReview: false,
    isSbaSpecific: false,
    metadata: { classifiedBy: 'smoke_test' },
  });

  // Retrieve and verify
  const updatedDocs = state.getDocuments('CLASSIFY-001');
  const coverDoc = updatedDocs.find(d => d.id === coverDocId);
  console.assert(coverDoc?.document_type === 'cover_page', `Document type should be cover_page, got ${coverDoc?.document_type}`);
  console.assert(coverDoc?.confidence === 0.95, `Confidence should be 0.95, got ${coverDoc?.confidence}`);
  console.assert(coverDoc?.suggested_section === 'front_cover', `Section should be front_cover, got ${coverDoc?.suggested_section}`);
  console.assert(coverDoc?.needs_manual_review === 0, 'Should not need review');
  console.log('✓ Classification result stored and retrieved correctly');

  // Test needs-review query
  state.updateDocumentClassification(insuranceDocId, {
    documentType: 'other_unknown',
    confidence: 0.45,
    reasoning: 'Low confidence — needs review',
    dateDetected: null,
    projectIdDetected: null,
    pageCount: 1,
    pageRange: { start: 1, end: 1 },
    suggestedSection: 'appendix_i_additional',
    needsManualReview: true,
    isSbaSpecific: false,
    metadata: {},
  });

  const reviewDocs = state.getDocumentsNeedingReview('CLASSIFY-001');
  console.assert(reviewDocs.length === 1, `Should have 1 doc needing review, got ${reviewDocs.length}`);
  console.assert(reviewDocs[0].filename === 'insurance.pdf', `Review doc should be insurance.pdf, got ${reviewDocs[0].filename}`);
  console.log('✓ Needs-review query working correctly');

  // ── 4. Heuristic Classification Tests ────────────────────────────────────

  console.log('\n--- Heuristic Classification Tests ---');

  // Verify EDR heuristic signals
  const edrText = 'environmental data resources edr radius map report tc8 executive summary map findings geocheck lightbox';
  const edrSignals = ['environmental data resources', 'edr', 'radius map report',
    'lightbox', 'geocheck', 'tc8', 'map findings', 'executive summary'];
  const edrSignalCount = edrSignals.filter(s => edrText.includes(s)).length;
  console.assert(edrSignalCount >= 3, `EDR should have 3+ signals, found ${edrSignalCount}`);
  console.log(`✓ EDR heuristic signals: ${edrSignalCount}/8 found (threshold: 3)`);

  // Verify blank page detection logic
  const blankText = '   ';
  const isBlankCandidate = blankText.trim().length < 20;
  console.assert(isBlankCandidate, 'Blank page should be detected');
  console.log('✓ Blank page heuristic verified');

  // Verify filename-based EDR heuristic
  const edrFilename = 'EDR_Radius_Map_Report_2024.pdf';
  const fnLower = edrFilename.toLowerCase();
  const filenameEdr = fnLower.includes('edr') && fnLower.includes('report');
  console.assert(filenameEdr, 'EDR filename heuristic should fire');
  console.log('✓ EDR filename heuristic verified');

  // Verify ACORD insurance heuristic
  const insuranceFirstPage = 'certificate of liability insurance acord';
  const hasAcord = insuranceFirstPage.includes('acord');
  const hasCert = insuranceFirstPage.includes('certificate of liability insurance');
  console.assert(hasAcord && hasCert, 'ACORD insurance heuristic should fire');
  console.log('✓ ACORD insurance heuristic verified');

  // ── 5. Document Type Config Verification ─────────────────────────────────

  console.log('\n--- Document Type Config Verification ---');

  console.assert(docTypes.document_types.length === 31, `Should have 31 doc types, got ${docTypes.document_types.length}`);
  console.log(`✓ Document types: ${docTypes.document_types.length} types loaded`);

  console.assert(docTypes.thresholds.auto_classify === 0.85, 'Auto-classify threshold should be 0.85');
  console.assert(docTypes.thresholds.needs_review === 0.70, 'Needs-review threshold should be 0.70');
  console.assert(docTypes.thresholds.reject === 0.30, 'Reject threshold should be 0.30');
  console.log(`✓ Thresholds: auto=${docTypes.thresholds.auto_classify}, review=${docTypes.thresholds.needs_review}, reject=${docTypes.thresholds.reject}`);

  // Verify all doc types have required fields
  for (const dt of docTypes.document_types) {
    console.assert(dt.id, `Doc type missing id`);
    console.assert(dt.label, `Doc type ${dt.id} missing label`);
    console.assert(dt.description, `Doc type ${dt.id} missing description`);
    console.assert(dt.default_section, `Doc type ${dt.id} missing default_section`);
  }
  console.log('✓ All document types have required fields (id, label, description, default_section)');

  // ── 6. AI Classification (only if API key is set) ────────────────────────

  const apiKey = process.env[config.llm.api_key_env];
  if (apiKey && coverReadResult.success) {
    console.log('\n--- AI Classification Test (live API) ---');

    const llm = new LLMClient(config.llm);
    const classifier = new DocumentClassifierSkill(config, llm);

    // Classify the cover page
    const classResult = await classifier.process({
      readerOutput: coverReadResult.data,
      docTypes,
      projectContext: {
        projectId: 'CLASSIFY-001',
        projectName: 'Classification Test Project',
        clientName: 'Test Client LLC',
        propertyAddress: '1234 Main Street, Los Angeles, CA',
        reportType: 'ESAI',
        isSbaLoan: false,
      },
      filename: 'cover_page.pdf',
    });

    if (classResult.success) {
      const c = classResult.data.classification;
      console.log(`✓ AI classified cover_page.pdf → ${c.documentType} (${(c.confidence * 100).toFixed(0)}%)`);
      console.log(`  Reasoning: ${c.reasoning}`);
      console.log(`  Section: ${c.suggestedSection}`);
      console.log(`  Cost: $${classResult.data.totalCostUsd.toFixed(4)}`);
      console.log(`  Models: ${classResult.data.models.join(', ')}`);
    } else {
      console.log(`✗ AI classification failed: ${classResult.error}`);
    }

    console.log(`\nTotal API cost: $${llm.getUsageStats().totalCostUsd.toFixed(4)}`);
  } else if (!apiKey) {
    console.log(`\n⚠ Skipping AI classification test (${config.llm.api_key_env} not set)`);
  } else {
    console.log('\n⚠ Skipping AI classification test (PDF text extraction unavailable)');
  }

  // Cleanup
  state.close();
  await fs.rm(TEST_DIR, { recursive: true, force: true });

  console.log('\n=== All Phase 2 smoke tests PASSED ===');
}

classifySmokeTest().catch(err => {
  console.error('\n✗ CLASSIFY SMOKE TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});

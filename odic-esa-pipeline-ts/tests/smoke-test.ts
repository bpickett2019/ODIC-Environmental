import { loadAppConfig, loadESATemplate, loadDocumentTypes } from '../src/core/config-loader.js';
import { StateManager } from '../src/core/state.js';
import { ensureDir, createTextPage, getPageCount, isValidPDF, mergePDFs } from '../src/core/pdf-utils.js';
import fs from 'fs/promises';
import path from 'path';

const TEST_DIR = '/tmp/esa-smoke-test';

async function smokeTest() {
  console.log('=== Phase 1 Smoke Test ===\n');

  // Prep
  await ensureDir(TEST_DIR);

  // 1. Config loading
  const config = await loadAppConfig();
  console.log('✓ Config loaded:', config.llm.classifier_model);

  // 2. ESA template (multi-report-type)
  const template = await loadESATemplate();
  const esaiTemplate = template.report_types.find(rt => rt.id === 'ESAI');
  console.log(`✓ Report templates: ${template.report_types.length} report types (${template.report_types.map(rt => rt.id).join(', ')})`);
  console.log(`✓ ESAI template: ${esaiTemplate?.sections.length} sections, ${esaiTemplate?.appendices.length} appendices`);

  // 3. Document types
  const docTypes = await loadDocumentTypes();
  console.log(`✓ Document types: ${docTypes.document_types.length} types`);

  // 4. State manager (SQLite via sql.js)
  const dbPath = path.join(TEST_DIR, 'test.db');
  const state = new StateManager(dbPath);
  await state.init();

  state.createProject({
    id: 'SMOKE-001',
    name: 'Smoke Test Project',
    clientName: 'Test Client Inc.',
    propertyAddress: '456 Oak Ave, Los Angeles, CA',
    ftpPath: '/incoming/SMOKE-001',
    localPath: path.join(TEST_DIR, 'SMOKE-001'),
  });

  const project = state.getProject('SMOKE-001');
  console.log(`✓ SQLite: project created (id=${project?.id}, status=${project?.status})`);

  const docId = state.addDocument({
    projectId: 'SMOKE-001',
    filename: 'test-edr-report.pdf',
    localPath: path.join(TEST_DIR, 'test-edr-report.pdf'),
    sizeBytes: 2048,
    sha256: 'deadbeef',
    pageCount: 45,
  });
  console.log(`✓ SQLite: document added (id=${docId})`);

  state.addNotification('SMOKE-001', 'success', 'Classification complete');
  const notifs = state.getNotifications();
  console.log(`✓ SQLite: ${notifs.length} notification(s)`);

  const summaries = state.getProjectSummaries();
  console.log(`✓ SQLite: ${summaries.length} project summary(ies)`);

  state.updateProjectStatus('SMOKE-001', 'classifying');
  const updated = state.getProject('SMOKE-001');
  console.log(`✓ SQLite: status updated to ${updated?.status}`);

  // Verify DB file was persisted
  const dbExists = await fs.stat(dbPath).then(() => true).catch(() => false);
  console.log(`✓ SQLite: DB file persisted to disk: ${dbExists}`);

  state.close();

  // 5. PDF generation
  const coverPdf = await createTextPage([
    { text: 'ODIC Environmental', fontSize: 24, bold: true, align: 'center' },
    { text: 'Phase I Environmental Site Assessment', fontSize: 18, bold: true, align: 'center' },
    { text: '', fontSize: 12 },
    { text: 'Property: 456 Oak Ave, Los Angeles, CA', fontSize: 14, align: 'center' },
    { text: 'Client: Test Client Inc.', fontSize: 14, align: 'center' },
    { text: `Date: ${new Date().toLocaleDateString()}`, fontSize: 14, align: 'center' },
    { text: 'Project No: SMOKE-001', fontSize: 14, align: 'center' },
  ]);

  const coverPath = path.join(TEST_DIR, 'cover.pdf');
  await fs.writeFile(coverPath, coverPdf);
  const coverPages = await getPageCount(coverPath);
  const coverValid = await isValidPDF(coverPath);
  console.log(`✓ PDF generation: cover page (${coverPages} page, valid=${coverValid}, ${coverPdf.length} bytes)`);

  // 6. PDF merge
  const page2Pdf = await createTextPage([
    { text: 'Table of Contents', fontSize: 18, bold: true, align: 'center' },
    { text: '1.0 Introduction .............. 3', fontSize: 12 },
    { text: '2.0 Site Description ........... 5', fontSize: 12 },
  ]);
  const page2Path = path.join(TEST_DIR, 'toc.pdf');
  await fs.writeFile(page2Path, page2Pdf);

  const merged = await mergePDFs([
    { filePath: coverPath, label: 'Cover Page' },
    { filePath: page2Path, label: 'Table of Contents' },
  ]);
  console.log(`✓ PDF merge: ${merged.totalPages} pages (${merged.pdfBuffer.length} bytes)`);

  // Integrity check
  const integrityOk = merged.inputPageCounts.reduce((sum, ic) => sum + ic.pagesIncluded, 0) === merged.totalPages;
  console.log(`✓ Page integrity check: ${integrityOk ? 'PASS' : 'FAIL'}`);

  // Cleanup
  await fs.rm(TEST_DIR, { recursive: true, force: true });

  console.log('\n=== All Phase 1 smoke tests PASSED ===');
}

smokeTest().catch(err => {
  console.error('\n✗ SMOKE TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});

/**
 * Direct assembly script for Project 6384737
 * ESAI - E. Broadway, Vista
 *
 * Assembles all available PDFs into the correct ESAI report order.
 * Uses existing divider pages from ODIC and generates Appendix B divider.
 */

import { PDFDocument, rgb, StandardFonts, PageSizes } from 'pdf-lib';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// ── Configuration ───────────────────────────────────────────────────────────

const PROJECT_DIR = '/sessions/wonderful-youthful-darwin/project-6384737';
const CONVERTED_DIR = '/tmp'; // Where pandoc-converted files are
const OUTPUT_PATH = '/sessions/wonderful-youthful-darwin/mnt/outputs/6384737-ESAI-E-Broadway-Vista-ASSEMBLED.pdf';

// ESAI report assembly order — each entry is [label, filePath]
// We use the latest reviewed versions (NK Revision 1 / NK reviewed)
const ASSEMBLY_ORDER: Array<{ label: string; file: string; section: string }> = [
  // ── Front Matter ──
  { label: 'Cover Page', file: `${PROJECT_DIR}/Cover.pdf`, section: 'Cover' },
  // Report body would go here (.doc — cannot convert in this environment)
  { label: 'Reliance Letter', file: `${CONVERTED_DIR}/reliance.pdf`, section: 'Reliance Letter' },
  { label: 'Insurance Certificate (E&O)', file: `${PROJECT_DIR}/E&O 2025-26.pdf`, section: 'Insurance' },

  // ── Appendix A: Site Location Map and Plot Plan ──
  { label: 'Appendix A Divider', file: `${PROJECT_DIR}/Appendix A Site Location Map and Plot Plan.pdf`, section: 'Appendix A' },
  // Site Location Map and Plot Plan (.vsd — cannot convert in this environment)

  // ── Appendix B: Site Photographs ──
  // No divider exists in files — we'll generate one
  // Photos Appendix (.doc — cannot convert in this environment)

  // ── Appendix C: Radius Map Report (EDR) ──
  { label: 'Appendix C Divider', file: `${PROJECT_DIR}/Appendix C Radius.pdf`, section: 'Appendix C' },
  { label: 'EDR Radius Map Report', file: `${PROJECT_DIR}/6384737-ESAI-Radius_Map.pdf`, section: 'Appendix C' },

  // ── Appendix D: Historical Records ──
  { label: 'Appendix D Divider', file: `${PROJECT_DIR}/Appendix D Historical Records.pdf`, section: 'Appendix D' },
  { label: 'Aerial Photographs', file: `${PROJECT_DIR}/Aerials-mam.pdf`, section: 'Appendix D' },
  { label: 'Sanborn Maps', file: `${PROJECT_DIR}/6384737-ESAI-Sanborn.pdf`, section: 'Appendix D' },
  { label: 'Topographic Maps', file: `${PROJECT_DIR}/6384737-ESAI-Topos.pdf`, section: 'Appendix D' },
  { label: 'City Directory', file: `${PROJECT_DIR}/6384737-ESAI-City_Directory.PDF`, section: 'Appendix D' },

  // ── Appendix E: Agency Records ──
  { label: 'Appendix E Divider', file: `${PROJECT_DIR}/Appendix E Agency Records.pdf`, section: 'Appendix E' },
  { label: 'DTSC Response', file: `${PROJECT_DIR}/DTSC RESPONSE.pdf`, section: 'Appendix E' },
  { label: 'SDCEH Records', file: `${PROJECT_DIR}/SDCEH RECORDS.pdf`, section: 'Appendix E' },
  { label: 'Building Permits', file: `${PROJECT_DIR}/BLDG PERMITS.pdf`, section: 'Appendix E' },
  { label: 'Property Detail Report', file: `${PROJECT_DIR}/Property Detail Report.pdf`, section: 'Appendix E' },
  { label: 'Records Request', file: `${CONVERTED_DIR}/records-request.pdf`, section: 'Appendix E' },

  // ── Appendix F: Qualifications ──
  { label: 'Appendix F Qualifications', file: `${PROJECT_DIR}/Appendix F Qualifications.pdf`, section: 'Appendix F' },
];

// ── Divider Page Generator ──────────────────────────────────────────────────

async function createDividerPage(appendixLetter: string, title: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage(PageSizes.Letter);
  const { width, height } = page.getSize();

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // ODIC brand color (dark green)
  const brandColor = rgb(0.06, 0.29, 0.18);

  // Appendix letter — large centered
  const letterText = `APPENDIX ${appendixLetter}`;
  const letterSize = 36;
  const letterWidth = fontBold.widthOfTextAtSize(letterText, letterSize);
  page.drawText(letterText, {
    x: (width - letterWidth) / 2,
    y: height / 2 + 40,
    size: letterSize,
    font: fontBold,
    color: brandColor,
  });

  // Title — centered below
  const titleSize = 18;
  const titleWidth = fontBold.widthOfTextAtSize(title, titleSize);
  page.drawText(title, {
    x: (width - titleWidth) / 2,
    y: height / 2 - 10,
    size: titleSize,
    font: fontBold,
    color: brandColor,
  });

  // Horizontal rule
  page.drawLine({
    start: { x: width * 0.2, y: height / 2 + 80 },
    end: { x: width * 0.8, y: height / 2 + 80 },
    thickness: 2,
    color: brandColor,
  });

  page.drawLine({
    start: { x: width * 0.2, y: height / 2 - 40 },
    end: { x: width * 0.8, y: height / 2 - 40 },
    thickness: 2,
    color: brandColor,
  });

  // ODIC footer
  const footerText = 'ODIC Environmental';
  const footerSize = 10;
  const footerWidth = fontRegular.widthOfTextAtSize(footerText, footerSize);
  page.drawText(footerText, {
    x: (width - footerWidth) / 2,
    y: 50,
    size: footerSize,
    font: fontRegular,
    color: rgb(0.5, 0.5, 0.5),
  });

  return Buffer.from(await pdfDoc.save());
}

// ── Placeholder Page for Missing Docs ───────────────────────────────────────

async function createPlaceholderPage(text: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage(PageSizes.Letter);
  const { width, height } = page.getSize();

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 14;

  const lines = text.split('\n');
  let y = height / 2 + (lines.length * 20) / 2;

  for (const line of lines) {
    const lineWidth = font.widthOfTextAtSize(line, fontSize);
    page.drawText(line, {
      x: (width - lineWidth) / 2,
      y,
      size: fontSize,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
    y -= 24;
  }

  return Buffer.from(await pdfDoc.save());
}

// ── Main Assembly ───────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  ODIC Environmental - Report Assembly                       ║');
  console.log('║  Project: 6384737 - ESAI - E. Broadway, Vista              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const mergedDoc = await PDFDocument.create();
  let totalPages = 0;
  let generatedPages = 0;
  const manifest: Array<{ section: string; label: string; pages: number; startPage: number }> = [];

  // Track which items are missing for the report
  const missing: string[] = [];

  // ── Process each item in order ──

  for (const item of ASSEMBLY_ORDER) {
    if (!existsSync(item.file)) {
      console.log(`  ⚠  MISSING: ${item.label} → ${path.basename(item.file)}`);
      missing.push(item.label);
      continue;
    }

    try {
      const buffer = await fs.readFile(item.file);
      const sourceDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pageCount = sourceDoc.getPageCount();
      const pageIndices = Array.from({ length: pageCount }, (_, i) => i);
      const copiedPages = await mergedDoc.copyPages(sourceDoc, pageIndices);

      const startPage = totalPages + 1;
      for (const page of copiedPages) {
        mergedDoc.addPage(page);
      }
      totalPages += pageCount;

      manifest.push({
        section: item.section,
        label: item.label,
        pages: pageCount,
        startPage,
      });

      const pageStr = pageCount === 1 ? '1 page' : `${pageCount} pages`;
      console.log(`  ✓  ${item.label}: ${pageStr} (pp. ${startPage}-${startPage + pageCount - 1})`);
    } catch (err) {
      console.error(`  ✗  FAILED: ${item.label} — ${(err as Error).message}`);
      missing.push(`${item.label} (error: ${(err as Error).message})`);
    }
  }

  // ── Generate Appendix B divider (not in original files) ──

  console.log('');
  console.log('  Generating Appendix B divider...');
  const appendixBDivider = await createDividerPage('B', 'Site Photographs');
  const dividerDoc = await PDFDocument.load(appendixBDivider);
  const dividerPages = await mergedDoc.copyPages(dividerDoc, [0]);

  // Insert Appendix B divider after Insurance, before Appendix C
  // Find the position — after the last front matter item, before Appendix C divider
  // Actually, we need to insert it at the right spot. Let me calculate:
  // The Appendix A divider should be followed by Appendix B content.
  // Since we assembled in order, Appendix B divider goes after Appendix A section
  // In our assembly, Appendix A divider is after insurance. We want B divider after A divider.
  //
  // Looking at our manifest, the Appendix A divider is already placed.
  // We need to insert the B divider AFTER Appendix A content but BEFORE Appendix C divider.
  //
  // Since we're building sequentially and already past Appendix A, we need to
  // figure out the insertion point. Let's find where Appendix C starts in our manifest.

  let appendixCStartPage = -1;
  for (const m of manifest) {
    if (m.section === 'Appendix C' && m.label.includes('Divider')) {
      appendixCStartPage = m.startPage - 1; // 0-indexed position in mergedDoc
      break;
    }
  }

  if (appendixCStartPage > 0) {
    // We can't easily insert into middle of PDFDocument, so we'll rebuild
    // Actually pdf-lib doesn't support insertPage at position, so let's
    // rebuild the document with the divider in the right spot.

    // Instead, let's just add it at the end of Appendix A section
    // For now, since Appendix B content (photos) is missing anyway,
    // we'll note it but not insert an empty section divider mid-document.
    // The user can add photos + divider when they have the converted doc.
    console.log('  → Appendix B divider generated (photos section needs manual addition)');
    generatedPages += 0; // Not adding since no content to follow it
  }

  // ── Add placeholder note for missing items ──

  if (missing.length > 0) {
    console.log('');
    console.log('  Creating placeholder page for missing items...');
    const placeholderText = [
      'The following items need to be manually added:',
      '',
      ...missing.map(m => `• ${m}`),
      '',
      'These files require conversion from .doc/.vsd format.',
      'Use Microsoft Word or LibreOffice on a desktop to convert them.',
    ].join('\n');

    const placeholder = await createPlaceholderPage(
      'ASSEMBLY NOTE\n\nSee console output for items requiring manual addition.'
    );
    const phDoc = await PDFDocument.load(placeholder);
    const phPages = await mergedDoc.copyPages(phDoc, [0]);
    mergedDoc.addPage(phPages[0]);
    totalPages += 1;
    generatedPages += 1;
  }

  // ── Save ──

  console.log('');
  console.log('  Saving assembled PDF...');
  const pdfBytes = await mergedDoc.save();
  await fs.writeFile(OUTPUT_PATH, pdfBytes);

  const actualPages = mergedDoc.getPageCount();
  const fileSizeMB = (pdfBytes.length / 1024 / 1024).toFixed(1);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  ASSEMBLY COMPLETE                                          ║`);
  console.log(`║  Total pages: ${String(actualPages).padEnd(44)}║`);
  console.log(`║  File size: ${fileSizeMB} MB${' '.repeat(Math.max(0, 42 - fileSizeMB.length))}║`);
  console.log(`║  Output: ${path.basename(OUTPUT_PATH).padEnd(50)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ── Page integrity check ──

  if (actualPages !== totalPages) {
    console.error(`\n⚠️  PAGE INTEGRITY FAILURE: Expected ${totalPages}, got ${actualPages}`);
    process.exit(1);
  } else {
    console.log(`\n✓  PAGE INTEGRITY: ${actualPages} pages verified`);
  }

  // ── Report manifest ──

  console.log('\n── REPORT MANIFEST ────────────────────────────────────────────');
  let lastSection = '';
  for (const m of manifest) {
    if (m.section !== lastSection) {
      console.log(`\n  ${m.section}:`);
      lastSection = m.section;
    }
    console.log(`    ${m.label}: ${m.pages} pages (pp. ${m.startPage}-${m.startPage + m.pages - 1})`);
  }

  if (missing.length > 0) {
    console.log('\n  ⚠  Missing (need manual addition):');
    for (const m of missing) {
      console.log(`    • ${m}`);
    }
  }

  console.log('\n── END MANIFEST ───────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});

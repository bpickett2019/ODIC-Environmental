/**
 * PDF Post-Processing Utilities.
 *
 * Handles post-assembly operations for ESA report delivery:
 * - PDF compression via Ghostscript (replaces manual iLovePDF workflow)
 * - Locked/encrypted PDF handling via qpdf + pdf-lib fallback
 * - Smart report splitting for email attachment limits
 *
 * NO AI logic here — this is pure TypeScript/library code.
 */

import { PDFDocument, StandardFonts, PageSizes, rgb } from 'pdf-lib';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import pino from 'pino';

const logger = pino({ name: 'PDFPostProcess', level: process.env.LOG_LEVEL || 'info' });

// ── Tool Detection ───────────────────────────────────────────────────────────

const GS_PATH = '/opt/homebrew/bin/gs';
const QPDF_PATH = '/usr/local/bin/qpdf';
const QPDF_BREW_PATH = '/opt/homebrew/bin/qpdf';

/**
 * Resolve the path to a CLI tool, checking common locations.
 * Returns the path if found, or null if not available.
 */
async function resolveToolPath(name: string, candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Try finding via `which` as a last resort
  try {
    const { execaCommand } = await import('execa');
    const result = await execaCommand(`which ${name}`, { timeout: 5000 });
    const found = result.stdout.trim();
    if (found && existsSync(found)) return found;
  } catch {
    // not found
  }

  return null;
}

/** Cache resolved tool paths so we only look up once per process */
const toolCache: Record<string, string | null | undefined> = {};

async function getGsPath(): Promise<string | null> {
  if (toolCache.gs === undefined) {
    toolCache.gs = await resolveToolPath('gs', [GS_PATH, '/usr/local/bin/gs', '/usr/bin/gs']);
  }
  return toolCache.gs;
}

async function getQpdfPath(): Promise<string | null> {
  if (toolCache.qpdf === undefined) {
    toolCache.qpdf = await resolveToolPath('qpdf', [QPDF_BREW_PATH, QPDF_PATH, '/usr/bin/qpdf']);
  }
  return toolCache.qpdf;
}

// ── Helper ───────────────────────────────────────────────────────────────────

/** Get file size in megabytes. */
async function fileSizeMB(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size / (1024 * 1024);
}

// ── PDF Compression (Ghostscript) ────────────────────────────────────────────

/** Ghostscript quality presets — ordered from smallest to largest output. */
type GsQuality = 'screen' | 'ebook' | 'printer' | 'prepress';

export interface CompressOptions {
  /** Ghostscript dPDFSETTINGS quality preset. Default: 'ebook' (good balance). */
  quality?: GsQuality;
  /** Target maximum file size in MB. If exceeded after initial compression, retries with harder preset. */
  maxSizeMB?: number;
}

export interface CompressResult {
  /** Path to the compressed output file. */
  outputPath: string;
  /** Size of the input file in MB. */
  inputSizeMB: number;
  /** Size of the output file in MB. */
  outputSizeMB: number;
  /** Percentage reduction (0-100). */
  reductionPercent: number;
}

/**
 * Compress a PDF using Ghostscript.
 *
 * Uses the 'ebook' preset by default which preserves map and image clarity
 * at 150 DPI — sufficient for on-screen review and standard printing.
 * If the result exceeds `maxSizeMB`, automatically retries with 'screen' (72 DPI).
 *
 * @param inputPath  - Absolute path to the source PDF.
 * @param outputPath - Absolute path for the compressed output.
 * @param options    - Compression options.
 * @returns Size statistics for dashboard reporting.
 *
 * @example
 * ```ts
 * const result = await compressPDF('/reports/draft.pdf', '/reports/draft-compressed.pdf', {
 *   maxSizeMB: 25,
 * });
 * console.log(`Reduced by ${result.reductionPercent}%`);
 * ```
 */
export async function compressPDF(
  inputPath: string,
  outputPath: string,
  options?: CompressOptions,
): Promise<CompressResult> {
  const gsPath = await getGsPath();
  if (!gsPath) {
    throw new Error(
      'Ghostscript (gs) is not installed or not found. ' +
      'Install via: brew install ghostscript',
    );
  }

  const inputSize = await fileSizeMB(inputPath);
  const quality: GsQuality = options?.quality ?? 'ebook';
  const maxSizeMB = options?.maxSizeMB;

  // Quality ladder — try requested quality first, then fall back to harder preset
  const ladder: GsQuality[] = buildQualityLadder(quality);

  let lastOutputSize = inputSize;

  for (const preset of ladder) {
    await runGhostscript(gsPath, inputPath, outputPath, preset);

    lastOutputSize = await fileSizeMB(outputPath);

    logger.info(
      { preset, inputSizeMB: round(inputSize), outputSizeMB: round(lastOutputSize) },
      `Compressed with /${preset}: ${round(inputSize)} MB -> ${round(lastOutputSize)} MB`,
    );

    // If no max size target, or we're already under it, stop here
    if (!maxSizeMB || lastOutputSize <= maxSizeMB) {
      break;
    }

    // If this wasn't the last preset in the ladder, we'll loop and try harder
    if (preset !== ladder[ladder.length - 1]) {
      logger.info(
        { preset, targetMB: maxSizeMB, actualMB: round(lastOutputSize) },
        `Still over target (${round(lastOutputSize)} MB > ${maxSizeMB} MB), trying harder preset`,
      );
    }
  }

  const reductionPercent = inputSize > 0
    ? round(((inputSize - lastOutputSize) / inputSize) * 100)
    : 0;

  return {
    outputPath,
    inputSizeMB: round(inputSize),
    outputSizeMB: round(lastOutputSize),
    reductionPercent,
  };
}

/**
 * Build a quality ladder from the requested quality down to 'screen'.
 * E.g. if requested 'printer', ladder is ['printer', 'ebook', 'screen'].
 */
function buildQualityLadder(startQuality: GsQuality): GsQuality[] {
  const allPresets: GsQuality[] = ['prepress', 'printer', 'ebook', 'screen'];
  const startIdx = allPresets.indexOf(startQuality);
  // Return from the requested quality onwards (toward more aggressive compression)
  return allPresets.slice(startIdx);
}

/**
 * Execute Ghostscript with the given quality preset.
 *
 * Uses settings tuned to preserve map and image legibility:
 * - ColorImageResolution capped at 200 DPI for 'ebook' (prevents blurry maps)
 * - DownsampleColorImages only when images exceed target DPI
 * - AutoRotatePages off to preserve map orientation
 */
async function runGhostscript(
  gsPath: string,
  inputPath: string,
  outputPath: string,
  quality: GsQuality,
): Promise<void> {
  const { execaCommand } = await import('execa');

  // Base args — optimized for reports with maps and photographs
  const args = [
    `-dBATCH`,
    `-dNOPAUSE`,
    `-dQUIET`,
    `-dSAFER`,
    `-sDEVICE=pdfwrite`,
    `-dCompatibilityLevel=1.5`,
    `-dPDFSETTINGS=/${quality}`,
    `-dAutoRotatePages=/None`,            // Preserve map orientation
    `-dColorImageDownsampleType=/Bicubic`, // Better quality downsampling
    `-dGrayImageDownsampleType=/Bicubic`,
  ];

  // For 'ebook' preset: bump image resolution to prevent blurry maps.
  // Default ebook is 150 DPI; we use 200 DPI for color images.
  if (quality === 'ebook') {
    args.push(
      `-dColorImageResolution=200`,
      `-dGrayImageResolution=200`,
      `-dMonoImageResolution=300`,
      `-dDownsampleColorImages=true`,
      `-dColorImageDownsampleThreshold=1.5`, // Only downsample if >300 DPI source
    );
  }

  args.push(`-sOutputFile=${outputPath}`, inputPath);

  const cmd = `"${gsPath}" ${args.join(' ')}`;

  try {
    await execaCommand(cmd, { timeout: 300_000, shell: true }); // 5 min timeout for large files
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Ghostscript compression failed (/${quality}): ${message}`);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Locked PDF Handling (qpdf) ───────────────────────────────────────────────

/**
 * Check whether a PDF file is encrypted or has access restrictions.
 *
 * Tries qpdf first (most reliable), then falls back to pdf-lib header inspection.
 *
 * @param filePath - Absolute path to the PDF file.
 * @returns `true` if the PDF is locked/encrypted, `false` otherwise.
 *
 * @example
 * ```ts
 * if (await isLocked('/docs/client-report.pdf')) {
 *   await unlockPDF('/docs/client-report.pdf', '/docs/client-report-unlocked.pdf');
 * }
 * ```
 */
export async function isLocked(filePath: string): Promise<boolean> {
  // Strategy 1: use qpdf --check
  const qpdfPath = await getQpdfPath();
  if (qpdfPath) {
    try {
      const { execaCommand } = await import('execa');
      const result = await execaCommand(
        `"${qpdfPath}" --is-encrypted "${filePath}"`,
        { timeout: 15_000, shell: true, reject: false },
      );
      // qpdf --is-encrypted exits 0 if encrypted, 2 if not encrypted
      return result.exitCode === 0;
    } catch {
      logger.debug({ filePath }, 'qpdf --is-encrypted check failed, falling back to pdf-lib');
    }
  }

  // Strategy 2: try loading with pdf-lib — encrypted PDFs throw without ignoreEncryption
  try {
    const buffer = await fs.readFile(filePath);
    await PDFDocument.load(buffer, { ignoreEncryption: false });
    return false; // Loaded fine — not encrypted
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('encrypt')) {
      return true;
    }
    // Some other load error — not necessarily encryption
    logger.warn({ filePath, error: message }, 'PDF load error during encryption check');
    return false;
  }
}

/**
 * Remove encryption and access restrictions from a PDF.
 *
 * Uses qpdf as the primary method (handles most password-protected PDFs),
 * with pdf-lib's `ignoreEncryption` as a fallback for simpler protection.
 *
 * @param inputPath  - Absolute path to the locked PDF.
 * @param outputPath - Absolute path for the unlocked output.
 * @returns `true` if the PDF was successfully unlocked, `false` otherwise.
 *
 * @example
 * ```ts
 * const success = await unlockPDF('/docs/locked.pdf', '/docs/unlocked.pdf');
 * if (!success) console.error('Could not remove PDF protection');
 * ```
 */
export async function unlockPDF(inputPath: string, outputPath: string): Promise<boolean> {
  // Strategy 1: qpdf --decrypt
  const qpdfPath = await getQpdfPath();
  if (qpdfPath) {
    try {
      const { execaCommand } = await import('execa');
      await execaCommand(
        `"${qpdfPath}" --decrypt "${inputPath}" "${outputPath}"`,
        { timeout: 60_000, shell: true },
      );

      // Verify the output was created and is a valid PDF
      if (existsSync(outputPath)) {
        const size = await fileSizeMB(outputPath);
        if (size > 0) {
          logger.info({ inputPath, outputPath }, 'PDF unlocked via qpdf --decrypt');
          return true;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { inputPath, error: message },
        'qpdf --decrypt failed, trying pdf-lib fallback',
      );
    }
  }

  // Strategy 2: pdf-lib with ignoreEncryption — works for owner-password-only PDFs
  try {
    const buffer = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const savedBytes = await pdfDoc.save();
    await fs.writeFile(outputPath, savedBytes);

    logger.info({ inputPath, outputPath }, 'PDF unlocked via pdf-lib ignoreEncryption');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { inputPath, error: message },
      'Failed to unlock PDF — both qpdf and pdf-lib methods failed',
    );
    return false;
  }
}

// ── Smart File Splitting ─────────────────────────────────────────────────────

export interface SplitResult {
  /** Array of split parts with metadata. */
  parts: Array<{
    /** Absolute path to the part file. */
    path: string;
    /** Human-readable label (e.g. "Part 1 of 3 — Report"). */
    label: string;
    /** File size in MB. */
    sizeMB: number;
    /** Number of pages in this part. */
    pageCount: number;
  }>;
  /** Total number of parts generated. */
  totalParts: number;
}

export interface SplitOptions {
  /** Maximum size per part in MB. Default: 20 (safe for email). */
  maxPartSizeMB?: number;
}

/**
 * Split an assembled ESA report into email-safe parts.
 *
 * Split strategy:
 *  - Part 1 = "Report" — front matter + body + Appendix A through C
 *  - Part 2+ = remaining appendices, split further if any part exceeds the limit
 *
 * Each part starts with a generated cover page: "Part N of M — [Label]".
 *
 * @param assembledPath  - Absolute path to the fully assembled report PDF.
 * @param projectFiles   - Ordered list of source files with section/label metadata.
 *                          Used to determine where to split (appendix boundaries).
 * @param options        - Split options (max size per part).
 * @returns Split result with paths and metadata for each part.
 *
 * @example
 * ```ts
 * const result = await splitReport('/reports/ODIC-2024-001.pdf', projectFiles, {
 *   maxPartSizeMB: 20,
 * });
 * for (const part of result.parts) {
 *   console.log(`${part.label}: ${part.sizeMB} MB, ${part.pageCount} pages`);
 * }
 * ```
 */
export async function splitReport(
  assembledPath: string,
  projectFiles: Array<{ filename: string; section: string; label: string }>,
  options?: SplitOptions,
): Promise<SplitResult> {
  const maxPartSizeMB = options?.maxPartSizeMB ?? 20;

  const inputSize = await fileSizeMB(assembledPath);

  // If already under the limit, no splitting needed
  if (inputSize <= maxPartSizeMB) {
    logger.info(
      { sizeMB: round(inputSize), maxPartSizeMB },
      'Report is under size limit — no splitting needed',
    );
    return {
      parts: [{
        path: assembledPath,
        label: 'Full Report',
        sizeMB: round(inputSize),
        pageCount: await countPages(assembledPath),
      }],
      totalParts: 1,
    };
  }

  const buffer = await fs.readFile(assembledPath);
  const sourceDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = sourceDoc.getPageCount();

  // Determine the split point: find where "remaining appendices" (D+) start.
  // We use the projectFiles metadata to estimate the page boundary.
  const splitPageIndex = estimateSplitPage(totalPages, projectFiles);

  logger.info(
    { totalPages, splitPageIndex, inputSizeMB: round(inputSize) },
    `Splitting report at page ${splitPageIndex}`,
  );

  // Build the parts list by splitting at the estimated boundary
  const rawParts = buildPartRanges(totalPages, splitPageIndex, maxPartSizeMB, inputSize);

  // Generate output directory next to the assembled file
  const dir = path.dirname(assembledPath);
  const baseName = path.basename(assembledPath, '.pdf');
  const totalParts = rawParts.length;
  const parts: SplitResult['parts'] = [];

  for (let i = 0; i < rawParts.length; i++) {
    const range = rawParts[i];
    const partNum = i + 1;
    const label = partNum === 1 ? 'Report' : `Appendices (Part ${partNum})`;
    const fullLabel = `Part ${partNum} of ${totalParts} — ${label}`;
    const outputPath = path.join(dir, `${baseName}_part${partNum}.pdf`);

    // Create cover page for this part
    const coverBuffer = await createPartCoverPage(partNum, totalParts, label);

    // Extract the page range from the source document
    const partDoc = await PDFDocument.create();

    // Add cover page
    const coverDoc = await PDFDocument.load(coverBuffer);
    const [coverPage] = await partDoc.copyPages(coverDoc, [0]);
    partDoc.addPage(coverPage);

    // Add content pages
    const pageIndices = Array.from(
      { length: range.endPage - range.startPage },
      (_, idx) => range.startPage + idx,
    );
    const contentPages = await partDoc.copyPages(sourceDoc, pageIndices);
    for (const page of contentPages) {
      partDoc.addPage(page);
    }

    const partBytes = await partDoc.save();
    await fs.writeFile(outputPath, partBytes);

    const partSize = await fileSizeMB(outputPath);
    const partPageCount = partDoc.getPageCount();

    parts.push({
      path: outputPath,
      label: fullLabel,
      sizeMB: round(partSize),
      pageCount: partPageCount,
    });

    logger.info(
      { partNum, totalParts, pages: partPageCount, sizeMB: round(partSize) },
      `Created ${fullLabel} (${partPageCount} pages, ${round(partSize)} MB)`,
    );
  }

  return { parts, totalParts };
}

// ── Split Helpers ────────────────────────────────────────────────────────────

/**
 * Estimate the page index where "Part 1" (report body + Appendix A-C) ends.
 *
 * Uses the projectFiles metadata to find where Appendix D or later begins.
 * If metadata is insufficient, falls back to a 60/40 split heuristic
 * (report body is typically 60% of pages).
 */
function estimateSplitPage(
  totalPages: number,
  projectFiles: Array<{ filename: string; section: string; label: string }>,
): number {
  // Look for Appendix D or later in the project files
  const appendixSections = ['appendix_d', 'appendix_e', 'appendix_f', 'appendix_g', 'appendix_h'];
  const coreCount = projectFiles.filter(
    (f) => !appendixSections.includes(f.section),
  ).length;
  const totalCount = projectFiles.length;

  if (totalCount > 0 && coreCount > 0 && coreCount < totalCount) {
    // Proportional estimate: assume pages are roughly evenly distributed across files
    const ratio = coreCount / totalCount;
    const splitPage = Math.round(totalPages * ratio);
    // Ensure at least some pages in each part
    return Math.max(1, Math.min(splitPage, totalPages - 1));
  }

  // Fallback: 60/40 split
  return Math.round(totalPages * 0.6);
}

interface PartRange {
  startPage: number; // inclusive, 0-based
  endPage: number;   // exclusive, 0-based
}

/**
 * Build page ranges for each part, further splitting if a part would still
 * exceed the max size. Uses a proportional size estimate based on page count.
 */
function buildPartRanges(
  totalPages: number,
  splitPageIndex: number,
  maxPartSizeMB: number,
  totalSizeMB: number,
): PartRange[] {
  const avgPageSizeMB = totalSizeMB / totalPages;
  const ranges: PartRange[] = [];

  // Part 1: pages 0..splitPageIndex
  const part1Pages = splitPageIndex;
  const part1EstSize = part1Pages * avgPageSizeMB;

  if (part1EstSize <= maxPartSizeMB) {
    ranges.push({ startPage: 0, endPage: splitPageIndex });
  } else {
    // Part 1 itself is too big — split it into chunks
    const maxPagesPerPart = Math.floor(maxPartSizeMB / avgPageSizeMB);
    for (let start = 0; start < splitPageIndex; start += maxPagesPerPart) {
      const end = Math.min(start + maxPagesPerPart, splitPageIndex);
      ranges.push({ startPage: start, endPage: end });
    }
  }

  // Remaining parts: pages splitPageIndex..totalPages
  const remainingPages = totalPages - splitPageIndex;
  if (remainingPages > 0) {
    const remainingEstSize = remainingPages * avgPageSizeMB;
    if (remainingEstSize <= maxPartSizeMB) {
      ranges.push({ startPage: splitPageIndex, endPage: totalPages });
    } else {
      const maxPagesPerPart = Math.floor(maxPartSizeMB / avgPageSizeMB);
      for (let start = splitPageIndex; start < totalPages; start += maxPagesPerPart) {
        const end = Math.min(start + maxPagesPerPart, totalPages);
        ranges.push({ startPage: start, endPage: end });
      }
    }
  }

  return ranges;
}

/**
 * Create a cover page for a split part.
 * Shows "Part N of M" with the part label, styled for professional delivery.
 */
async function createPartCoverPage(
  partNum: number,
  totalParts: number,
  label: string,
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage(PageSizes.Letter);
  const { width, height } = page.getSize();

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // "Part N of M" — centered, large
  const partText = `Part ${partNum} of ${totalParts}`;
  const partTextWidth = fontBold.widthOfTextAtSize(partText, 28);
  page.drawText(partText, {
    x: (width - partTextWidth) / 2,
    y: height * 0.6,
    size: 28,
    font: fontBold,
    color: rgb(0.15, 0.15, 0.15),
  });

  // Label — centered, medium
  const labelWidth = fontRegular.widthOfTextAtSize(label, 18);
  page.drawText(label, {
    x: (width - labelWidth) / 2,
    y: height * 0.6 - 45,
    size: 18,
    font: fontRegular,
    color: rgb(0.35, 0.35, 0.35),
  });

  // Divider line
  const lineY = height * 0.6 - 70;
  page.drawLine({
    start: { x: width * 0.25, y: lineY },
    end: { x: width * 0.75, y: lineY },
    thickness: 1,
    color: rgb(0.7, 0.7, 0.7),
  });

  // "This document has been split for email delivery" — small note
  const noteText = 'This document has been split for email delivery.';
  const noteWidth = fontRegular.widthOfTextAtSize(noteText, 11);
  page.drawText(noteText, {
    x: (width - noteWidth) / 2,
    y: lineY - 30,
    size: 11,
    font: fontRegular,
    color: rgb(0.5, 0.5, 0.5),
  });

  return Buffer.from(await pdfDoc.save());
}

/** Count pages in a PDF file. */
async function countPages(filePath: string): Promise<number> {
  const buffer = await fs.readFile(filePath);
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}

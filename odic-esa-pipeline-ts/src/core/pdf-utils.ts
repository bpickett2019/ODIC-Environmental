/**
 * Shared PDF manipulation utilities.
 *
 * Handles all byte-level PDF operations:
 * - Text extraction (pdf-parse)
 * - Page-to-image conversion (pdf2pic + sharp, with fallback to pdf-lib rendering info)
 * - PDF merging (pdf-lib)
 * - Page counting (pdf-lib)
 * - New page generation (pdf-lib)
 *
 * NO AI logic here — this is pure TypeScript/library code.
 */

import { PDFDocument, rgb, StandardFonts, PageSizes } from 'pdf-lib';
import pdfParse from 'pdf-parse';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import pino from 'pino';

const logger = pino({ name: 'PDFUtils', level: process.env.LOG_LEVEL || 'info' });

// ── Text Extraction ──────────────────────────────────────────────────────────

export interface ExtractedText {
  /** Full text of the document */
  fullText: string;
  /** Text per page (indexed from 0) */
  pages: string[];
  /** Total page count */
  pageCount: number;
  /** PDF metadata */
  metadata: {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    creationDate?: string;
  };
}

/**
 * Extract text from a PDF file.
 * @param filePath Path to the PDF
 * @param maxPages Max pages to extract (0 = all)
 */
export async function extractText(
  filePath: string,
  maxPages = 0
): Promise<ExtractedText> {
  const buffer = await fs.readFile(filePath);
  const pages: string[] = [];

  const options: Record<string, unknown> = {};
  if (maxPages > 0) {
    options.max = maxPages;
  }

  // pdf-parse pagerender callback to capture per-page text
  let currentPage = 0;
  options.pagerender = async (pageData: any) => {
    const textContent = await pageData.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ');
    pages.push(pageText);
    currentPage++;
    return pageText;
  };

  const parsed = await pdfParse(buffer, options);

  return {
    fullText: parsed.text,
    pages,
    pageCount: parsed.numpages,
    metadata: {
      title: parsed.info?.Title,
      author: parsed.info?.Author,
      subject: parsed.info?.Subject,
      creator: parsed.info?.Creator,
      creationDate: parsed.info?.CreationDate,
    },
  };
}

// ── Page Images ──────────────────────────────────────────────────────────────

/**
 * Extract page images from a PDF as PNG buffers.
 * Uses pdf-lib to get page dimensions and sharp for rendering where available.
 * Falls back to a placeholder if rendering libraries aren't available.
 *
 * @param filePath Path to the PDF
 * @param pageNumbers Which pages to render (1-based). Empty = first 3.
 * @param dpi Resolution for rendering
 */
export async function extractPageImages(
  filePath: string,
  pageNumbers: number[] = [],
  dpi = 150
): Promise<Buffer[]> {
  const buffer = await fs.readFile(filePath);
  const pdfDoc = await PDFDocument.load(buffer);
  const totalPages = pdfDoc.getPageCount();

  // Default to first 3 pages
  if (pageNumbers.length === 0) {
    pageNumbers = Array.from(
      { length: Math.min(3, totalPages) },
      (_, i) => i + 1
    );
  }

  // Filter to valid page numbers
  pageNumbers = pageNumbers.filter((p) => p >= 1 && p <= totalPages);

  const images: Buffer[] = [];

  // Try using poppler's pdftoppm if available (most reliable for rendering)
  try {
    const { execaCommand } = await import('execa');

    for (const pageNum of pageNumbers) {
      const tmpDir = `/tmp/pdf-render-${Date.now()}`;
      await fs.mkdir(tmpDir, { recursive: true });

      try {
        await execaCommand(
          `pdftoppm -png -r ${dpi} -f ${pageNum} -l ${pageNum} "${filePath}" "${tmpDir}/page"`,
          { timeout: 30000 }
        );

        // pdftoppm outputs files like page-01.png
        const files = await fs.readdir(tmpDir);
        const pngFile = files.find((f) => f.endsWith('.png'));
        if (pngFile) {
          const imgBuffer = await fs.readFile(path.join(tmpDir, pngFile));
          images.push(imgBuffer);
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    }

    if (images.length > 0) {
      logger.info({ pageCount: images.length }, 'Extracted page images via pdftoppm');
      return images;
    }
  } catch {
    logger.debug('pdftoppm not available, trying alternative methods');
  }

  // Fallback: create a simple placeholder image for each page
  // In production, pdftoppm or pdf2pic should be installed
  try {
    const sharp = (await import('sharp')).default;

    for (const pageNum of pageNumbers) {
      const page = pdfDoc.getPage(pageNum - 1);
      const { width, height } = page.getSize();

      // Scale to target DPI (PDF is 72 DPI)
      const scale = dpi / 72;
      const imgWidth = Math.round(width * scale);
      const imgHeight = Math.round(height * scale);

      // Create a placeholder image with page info text
      const svgText = `
        <svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#f5f5f5"/>
          <text x="50%" y="50%" text-anchor="middle" font-size="24" fill="#666">
            Page ${pageNum} of ${totalPages}
          </text>
          <text x="50%" y="55%" text-anchor="middle" font-size="14" fill="#999">
            (Install pdftoppm for full rendering)
          </text>
        </svg>
      `;

      const imgBuffer = await sharp(Buffer.from(svgText))
        .png()
        .toBuffer();

      images.push(imgBuffer);
    }

    logger.info({ pageCount: images.length }, 'Created placeholder page images via sharp');
    return images;
  } catch {
    logger.warn('sharp not available for image generation');
    return [];
  }
}

// ── Page Count ───────────────────────────────────────────────────────────────

/** Get the page count of a PDF without reading all content */
export async function getPageCount(filePath: string): Promise<number> {
  const buffer = await fs.readFile(filePath);
  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return pdfDoc.getPageCount();
}

// ── PDF Merging ──────────────────────────────────────────────────────────────

export interface MergeInput {
  /** Path to the PDF file */
  filePath: string;
  /** Label for logging/tracking */
  label: string;
  /** Specific pages to include (1-based). Empty = all pages. */
  pages?: number[];
}

export interface MergeResult {
  /** The merged PDF buffer */
  pdfBuffer: Buffer;
  /** Total page count */
  totalPages: number;
  /** Per-input page counts for integrity checking */
  inputPageCounts: Array<{
    label: string;
    filePath: string;
    pagesIncluded: number;
  }>;
}

/**
 * Merge multiple PDFs into a single document.
 * Preserves page integrity — tracks exact counts for verification.
 */
export async function mergePDFs(inputs: MergeInput[]): Promise<MergeResult> {
  const mergedDoc = await PDFDocument.create();
  const inputPageCounts: MergeResult['inputPageCounts'] = [];
  let totalExpected = 0;

  for (const input of inputs) {
    try {
      const buffer = await fs.readFile(input.filePath);
      const sourceDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const sourcePageCount = sourceDoc.getPageCount();

      let pageIndices: number[];
      if (input.pages && input.pages.length > 0) {
        // Convert 1-based to 0-based, filter valid
        pageIndices = input.pages
          .map((p) => p - 1)
          .filter((p) => p >= 0 && p < sourcePageCount);
      } else {
        pageIndices = Array.from({ length: sourcePageCount }, (_, i) => i);
      }

      const copiedPages = await mergedDoc.copyPages(sourceDoc, pageIndices);
      for (const page of copiedPages) {
        mergedDoc.addPage(page);
      }

      inputPageCounts.push({
        label: input.label,
        filePath: input.filePath,
        pagesIncluded: copiedPages.length,
      });

      totalExpected += copiedPages.length;

      logger.debug(
        { label: input.label, pages: copiedPages.length },
        `Merged: ${input.label} (${copiedPages.length} pages)`
      );
    } catch (err) {
      logger.error(
        { filePath: input.filePath, error: (err as Error).message },
        `Failed to merge PDF: ${input.filePath}`
      );
      throw new Error(
        `Failed to merge ${input.label} (${input.filePath}): ${(err as Error).message}`
      );
    }
  }

  const pdfBuffer = Buffer.from(await mergedDoc.save());
  const actualPages = mergedDoc.getPageCount();

  // Page integrity check
  if (actualPages !== totalExpected) {
    throw new Error(
      `PAGE INTEGRITY FAILURE: Expected ${totalExpected} pages, got ${actualPages}. ` +
      `This is a critical error — halting to prevent data loss.`
    );
  }

  logger.info(
    { totalPages: actualPages, inputCount: inputs.length },
    `Merged ${inputs.length} PDFs → ${actualPages} pages`
  );

  return {
    pdfBuffer,
    totalPages: actualPages,
    inputPageCounts,
  };
}

// ── PDF Generation ───────────────────────────────────────────────────────────

export interface GeneratedPageOptions {
  /** Page size (default: LETTER) */
  pageSize?: [number, number];
  /** Margin in points */
  margin?: number;
}

/**
 * Create a simple PDF page with formatted text content.
 * Used for cover pages, TOC, section dividers, etc.
 */
export async function createTextPage(
  lines: Array<{
    text: string;
    fontSize?: number;
    bold?: boolean;
    y?: number;
    align?: 'left' | 'center' | 'right';
    color?: { r: number; g: number; b: number };
  }>,
  options?: GeneratedPageOptions
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const pageSize = options?.pageSize ?? PageSizes.Letter;
  const margin = options?.margin ?? 72; // 1 inch

  const page = pdfDoc.addPage(pageSize);
  const { width, height } = page.getSize();

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let currentY = height - margin;

  for (const line of lines) {
    const fontSize = line.fontSize ?? 12;
    const font = line.bold ? fontBold : fontRegular;
    const color = line.color
      ? rgb(line.color.r, line.color.g, line.color.b)
      : rgb(0, 0, 0);

    const textWidth = font.widthOfTextAtSize(line.text, fontSize);
    let x = margin;

    if (line.align === 'center') {
      x = (width - textWidth) / 2;
    } else if (line.align === 'right') {
      x = width - margin - textWidth;
    }

    const y = line.y ?? currentY;

    page.drawText(line.text, {
      x,
      y,
      size: fontSize,
      font,
      color,
    });

    // Move down for next line
    if (line.y === undefined) {
      currentY -= fontSize * 1.5;
    }
  }

  return Buffer.from(await pdfDoc.save());
}

/**
 * Create a multi-page PDF from long-form text with professional ESA formatting.
 * Includes section headers, subsection detection, paragraph spacing, page numbers,
 * and ODIC-branded header/footer.
 */
export async function createMultiPageText(
  title: string,
  bodyText: string,
  options?: GeneratedPageOptions & {
    /** Starting page number (for whole-report numbering) */
    startPageNumber?: number;
    /** Company name for footer */
    companyName?: string;
    /** Property address for header */
    propertyAddress?: string;
  }
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const pageSize = options?.pageSize ?? PageSizes.Letter;
  const margin = options?.margin ?? 72;
  const startPageNum = options?.startPageNumber ?? 1;
  const company = options?.companyName ?? 'ODIC Environmental';
  const propAddr = options?.propertyAddress ?? '';

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const bodyFontSize = 10.5;
  const titleFontSize = 14;
  const subheadFontSize = 11.5;
  const headerFooterSize = 8;
  const lineHeight = bodyFontSize * 1.55;
  const subheadLineHeight = subheadFontSize * 1.8;
  const paragraphSpacing = lineHeight * 0.6;
  const usableWidth = pageSize[0] - margin * 2;
  const green = rgb(15 / 255, 74 / 255, 46 / 255);
  const gray = rgb(0.45, 0.45, 0.45);

  // ── Parse text into structured blocks ──
  // Detect subsection headings (e.g., "1.1 Purpose", "2.3.1 Soil Types")
  // and paragraph breaks (double newlines)
  interface TextBlock {
    type: 'heading' | 'subheading' | 'paragraph' | 'blank';
    text: string;
  }

  const blocks: TextBlock[] = [];
  const paragraphs = bodyText.split(/\n\s*\n/);

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) { blocks.push({ type: 'blank', text: '' }); continue; }

    // Check if this paragraph is a section heading
    // Matches "1.0 Introduction", "2.3 Soil Types", "Section 5:", etc.
    const lines = trimmed.split('\n');
    for (const line of lines) {
      const lt = line.trim();
      if (!lt) continue;
      if (/^\d+\.\d+(\.\d+)?\s+[A-Z]/.test(lt) && lt.length < 120) {
        blocks.push({ type: 'subheading', text: lt });
      } else if (/^(Section\s+)?\d+\.\d+\s/i.test(lt) && lt.length < 120) {
        blocks.push({ type: 'subheading', text: lt });
      } else {
        blocks.push({ type: 'paragraph', text: lt });
      }
    }
  }

  // ── Word-wrap a string into lines ──
  function wrapText(text: string, font: typeof fontRegular, fontSize: number, maxWidth: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(test, fontSize) > maxWidth && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // ── Draw header and footer on a page ──
  function drawHeaderFooter(page: ReturnType<typeof pdfDoc.addPage>, pageNum: number) {
    const { width, height } = page.getSize();

    // Header line
    page.drawLine({
      start: { x: margin, y: height - margin + 18 },
      end: { x: width - margin, y: height - margin + 18 },
      thickness: 0.5, color: green,
    });
    // Header text — property address (left) and company (right)
    if (propAddr) {
      const truncAddr = propAddr.length > 60 ? propAddr.substring(0, 57) + '...' : propAddr;
      page.drawText(truncAddr, { x: margin, y: height - margin + 24, size: headerFooterSize, font: fontItalic, color: gray });
    }
    page.drawText(company, { x: width - margin - fontRegular.widthOfTextAtSize(company, headerFooterSize), y: height - margin + 24, size: headerFooterSize, font: fontRegular, color: gray });

    // Footer line
    page.drawLine({
      start: { x: margin, y: margin - 18 },
      end: { x: width - margin, y: margin - 18 },
      thickness: 0.5, color: green,
    });
    // Footer — page number centered
    const pageStr = `Page ${pageNum}`;
    page.drawText(pageStr, {
      x: (width - fontRegular.widthOfTextAtSize(pageStr, headerFooterSize)) / 2,
      y: margin - 30, size: headerFooterSize, font: fontRegular, color: gray,
    });
  }

  // ── Render blocks onto pages ──
  let currentPage = pdfDoc.addPage(pageSize);
  let y = currentPage.getSize().height - margin;
  let pageNum = startPageNum;
  const pages = [currentPage];

  function newPage(): void {
    drawHeaderFooter(currentPage, pageNum);
    pageNum++;
    currentPage = pdfDoc.addPage(pageSize);
    pages.push(currentPage);
    y = currentPage.getSize().height - margin;
  }

  function needsSpace(height: number): void {
    if (y - height < margin + 10) newPage();
  }

  // Section title on first page (larger, bold, green)
  currentPage.drawText(title, { x: margin, y, size: titleFontSize, font: fontBold, color: green });
  y -= titleFontSize * 1.2;
  // Underline beneath title
  currentPage.drawLine({
    start: { x: margin, y: y + 2 }, end: { x: margin + usableWidth, y: y + 2 },
    thickness: 1, color: green,
  });
  y -= titleFontSize * 0.8;

  for (const block of blocks) {
    if (block.type === 'blank') {
      y -= paragraphSpacing;
      continue;
    }

    if (block.type === 'subheading') {
      needsSpace(subheadLineHeight * 2);
      y -= paragraphSpacing * 0.5;
      currentPage.drawText(block.text, { x: margin, y, size: subheadFontSize, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
      y -= subheadLineHeight;
      continue;
    }

    // Paragraph: word-wrap and render
    const lines = wrapText(block.text, fontRegular, bodyFontSize, usableWidth);
    for (const line of lines) {
      needsSpace(lineHeight);
      currentPage.drawText(line, { x: margin, y, size: bodyFontSize, font: fontRegular, color: rgb(0.08, 0.08, 0.08) });
      y -= lineHeight;
    }
    y -= paragraphSpacing;
  }

  // Draw header/footer on last page
  drawHeaderFooter(currentPage, pageNum);

  return Buffer.from(await pdfDoc.save());
}

/**
 * Create a professional Table of Contents PDF.
 * Lists section titles with dot-leaders and page numbers.
 */
export async function createTableOfContents(
  sections: Array<{ title: string; pageNumber: number; indent?: number }>,
  options?: {
    propertyAddress?: string;
    reportDate?: string;
    companyName?: string;
  }
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const pageSize = PageSizes.Letter;
  const margin = 72;

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const green = rgb(15 / 255, 74 / 255, 46 / 255);
  const gray = rgb(0.4, 0.4, 0.4);
  const company = options?.companyName ?? 'ODIC Environmental';
  const usableWidth = pageSize[0] - margin * 2;

  let currentPage = pdfDoc.addPage(pageSize);
  const { width, height } = currentPage.getSize();
  let y = height - margin;

  // TOC header
  const tocTitle = 'TABLE OF CONTENTS';
  currentPage.drawText(tocTitle, {
    x: (width - fontBold.widthOfTextAtSize(tocTitle, 16)) / 2,
    y, size: 16, font: fontBold, color: green,
  });
  y -= 12;
  currentPage.drawLine({
    start: { x: margin + 40, y }, end: { x: width - margin - 40, y },
    thickness: 1.5, color: green,
  });
  y -= 30;

  const entryFontSize = 10.5;
  const lineHeight = entryFontSize * 2.2;

  for (const sec of sections) {
    if (y < margin + 40) {
      // New page
      currentPage = pdfDoc.addPage(pageSize);
      y = currentPage.getSize().height - margin;
    }

    const indent = (sec.indent ?? 0) * 24;
    const font = sec.indent ? fontRegular : fontBold;
    const fontSize = sec.indent ? entryFontSize - 0.5 : entryFontSize;
    const textColor = sec.indent ? rgb(0.15, 0.15, 0.15) : rgb(0.05, 0.05, 0.05);

    const titleText = sec.title;
    const pageNumText = String(sec.pageNumber);

    const titleWidth = font.widthOfTextAtSize(titleText, fontSize);
    const pageNumWidth = fontRegular.widthOfTextAtSize(pageNumText, fontSize);

    // Draw title
    currentPage.drawText(titleText, {
      x: margin + indent, y, size: fontSize, font, color: textColor,
    });

    // Draw page number right-aligned
    currentPage.drawText(pageNumText, {
      x: margin + usableWidth - pageNumWidth, y,
      size: fontSize, font: fontRegular, color: textColor,
    });

    // Dot leader between title and page number
    const dotsStart = margin + indent + titleWidth + 6;
    const dotsEnd = margin + usableWidth - pageNumWidth - 6;
    if (dotsEnd > dotsStart + 10) {
      const dotChar = '.';
      const dotWidth = fontRegular.widthOfTextAtSize(dotChar, fontSize - 1);
      const dotCount = Math.floor((dotsEnd - dotsStart) / (dotWidth + 1.2));
      const dots = dotChar.repeat(dotCount);
      currentPage.drawText(dots, {
        x: dotsStart, y, size: fontSize - 1, font: fontRegular, color: gray,
      });
    }

    y -= lineHeight;
  }

  // Footer on each page
  for (let i = 0; i < pdfDoc.getPageCount(); i++) {
    const pg = pdfDoc.getPage(i);
    const { width: pw } = pg.getSize();
    pg.drawLine({
      start: { x: margin, y: margin - 18 }, end: { x: pw - margin, y: margin - 18 },
      thickness: 0.5, color: green,
    });
    pg.drawText(company, {
      x: (pw - fontRegular.widthOfTextAtSize(company, 8)) / 2,
      y: margin - 30, size: 8, font: fontRegular, color: gray,
    });
  }

  return Buffer.from(await pdfDoc.save());
}

// ── File Utilities ───────────────────────────────────────────────────────────

/** Compute SHA-256 hash of a file */
export async function hashFile(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Get file size in bytes */
export async function getFileSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size;
}

/** Check if a file is a valid PDF (checks magic bytes) */
export async function isValidPDF(filePath: string): Promise<boolean> {
  try {
    const fd = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(5);
    await fd.read(buffer, 0, 5, 0);
    await fd.close();
    return buffer.toString('ascii') === '%PDF-';
  } catch {
    return false;
  }
}

/** Ensure a directory exists */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Insert a generated page PDF into a larger document at a specific position.
 * Returns the new combined PDF buffer.
 */
export async function insertPagesAt(
  targetPdfBuffer: Buffer,
  insertPdfBuffer: Buffer,
  position: number
): Promise<Buffer> {
  const targetDoc = await PDFDocument.load(targetPdfBuffer);
  const insertDoc = await PDFDocument.load(insertPdfBuffer);

  const insertPageCount = insertDoc.getPageCount();
  const insertIndices = Array.from({ length: insertPageCount }, (_, i) => i);
  const copiedPages = await targetDoc.copyPages(insertDoc, insertIndices);

  // Insert pages at position (splice doesn't work directly, so rebuild)
  const newDoc = await PDFDocument.create();
  const targetPageCount = targetDoc.getPageCount();

  // Copy pages before insertion point
  if (position > 0) {
    const beforeIndices = Array.from(
      { length: Math.min(position, targetPageCount) },
      (_, i) => i
    );
    const beforePages = await newDoc.copyPages(targetDoc, beforeIndices);
    for (const p of beforePages) newDoc.addPage(p);
  }

  // Insert new pages
  const reInsert = await newDoc.copyPages(insertDoc, insertIndices);
  for (const p of reInsert) newDoc.addPage(p);

  // Copy pages after insertion point
  if (position < targetPageCount) {
    const afterIndices = Array.from(
      { length: targetPageCount - position },
      (_, i) => i + position
    );
    const afterPages = await newDoc.copyPages(targetDoc, afterIndices);
    for (const p of afterPages) newDoc.addPage(p);
  }

  return Buffer.from(await newDoc.save());
}

// ── Non-PDF to PDF Conversion ─────────────────────────────────────────────────

/**
 * Convert an image file (JPG, PNG, TIFF) to a single-page PDF.
 * Uses pdf-lib to embed the image on a letter-sized page.
 * Returns the path to the generated PDF, or null on failure.
 */
export async function convertImageToPdf(imagePath: string): Promise<string | null> {
  const ext = path.extname(imagePath).toLowerCase();
  const outputPath = imagePath.replace(/\.[^.]+$/, '.pdf');

  try {
    const imageBytes = await fs.readFile(imagePath);
    const doc = await PDFDocument.create();

    let image;
    if (ext === '.jpg' || ext === '.jpeg') {
      image = await doc.embedJpg(imageBytes);
    } else if (ext === '.png') {
      image = await doc.embedPng(imageBytes);
    } else {
      // TIFF — pdf-lib doesn't support TIFF directly; try converting via sharp if available
      try {
        const sharp = (await import('sharp')).default;
        const pngBytes = await sharp(imageBytes).png().toBuffer();
        image = await doc.embedPng(pngBytes);
      } catch {
        logger.warn({ file: imagePath }, 'TIFF conversion requires sharp — skipping');
        return null;
      }
    }

    // Scale image to fit on a letter page with margins
    const pageWidth = 612; // 8.5"
    const pageHeight = 792; // 11"
    const margin = 36; // 0.5"
    const maxW = pageWidth - margin * 2;
    const maxH = pageHeight - margin * 2;

    const scale = Math.min(maxW / image.width, maxH / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;

    const page = doc.addPage([pageWidth, pageHeight]);
    page.drawImage(image, {
      x: (pageWidth - w) / 2,
      y: (pageHeight - h) / 2,
      width: w,
      height: h,
    });

    const pdfBytes = await doc.save();
    await fs.writeFile(outputPath, pdfBytes);
    logger.info({ input: imagePath, output: outputPath }, 'Image converted to PDF');
    return outputPath;
  } catch (err) {
    logger.warn({ file: imagePath, error: (err as Error).message }, 'Image to PDF conversion failed');
    return null;
  }
}

/**
 * Find LibreOffice soffice binary path.
 */
async function findSoffice(): Promise<string | null> {
  const { execSync } = await import('child_process');
  const candidates = ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/libreoffice', '/usr/local/bin/libreoffice', '/opt/homebrew/bin/soffice'];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    execSync('which libreoffice', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
    return 'libreoffice';
  } catch {}
  return null;
}

/**
 * For .doc/.docx files, accept all Track Changes before PDF conversion.
 * Uses a Python UNO script to open, accept changes, then export as PDF.
 * Returns the path to the generated PDF, or null on failure.
 */
async function convertDocWithTrackChanges(filePath: string, outputDir: string, soffice: string): Promise<string | null> {
  try {
    const { execSync } = await import('child_process');
    const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'config', 'accept-and-convert.py');

    if (!existsSync(scriptPath)) {
      logger.warn({ scriptPath }, 'accept-and-convert.py not found — falling back to standard conversion');
      return null;
    }

    const result = execSync(`python3 "${scriptPath}" "${filePath}" "${outputDir}" "${soffice}"`, {
      encoding: 'utf-8',
      timeout: 120000,
      stdio: 'pipe',
    });

    const outputPath = result.trim().split('\n').pop()?.trim();
    if (outputPath && existsSync(outputPath)) {
      logger.info({ input: filePath, output: outputPath }, 'Doc converted to PDF with Track Changes accepted');
      return outputPath;
    }
    return null;
  } catch (err) {
    logger.warn({ file: filePath, error: (err as Error).message }, 'Track Changes accept+convert failed — falling back to standard conversion');
    return null;
  }
}

/**
 * Convert a non-PDF file to PDF using LibreOffice (for VSD, DOC, XLS, etc.)
 * For .doc/.docx files, attempts to accept Track Changes first.
 * Returns the path to the generated PDF, or null if LibreOffice is not available.
 */
export async function convertWithLibreOffice(filePath: string, outputDir: string): Promise<string | null> {
  try {
    const { execSync } = await import('child_process');

    const soffice = await findSoffice();
    if (!soffice) {
      logger.warn('LibreOffice not found — cannot convert non-PDF files');
      return null;
    }

    const ext = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath, path.extname(filePath));
    const outputPath = path.join(outputDir, `${baseName}.pdf`);

    // If a PDF with the same base name already exists (e.g. from ZIP extraction),
    // don't overwrite it — use a suffixed name instead
    let finalPath = outputPath;
    if (existsSync(outputPath)) {
      finalPath = path.join(outputDir, `${baseName}_from${ext.replace('.', '_')}.pdf`);
      logger.info({ existing: outputPath, convertedAs: finalPath }, 'PDF already exists with same name — saving converted file with suffix');
    }

    // For .doc/.docx files, try accepting Track Changes first
    if (ext === '.doc' || ext === '.docx') {
      const tcResult = await convertDocWithTrackChanges(filePath, outputDir, soffice);
      if (tcResult) {
        // If we needed a different final path, rename
        if (finalPath !== outputPath && existsSync(outputPath)) {
          const { renameSync } = await import('fs');
          renameSync(outputPath, finalPath);
          return finalPath;
        }
        return tcResult;
      }
      // Fall through to standard conversion if Track Changes method fails
    }

    // Standard LibreOffice conversion
    if (finalPath !== outputPath) {
      const tmpConvertDir = path.join(outputDir, '_convert_tmp');
      if (!existsSync(tmpConvertDir)) { const { mkdirSync } = await import('fs'); mkdirSync(tmpConvertDir, { recursive: true }); }
      execSync(`"${soffice}" --headless --convert-to pdf --outdir "${tmpConvertDir}" "${filePath}"`, {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: 'pipe',
      });
      const tmpOutput = path.join(tmpConvertDir, `${baseName}.pdf`);
      if (existsSync(tmpOutput)) {
        const { renameSync } = await import('fs');
        renameSync(tmpOutput, finalPath);
        logger.info({ input: filePath, output: finalPath }, 'File converted to PDF via LibreOffice (renamed to avoid collision)');
        return finalPath;
      }
    } else {
      execSync(`"${soffice}" --headless --convert-to pdf --outdir "${outputDir}" "${filePath}"`, {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: 'pipe',
      });
      if (existsSync(outputPath)) {
        logger.info({ input: filePath, output: outputPath }, 'File converted to PDF via LibreOffice');
        return outputPath;
      }
    }
    return null;
  } catch (err) {
    logger.warn({ file: filePath, error: (err as Error).message, stderr: (err as any).stderr }, 'LibreOffice conversion failed');
    return null;
  }
}

/**
 * Convert any supported non-PDF file to PDF.
 * Routes to the appropriate converter based on file extension.
 * Returns the path to the PDF, or null on failure.
 */
export async function convertToPdf(filePath: string, outputDir: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();

  // Images — use pdf-lib direct embedding (HEIC handled via sharp's else branch)
  if (['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic'].includes(ext)) {
    return convertImageToPdf(filePath);
  }

  // Office/Visio files — use LibreOffice
  if (['.vsd', '.vsdx', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.dbf'].includes(ext)) {
    return convertWithLibreOffice(filePath, outputDir);
  }

  logger.warn({ file: filePath, ext }, 'No converter available for this file type');
  return null;
}

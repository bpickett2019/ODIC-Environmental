/**
 * PDF Reader Skill — extracts text and page images from PDFs.
 *
 * This is the first step in classification: converting raw PDFs into
 * text + images that the AI classifier can analyze.
 *
 * Handles:
 * - Per-page text extraction (via pdf-parse)
 * - Page image rendering for visual classification (via pdftoppm / sharp fallback)
 * - Smart sampling for large documents (EDR reports can be 3000+ pages)
 * - Metadata extraction (title, author, dates)
 *
 * The sampling strategy avoids processing every page of massive documents
 * while still capturing enough signal for accurate classification.
 */

import type { AppConfig } from '../types/index.js';
import { BaseSkill, type SkillResult } from './base.js';
import { extractText, extractPageImages, getPageCount, type ExtractedText } from '../core/pdf-utils.js';

// ── Input / Output types ──────────────────────────────────────────────────────

export interface PDFReaderInput {
  /** Path to the PDF file */
  filePath: string;
  /** Max pages to extract text from (0 = all, but capped by config) */
  maxTextPages?: number;
  /** Specific pages to render as images (1-based). Empty = auto-select. */
  imagePages?: number[];
  /** Max page images to extract for classification */
  maxImages?: number;
  /** DPI for rendered images */
  dpi?: number;
}

export interface PDFReaderOutput {
  /** Total page count of the PDF */
  totalPages: number;
  /** Extracted text per sampled page (0-indexed in this array, but we track original page numbers) */
  sampledPages: SampledPage[];
  /** Combined text from all sampled pages */
  combinedText: string;
  /** Rendered page images as PNG buffers */
  pageImages: Buffer[];
  /** Which pages were rendered as images (1-based) */
  imagePageNumbers: number[];
  /** PDF metadata */
  metadata: {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    creationDate?: string;
  };
  /** File size in bytes */
  fileSizeBytes: number;
  /** Whether this is a "large" document (100+ pages, like EDR reports) */
  isLargeDocument: boolean;
}

export interface SampledPage {
  /** Original page number (1-based) */
  pageNumber: number;
  /** Extracted text for this page */
  text: string;
}

// ── Sampling Strategy ──────────────────────────────────────────────────────────

/** How many pages to sample from large documents */
const LARGE_DOC_THRESHOLD = 100;
const LARGE_DOC_SAMPLE_COUNT = 15; // First 5, last 3, 7 from middle

/**
 * Pick which pages to sample for text extraction.
 * For small documents: all pages.
 * For large documents: first N, last M, and evenly spaced from the middle.
 */
function selectSamplePages(totalPages: number, maxPages: number): number[] {
  if (totalPages <= maxPages) {
    // Small enough to read everything
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages = new Set<number>();

  // Always get the first 5 pages (cover, TOC, intro are classification gold)
  const firstN = Math.min(5, totalPages);
  for (let i = 1; i <= firstN; i++) pages.add(i);

  // Always get the last 3 pages (often have qualifications, closing)
  for (let i = Math.max(1, totalPages - 2); i <= totalPages; i++) pages.add(i);

  // Fill remaining budget from evenly spaced middle pages
  const remaining = maxPages - pages.size;
  if (remaining > 0 && totalPages > 8) {
    const middleStart = 6;
    const middleEnd = totalPages - 3;
    const middleRange = middleEnd - middleStart + 1;

    if (middleRange > 0) {
      const step = Math.max(1, Math.floor(middleRange / remaining));
      for (let i = middleStart; i <= middleEnd && pages.size < maxPages; i += step) {
        pages.add(i);
      }
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

/**
 * Pick which pages to render as images for visual classification.
 * The first few pages are most important (cover, maps, headers).
 */
function selectImagePages(totalPages: number, maxImages: number): number[] {
  if (totalPages <= maxImages) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: number[] = [];

  // First 2 pages (cover / first content)
  for (let i = 1; i <= Math.min(2, totalPages); i++) pages.push(i);

  // One from the middle
  if (totalPages > 4) {
    pages.push(Math.ceil(totalPages / 2));
  }

  return pages.slice(0, maxImages);
}

// ── Skill Implementation ──────────────────────────────────────────────────────

export class PDFReaderSkill extends BaseSkill<PDFReaderInput, PDFReaderOutput> {
  get name(): string {
    return 'PDFReader';
  }

  get usesAI(): boolean {
    return false; // Pure extraction, no AI calls
  }

  protected async execute(input: PDFReaderInput): Promise<PDFReaderOutput> {
    const {
      filePath,
      maxTextPages = this.config.llm.max_pages_for_classification,
      maxImages = this.config.llm.max_images_for_classification,
      dpi = 150,
    } = input;

    // 1. Get total page count (fast, doesn't read content)
    const totalPages = await getPageCount(filePath);
    const isLargeDocument = totalPages >= LARGE_DOC_THRESHOLD;

    this.logger.info(
      { filePath, totalPages, isLargeDocument },
      `Reading PDF: ${totalPages} pages${isLargeDocument ? ' (large document)' : ''}`
    );

    // 2. Determine which pages to sample for text
    const textPageNumbers = selectSamplePages(totalPages, maxTextPages);

    // 3. Extract text — for small docs extract all, for large docs extract sampled pages
    //    pdf-parse can fail on some PDFs (e.g., minimal pdf-lib output), so we
    //    handle that gracefully and fall back to image-only classification.
    let metadata: PDFReaderOutput['metadata'] = {};
    let sampledPages: SampledPage[] = [];

    try {
      let extracted: ExtractedText;

      if (totalPages <= maxTextPages) {
        // Small doc: extract all pages
        extracted = await extractText(filePath, 0);
        sampledPages = extracted.pages.map((text, idx) => ({
          pageNumber: idx + 1,
          text,
        }));
      } else {
        // Large doc: extract up to maxTextPages
        const extractLimit = Math.min(maxTextPages, totalPages);
        extracted = await extractText(filePath, extractLimit);

        sampledPages = extracted.pages.map((text, idx) => ({
          pageNumber: idx + 1,
          text,
        }));

        if (totalPages > extractLimit) {
          this.logger.info(
            { totalPages, extracted: extractLimit },
            `Large document: extracted ${extractLimit}/${totalPages} pages for classification`
          );
        }
      }

      metadata = extracted.metadata;
    } catch (textErr) {
      this.logger.warn(
        { error: (textErr as Error).message },
        'Text extraction failed — classification will rely on images and metadata only'
      );
      // sampledPages stays empty, we'll rely on page images + filename
    }

    // 4. Build combined text (truncated for classification prompt)
    const combinedText = sampledPages
      .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
      .join('\n\n');

    // 5. Extract page images for visual classification
    const imagePageNumbers = input.imagePages && input.imagePages.length > 0
      ? input.imagePages
      : selectImagePages(totalPages, maxImages);

    let pageImages: Buffer[] = [];
    try {
      pageImages = await extractPageImages(filePath, imagePageNumbers, dpi);
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        'Failed to extract page images — classification will rely on text only'
      );
    }

    // 6. Get file size
    const fs = await import('fs/promises');
    const stat = await fs.stat(filePath);

    this.logger.info(
      {
        totalPages,
        sampledPageCount: sampledPages.length,
        imageCount: pageImages.length,
        textLength: combinedText.length,
        fileSizeBytes: stat.size,
      },
      'PDF reading complete'
    );

    return {
      totalPages,
      sampledPages,
      combinedText,
      pageImages,
      imagePageNumbers,
      metadata,
      fileSizeBytes: stat.size,
      isLargeDocument,
    };
  }
}

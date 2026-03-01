/**
 * Evidence Extractor — cheap text extraction for pre-LLM classification.
 *
 * Progressive 3-stage algorithm:
 *   Stage 1: page 1 only (2500 chars) — OCR check + early scorer exit
 *   Stage 2: pages 1–2 (2000 chars/page) — re-run scorer
 *   Stage 3: pages 1–3 (2000 chars/page) — hard cap
 *
 * A scorerFn callback enables early exit when the keyword scorer already
 * has a confident match — no need to read further pages.
 */

import pino from 'pino';
import { extractText } from './pdf-utils.js';

const logger = pino({ name: 'EvidenceExtractor', level: process.env.LOG_LEVEL || 'info' });

export interface EvidencePack {
  /** Total page count of the document (passed in — already known from getPageCount()) */
  pageCount: number;
  /** File size in bytes */
  fileSizeBytes: number;
  /** Sampled page texts */
  sampleTexts: Array<{ pageNumber: number; text: string }>;
  /** PDF metadata title (if present) */
  pdfTitle?: string;
  /** PDF metadata author (if present) */
  pdfAuthor?: string;
  /** Total characters extracted (for metrics) */
  totalChars: number;
  /** How many pages were actually included in sampleTexts */
  pagesRead: number;
  /** True if page 1 has < 80 chars after trim (likely scanned/image PDF) */
  isLikelyScanned: boolean;
}

/**
 * Extract a cheap evidence pack for classification using progressive page reading.
 *
 * @param filePath      Path to the PDF file
 * @param pageCount     Total page count (already known from getPageCount())
 * @param fileSizeBytes File size in bytes
 * @param options       Optional scorer callback for early exit
 */
export async function extractEvidencePack(
  filePath: string,
  pageCount: number,
  fileSizeBytes: number,
  options?: {
    /** Return true to stop early — keyword scorer already has a confident match */
    scorerFn?: (filename: string, pack: EvidencePack) => boolean;
    /** Original filename (for scorerFn) */
    filename?: string;
  }
): Promise<EvidencePack> {
  const filename = options?.filename ?? '';
  const scorerFn = options?.scorerFn;

  // Read up to 3 pages in one pass (single disk read)
  const pagesToRead = Math.min(3, Math.max(pageCount, 1));
  const extracted = await extractText(filePath, pagesToRead);

  const pdfTitle = extracted.metadata.title || undefined;
  const pdfAuthor = extracted.metadata.author || undefined;

  const sampleTexts: Array<{ pageNumber: number; text: string }> = [];

  // ── Stage 1: page 1, cap 2500 chars ────────────────────────────────────────
  const page1Raw = extracted.pages[0] ?? '';
  const page1Text = page1Raw.substring(0, 2500);

  // OCR check: if page 1 has < 80 chars after trimming, mark as likely scanned
  if (page1Text.trim().length < 80) {
    logger.info(
      { filename, stage: 1, pagesRead: 1, chars: page1Text.length },
      '[evidence] stage=1 pagesRead=1 — isLikelyScanned=true'
    );
    if (page1Text.length > 0) {
      sampleTexts.push({ pageNumber: 1, text: page1Text });
    }
    return {
      pageCount,
      fileSizeBytes,
      sampleTexts,
      pdfTitle,
      pdfAuthor,
      totalChars: page1Text.length,
      pagesRead: 1,
      isLikelyScanned: true,
    };
  }

  if (page1Text.length > 0) {
    sampleTexts.push({ pageNumber: 1, text: page1Text });
  }

  // Build stage-1 pack and run scorer
  if (scorerFn) {
    const stage1Pack: EvidencePack = {
      pageCount,
      fileSizeBytes,
      sampleTexts: [...sampleTexts],
      pdfTitle,
      pdfAuthor,
      totalChars: page1Text.length,
      pagesRead: 1,
      isLikelyScanned: false,
    };
    if (scorerFn(filename, stage1Pack)) {
      logger.info(
        { filename, stage: 1, pagesRead: 1, chars: page1Text.length },
        `[evidence] stage=1 pagesRead=1 chars=${page1Text.length} — early exit`
      );
      return stage1Pack;
    }
  }

  // ── Stage 2: add page 2, cap 2000 chars ────────────────────────────────────
  if (extracted.pages.length >= 2) {
    const page2Text = (extracted.pages[1] ?? '').substring(0, 2000);
    if (page2Text.length > 0) {
      sampleTexts.push({ pageNumber: 2, text: page2Text });
    }

    if (scorerFn) {
      const totalChars2 = sampleTexts.reduce((s, p) => s + p.text.length, 0);
      const stage2Pack: EvidencePack = {
        pageCount,
        fileSizeBytes,
        sampleTexts: [...sampleTexts],
        pdfTitle,
        pdfAuthor,
        totalChars: totalChars2,
        pagesRead: 2,
        isLikelyScanned: false,
      };
      if (scorerFn(filename, stage2Pack)) {
        logger.info(
          { filename, stage: 2, pagesRead: 2, chars: totalChars2 },
          `[evidence] stage=2 pagesRead=2 chars=${totalChars2} — early exit`
        );
        return stage2Pack;
      }
    }
  }

  // ── Stage 3: add page 3, cap 2000 chars (only if > 4 pages) ───────────────
  if (extracted.pages.length >= 3 && pageCount > 4) {
    const page3Text = (extracted.pages[2] ?? '').substring(0, 2000);
    if (page3Text.length > 0) {
      sampleTexts.push({ pageNumber: 3, text: page3Text });
    }
  }

  const totalChars = sampleTexts.reduce((s, p) => s + p.text.length, 0);
  const pagesRead = sampleTexts.length;

  logger.info(
    { filename, pagesRead, chars: totalChars },
    `[evidence] pagesRead=${pagesRead} chars=${totalChars} — no early exit`
  );

  return {
    pageCount,
    fileSizeBytes,
    sampleTexts,
    pdfTitle,
    pdfAuthor,
    totalChars,
    pagesRead,
    isLikelyScanned: false,
  };
}

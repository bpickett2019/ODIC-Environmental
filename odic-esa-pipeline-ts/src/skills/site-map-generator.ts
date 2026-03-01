/**
 * Site Location Map Generator Skill
 *
 * Automates the generation of a "Site Location Map" PDF from aerial photographs.
 *
 * Rose's manual process:
 *   1. Open the aerials PDF from the project folder
 *   2. Find the page where the property is marked/highlighted
 *   3. Screenshot/cut that section of the aerial
 *   4. Open a blank 3-page "Site Location Map" template
 *   5. Paste the aerial screenshot into page 3 of the template
 *   6. Result: a Site Location Map PDF with the aerial image showing the property location
 *
 * This skill automates all of that:
 *   1. Renders aerial PDF pages to PNG via pdftoppm
 *   2. Scores each page to find the one with annotations/highlights (property marking)
 *   3. Builds a Site Location Map PDF using pdf-lib:
 *      - Page 1: Title page with "SITE LOCATION MAP" and property address
 *      - Page 2: Full-page aerial image with address label
 *      - (Optional) If a template PDF is provided, embeds the aerial into page 3
 *
 * No AI/LLM dependency — pure image and PDF processing.
 */

import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import pino from 'pino';
import type { AppConfig } from '../types/index.js';
import { BaseSkill } from './base.js';

// ── Public Interfaces ────────────────────────────────────────────────────────

export interface SiteMapInput {
  /** Project directory path (e.g. uploads/{id}/) */
  projectDir: string;
  /** Filename of the aerial photographs PDF within projectDir */
  aerialFile: string;
  /** Optional path to a blank site location map template PDF */
  templatePath?: string;
  /** Property address for labeling */
  propertyAddress?: string;
}

export interface SiteMapOutput {
  /** The generated site location map PDF */
  pdfBuffer: Buffer;
  /** Number of pages in the generated PDF */
  pageCount: number;
  /** Which page of the aerial PDF was selected (1-based), 0 if placeholder */
  sourceAerialPage: number;
  /** Method used to generate the map */
  method: 'aerial_extraction' | 'template_composite' | 'generated';
}

// ── Internal Types ───────────────────────────────────────────────────────────

interface PageScore {
  /** Page number (1-based) */
  pageNumber: number;
  /** Heuristic score — higher means more likely to be the property-marked page */
  score: number;
  /** Path to the rendered PNG image */
  imagePath: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of aerial pages to render and score */
const MAX_PAGES_TO_SCAN = 10;

/** DPI for rendering aerial pages — 200 balances quality and speed */
const RENDER_DPI = 200;

/** Margins in points (0.75 inch) */
const MARGIN = 54;

/** Path to pdftoppm binary */
const PDFTOPPM_PATH = '/opt/homebrew/bin/pdftoppm';

// ── Skill Implementation ─────────────────────────────────────────────────────

export class SiteMapGeneratorSkill extends BaseSkill<SiteMapInput, SiteMapOutput> {
  get name(): string {
    return 'SiteMapGenerator';
  }

  get usesAI(): boolean {
    return false;
  }

  protected async execute(input: SiteMapInput): Promise<SiteMapOutput> {
    const { projectDir, aerialFile, templatePath, propertyAddress } = input;
    const aerialPath = path.resolve(projectDir, aerialFile);
    const address = propertyAddress ?? 'Property Address Not Provided';

    // Validate the aerial PDF exists
    if (!existsSync(aerialPath)) {
      throw new Error(`Aerial PDF not found: ${aerialPath}`);
    }

    this.logger.info({ aerialPath, address }, 'Starting site location map generation');

    // If a template PDF is provided and exists, use template composite method
    if (templatePath && existsSync(templatePath)) {
      return this.buildFromTemplate(aerialPath, templatePath, address);
    }

    // Otherwise, generate the full site location map from scratch
    return this.buildFromScratch(aerialPath, address);
  }

  // ── Build from scratch (no template) ─────────────────────────────────────

  /**
   * Generate a site location map PDF from the aerial images alone.
   * Page 1: Title page with "SITE LOCATION MAP" and property address
   * Page 2: Best aerial image full-page with address label
   */
  private async buildFromScratch(
    aerialPath: string,
    address: string
  ): Promise<SiteMapOutput> {
    // 1. Find the best aerial page
    const bestPage = await this.findBestAerialPage(aerialPath);

    // 2. Read the selected page image
    let imageBuffer: Buffer;
    try {
      imageBuffer = await fs.readFile(bestPage.imagePath);
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        'Failed to read best aerial page image — generating placeholder'
      );
      await this.cleanupRenderedImages(bestPage);
      return this.buildPlaceholder(address);
    }

    // 3. Build the PDF
    try {
      const pdfDoc = await PDFDocument.create();

      // Page 1: Title page
      await this.addTitlePage(pdfDoc, address);

      // Page 2: Aerial image page
      await this.addAerialImagePage(pdfDoc, imageBuffer, address);

      const pdfBuffer = Buffer.from(await pdfDoc.save());

      this.logger.info(
        { sourceAerialPage: bestPage.pageNumber, pageCount: 2, method: 'aerial_extraction' },
        'Site location map generated from aerial extraction'
      );

      return {
        pdfBuffer,
        pageCount: 2,
        sourceAerialPage: bestPage.pageNumber,
        method: 'aerial_extraction',
      };
    } finally {
      await this.cleanupRenderedImages(bestPage);
    }
  }

  // ── Build from template ──────────────────────────────────────────────────

  /**
   * Embed the aerial image into page 3 of a provided template PDF.
   * Preserves all existing template pages, then overlays the aerial image
   * on the last page (or page 3, whichever comes first).
   */
  private async buildFromTemplate(
    aerialPath: string,
    templatePath: string,
    address: string
  ): Promise<SiteMapOutput> {
    // 1. Find the best aerial page
    const bestPage = await this.findBestAerialPage(aerialPath);

    let imageBuffer: Buffer;
    try {
      imageBuffer = await fs.readFile(bestPage.imagePath);
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        'Failed to read aerial image for template composite — generating placeholder'
      );
      await this.cleanupRenderedImages(bestPage);
      return this.buildPlaceholder(address);
    }

    try {
      // 2. Load the template PDF
      const templateBytes = await fs.readFile(templatePath);
      const templateDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
      const templatePageCount = templateDoc.getPageCount();

      // 3. Create a new document and copy all template pages
      const pdfDoc = await PDFDocument.create();
      const templateIndices = Array.from({ length: templatePageCount }, (_, i) => i);
      const copiedPages = await pdfDoc.copyPages(templateDoc, templateIndices);
      for (const page of copiedPages) {
        pdfDoc.addPage(page);
      }

      // 4. Embed the aerial image into the target page (page 3, or last page)
      const targetPageIndex = Math.min(2, pdfDoc.getPageCount() - 1);
      const targetPage = pdfDoc.getPage(targetPageIndex);

      const embeddedImage = await this.embedImageSafe(pdfDoc, imageBuffer);
      if (embeddedImage) {
        const { width: pageWidth, height: pageHeight } = targetPage.getSize();
        const dims = this.fitImageToPage(
          embeddedImage.width,
          embeddedImage.height,
          pageWidth - MARGIN * 2,
          pageHeight - MARGIN * 2 - 40 // Reserve space for label
        );

        const x = (pageWidth - dims.width) / 2;
        const y = MARGIN + 30;

        targetPage.drawImage(embeddedImage, {
          x,
          y,
          width: dims.width,
          height: dims.height,
        });

        // Add address label above the image
        const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const labelFontSize = 10;
        const labelWidth = font.widthOfTextAtSize(address, labelFontSize);
        targetPage.drawText(address, {
          x: (pageWidth - labelWidth) / 2,
          y: y + dims.height + 10,
          size: labelFontSize,
          font,
          color: rgb(0, 0, 0),
        });
      }

      const pdfBuffer = Buffer.from(await pdfDoc.save());
      const pageCount = pdfDoc.getPageCount();

      this.logger.info(
        { sourceAerialPage: bestPage.pageNumber, pageCount, method: 'template_composite' },
        'Site location map generated from template composite'
      );

      return {
        pdfBuffer,
        pageCount,
        sourceAerialPage: bestPage.pageNumber,
        method: 'template_composite',
      };
    } finally {
      await this.cleanupRenderedImages(bestPage);
    }
  }

  // ── Placeholder fallback ─────────────────────────────────────────────────

  /**
   * Generate a placeholder Site Location Map when aerial extraction fails.
   * Produces a 2-page PDF with a title page and a placeholder message page.
   */
  private async buildPlaceholder(address: string): Promise<SiteMapOutput> {
    const pdfDoc = await PDFDocument.create();

    // Page 1: Title page
    await this.addTitlePage(pdfDoc, address);

    // Page 2: Placeholder message
    const page = pdfDoc.addPage(PageSizes.Letter);
    const { width, height } = page.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const placeholderLines: Array<{
      text: string;
      drawFont: typeof font;
      size: number;
      y: number;
    }> = [
      { text: 'SITE LOCATION MAP', drawFont: fontBold, size: 18, y: height - 200 },
      { text: 'Aerial Image Placeholder', drawFont: fontBold, size: 14, y: height - 240 },
      { text: 'The aerial photograph could not be automatically extracted.', drawFont: font, size: 11, y: height - 290 },
      { text: 'Please insert the site aerial image manually.', drawFont: font, size: 11, y: height - 310 },
      { text: address, drawFont: font, size: 10, y: height - 360 },
    ];

    for (const line of placeholderLines) {
      const textWidth = line.drawFont.widthOfTextAtSize(line.text, line.size);
      page.drawText(line.text, {
        x: (width - textWidth) / 2,
        y: line.y,
        size: line.size,
        font: line.drawFont,
        color: rgb(0.3, 0.3, 0.3),
      });
    }

    // Draw a light border rectangle as a visual placeholder for the image
    const boxMargin = 80;
    const boxY = MARGIN + 40;
    const boxHeight = height - 400;
    const boxWidth = width - boxMargin * 2;

    page.drawRectangle({
      x: boxMargin,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      borderColor: rgb(0.7, 0.7, 0.7),
      borderWidth: 1,
      color: rgb(0.97, 0.97, 0.97),
    });

    const pdfBuffer = Buffer.from(await pdfDoc.save());

    this.logger.warn('Generated placeholder site location map — aerial extraction failed');

    return {
      pdfBuffer,
      pageCount: 2,
      sourceAerialPage: 0,
      method: 'generated',
    };
  }

  // ── Aerial Page Selection ────────────────────────────────────────────────

  /**
   * Render the first several pages of the aerial PDF and score them
   * to find the one most likely to contain the property marking.
   *
   * Heuristic scoring:
   * - Property-marked pages have annotation colors (red, yellow, blue highlights)
   *   that stand out against the natural aerial imagery
   * - If sharp is available, we analyze pixel data for saturated color content
   * - If sharp is unavailable, we use file size as a rough proxy (more complex
   *   visual content = larger PNG = more likely to have annotations)
   */
  private async findBestAerialPage(aerialPath: string): Promise<PageScore> {
    const tmpDir = path.join(
      '/tmp',
      `sitemap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    await fs.mkdir(tmpDir, { recursive: true });

    // Determine how many pages to scan
    let totalPages = 1;
    try {
      const pdfBytes = await fs.readFile(aerialPath);
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      totalPages = pdfDoc.getPageCount();
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        'Could not read aerial page count — scanning page 1 only'
      );
    }

    const pagesToScan = Math.min(totalPages, MAX_PAGES_TO_SCAN);
    this.logger.info({ totalPages, pagesToScan }, 'Scanning aerial pages for property marking');

    // Render pages using pdftoppm
    const renderedPages = await this.renderAerialPages(aerialPath, tmpDir, pagesToScan);

    if (renderedPages.length === 0) {
      // Clean up empty tmp dir
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new Error('Failed to render any aerial pages — pdftoppm may not be available');
    }

    // Single page — no scoring needed
    if (renderedPages.length === 1) {
      return { pageNumber: 1, score: 1, imagePath: renderedPages[0] };
    }

    // Score each page and pick the best
    const scores = await this.scorePages(renderedPages);
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];

    this.logger.info(
      { bestPage: best.pageNumber, bestScore: best.score, totalScored: scores.length },
      `Selected aerial page ${best.pageNumber} (score: ${best.score.toFixed(4)})`
    );

    // Clean up non-selected page images (keep the best one for embedding)
    for (const scored of scores) {
      if (scored.imagePath !== best.imagePath) {
        await fs.unlink(scored.imagePath).catch(() => {});
      }
    }

    return best;
  }

  /**
   * Render pages of the aerial PDF to PNG files using pdftoppm.
   * Returns an array of file paths to the rendered PNGs, in page order.
   */
  private async renderAerialPages(
    aerialPath: string,
    outputDir: string,
    pageCount: number
  ): Promise<string[]> {
    const imagePaths: string[] = [];

    try {
      const { execaCommand } = await import('execa');

      await execaCommand(
        `"${PDFTOPPM_PATH}" -png -r ${RENDER_DPI} -f 1 -l ${pageCount} "${aerialPath}" "${outputDir}/aerial"`,
        { timeout: 60000, shell: true }
      );

      // pdftoppm outputs files like aerial-01.png, aerial-02.png, etc.
      const files = await fs.readdir(outputDir);
      const pngFiles = files
        .filter((f) => f.startsWith('aerial-') && f.endsWith('.png'))
        .sort();

      for (const pngFile of pngFiles) {
        imagePaths.push(path.join(outputDir, pngFile));
      }

      this.logger.debug(
        { renderedCount: imagePaths.length },
        'Rendered aerial pages via pdftoppm'
      );
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message },
        'pdftoppm rendering failed'
      );
    }

    return imagePaths;
  }

  /**
   * Score rendered aerial page images to find the property-marked page.
   *
   * Primary strategy (sharp available):
   *   Analyze each image for saturated colored pixels — annotations and
   *   property boundary markings are typically bright red, yellow, or blue,
   *   which stand out against the muted aerial photography.
   *
   * Fallback strategy (sharp unavailable):
   *   Use PNG file size as a proxy — pages with overlaid annotations tend
   *   to produce larger PNGs due to increased visual complexity.
   */
  private async scorePages(imagePaths: string[]): Promise<PageScore[]> {
    const scores: PageScore[] = [];

    // Try sharp-based pixel analysis first
    try {
      const sharp = (await import('sharp')).default;

      for (let i = 0; i < imagePaths.length; i++) {
        const imagePath = imagePaths[i];
        const pageNumber = i + 1;

        try {
          const score = await this.scorePageWithSharp(sharp, imagePath);
          scores.push({ pageNumber, score, imagePath });
        } catch (err) {
          this.logger.debug(
            { pageNumber, error: (err as Error).message },
            'Failed to score page with sharp — assigning default score'
          );
          scores.push({ pageNumber, score: 0, imagePath });
        }
      }

      return scores;
    } catch {
      this.logger.debug('sharp not available — falling back to file size heuristic');
    }

    // Fallback: file size heuristic
    for (let i = 0; i < imagePaths.length; i++) {
      const imagePath = imagePaths[i];
      try {
        const stat = await fs.stat(imagePath);
        scores.push({ pageNumber: i + 1, score: stat.size, imagePath });
      } catch {
        scores.push({ pageNumber: i + 1, score: 0, imagePath });
      }
    }

    return scores;
  }

  /**
   * Score a single page image using sharp pixel analysis.
   *
   * Downsamples the image to 400x400 and walks the raw RGB pixel data
   * looking for saturated colored pixels. Annotation-like colors (red,
   * yellow, blue) receive bonus weighting.
   *
   * Returns a score where higher = more annotation-like colored pixels.
   */
  private async scorePageWithSharp(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sharp: any,
    imagePath: string
  ): Promise<number> {
    const { data, info } = await sharp(imagePath)
      .resize(400, 400, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixelCount = info.width * info.height;
    let weightedSaturatedPixels = 0;

    for (let i = 0; i < data.length; i += 3) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      const lightness = (max + min) / 2;

      // Skip near-black and near-white pixels
      if (lightness < 20 || lightness > 240) continue;

      // Saturation (simplified HSL)
      const saturation =
        delta === 0 ? 0 : delta / (255 - Math.abs(2 * lightness - 255));

      // Count pixels with strong color saturation — likely annotations
      if (saturation > 0.4 && delta > 50) {
        weightedSaturatedPixels += 1;

        // Bonus for typical annotation colors
        // Red highlights (r >> g and r >> b)
        if (r > 180 && r > g * 1.5 && r > b * 1.5) {
          weightedSaturatedPixels += 2;
        }
        // Yellow highlights (r and g high, b low)
        if (r > 180 && g > 150 && b < 100) {
          weightedSaturatedPixels += 2;
        }
        // Blue markers (b >> r and b >> g)
        if (b > 180 && b > r * 1.5 && b > g * 1.3) {
          weightedSaturatedPixels += 1;
        }
      }
    }

    return pixelCount > 0 ? weightedSaturatedPixels / pixelCount : 0;
  }

  // ── PDF Page Construction ────────────────────────────────────────────────

  /**
   * Add a centered title page to the PDF:
   *   "SITE LOCATION MAP"
   *   ─────────────────
   *   [property address]
   *   Phase I Environmental Site Assessment
   */
  private async addTitlePage(pdfDoc: PDFDocument, address: string): Promise<void> {
    const page = pdfDoc.addPage(PageSizes.Letter);
    const { width, height } = page.getSize();

    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Main title
    const titleText = 'SITE LOCATION MAP';
    const titleSize = 28;
    const titleWidth = fontBold.widthOfTextAtSize(titleText, titleSize);
    page.drawText(titleText, {
      x: (width - titleWidth) / 2,
      y: height / 2 + 40,
      size: titleSize,
      font: fontBold,
      color: rgb(0, 0, 0),
    });

    // Decorative line under title
    const lineY = height / 2 + 25;
    page.drawLine({
      start: { x: width * 0.25, y: lineY },
      end: { x: width * 0.75, y: lineY },
      thickness: 1.5,
      color: rgb(0, 0, 0),
    });

    // Property address
    const addressSize = 14;
    const addressWidth = fontRegular.widthOfTextAtSize(address, addressSize);
    page.drawText(address, {
      x: (width - addressWidth) / 2,
      y: height / 2 - 10,
      size: addressSize,
      font: fontRegular,
      color: rgb(0.2, 0.2, 0.2),
    });

    // Subtitle
    const subtitleText = 'Phase I Environmental Site Assessment';
    const subtitleSize = 11;
    const subtitleWidth = fontRegular.widthOfTextAtSize(subtitleText, subtitleSize);
    page.drawText(subtitleText, {
      x: (width - subtitleWidth) / 2,
      y: height / 2 - 35,
      size: subtitleSize,
      font: fontRegular,
      color: rgb(0.4, 0.4, 0.4),
    });
  }

  /**
   * Add a full-page aerial image with address label and sub-label.
   */
  private async addAerialImagePage(
    pdfDoc: PDFDocument,
    imageBuffer: Buffer,
    address: string
  ): Promise<void> {
    const page = pdfDoc.addPage(PageSizes.Letter);
    const { width, height } = page.getSize();

    // Embed the image
    const embeddedImage = await this.embedImageSafe(pdfDoc, imageBuffer);
    if (!embeddedImage) {
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const msg = 'Image could not be embedded';
      const msgWidth = font.widthOfTextAtSize(msg, 14);
      page.drawText(msg, {
        x: (width - msgWidth) / 2,
        y: height / 2,
        size: 14,
        font,
        color: rgb(0.5, 0.5, 0.5),
      });
      return;
    }

    // Layout: label area at top, image fills the rest
    const labelAreaHeight = 40;
    const availableWidth = width - MARGIN * 2;
    const availableHeight = height - MARGIN * 2 - labelAreaHeight;

    const dims = this.fitImageToPage(
      embeddedImage.width,
      embeddedImage.height,
      availableWidth,
      availableHeight
    );

    // Center horizontally, anchor to bottom margin
    const x = (width - dims.width) / 2;
    const y = MARGIN;

    page.drawImage(embeddedImage, {
      x,
      y,
      width: dims.width,
      height: dims.height,
    });

    // Address label above image
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const labelSize = 10;
    const labelWidth = fontBold.widthOfTextAtSize(address, labelSize);
    page.drawText(address, {
      x: (width - labelWidth) / 2,
      y: y + dims.height + 12,
      size: labelSize,
      font: fontBold,
      color: rgb(0, 0, 0),
    });

    // "Site Location Map" sub-label
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const subLabel = 'Site Location Map';
    const subLabelSize = 9;
    const subLabelWidth = fontRegular.widthOfTextAtSize(subLabel, subLabelSize);
    page.drawText(subLabel, {
      x: (width - subLabelWidth) / 2,
      y: y + dims.height + 24,
      size: subLabelSize,
      font: fontRegular,
      color: rgb(0.3, 0.3, 0.3),
    });
  }

  // ── Image Utilities ──────────────────────────────────────────────────────

  /**
   * Safely embed a PNG or JPEG image into a PDF document.
   * Detects format from magic bytes, returns null on failure.
   */
  private async embedImageSafe(
    pdfDoc: PDFDocument,
    imageBuffer: Buffer
  ): Promise<Awaited<ReturnType<PDFDocument['embedPng']>> | null> {
    const isPng =
      imageBuffer[0] === 0x89 &&
      imageBuffer[1] === 0x50 &&
      imageBuffer[2] === 0x4e &&
      imageBuffer[3] === 0x47;

    const isJpeg =
      imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8;

    try {
      if (isPng) return await pdfDoc.embedPng(imageBuffer);
      if (isJpeg) return await pdfDoc.embedJpg(imageBuffer);

      // Unknown format — try PNG then JPEG as last resort
      try {
        return await pdfDoc.embedPng(imageBuffer);
      } catch {
        return await pdfDoc.embedJpg(imageBuffer);
      }
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        'Failed to embed image into PDF'
      );
      return null;
    }
  }

  /**
   * Calculate dimensions to fit an image within a bounding box,
   * preserving aspect ratio. Never upscales beyond original size.
   */
  private fitImageToPage(
    imgWidth: number,
    imgHeight: number,
    maxWidth: number,
    maxHeight: number
  ): { width: number; height: number } {
    const widthRatio = maxWidth / imgWidth;
    const heightRatio = maxHeight / imgHeight;
    const scale = Math.min(widthRatio, heightRatio, 1);

    return {
      width: imgWidth * scale,
      height: imgHeight * scale,
    };
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * Remove temporary rendered image files and their parent directory.
   */
  private async cleanupRenderedImages(bestPage: PageScore): Promise<void> {
    try {
      const parentDir = path.dirname(bestPage.imagePath);
      if (parentDir.startsWith('/tmp/sitemap-')) {
        await fs.rm(parentDir, { recursive: true, force: true });
      } else {
        await fs.unlink(bestPage.imagePath).catch(() => {});
      }
    } catch {
      // Non-critical — temp files will be cleaned up by OS eventually
    }
  }
}

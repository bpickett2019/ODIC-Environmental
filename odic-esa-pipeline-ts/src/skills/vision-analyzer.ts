/**
 * Vision Analyzer Skill — Uses Claude Vision to analyze aerial photographs
 * and site photos, producing observations for ESA report narrative sections.
 *
 * Supports three analysis modes:
 * - aerial_historical: Land use changes over time, environmental concerns
 * - site_reconnaissance: Current property condition, hazmat evidence
 * - general: Generic document/image description
 *
 * Images are downscaled via sharp before sending to control token costs.
 */

import type { AppConfig } from '../types/index.js';
import { BaseSkill } from './base.js';
import { LLMClient } from '../core/llm-client.js';

// ── Input / Output types ──────────────────────────────────────────────────────

export interface VisionAnalysisInput {
  images: Array<{
    buffer: Buffer;
    mediaType: 'image/png' | 'image/jpeg';
    label: string;
    documentType: string;
  }>;
  analysisType: 'aerial_historical' | 'site_reconnaissance' | 'general';
  projectContext: {
    propertyAddress: string;
    reportType: string;
  };
}

export interface VisionAnalysisOutput {
  analyses: Array<{
    label: string;
    observations: string;
    features: string[];
    concerns: string[];
    landUse: string;
  }>;
  synthesizedNarrative: string;
  totalCostUsd: number;
}

// ── System prompts by analysis type ─────────────────────────────────────────

const SYSTEM_PROMPTS: Record<string, string> = {
  aerial_historical: `You are an environmental site assessment expert analyzing historical aerial photographs for a Phase I ESA report (ASTM E1527-21).

Examine this aerial photograph carefully and provide a structured analysis. Focus on:
- Visible land use (residential, commercial, industrial, agricultural, vacant)
- Structures and buildings visible on or adjacent to the property
- Environmental concerns: storage tanks, drums, staining/discoloration, waste areas, lagoons/ponds
- Surrounding land uses and potential off-site sources
- Water features, drainage patterns, or wetlands
- Roads, railroads, or other transportation features
- Evidence of fill, grading, or earthwork
- Any changes from natural conditions

Respond in this exact format:
OBSERVATIONS: [2-4 sentences describing what you see]
FEATURES: [comma-separated list of notable features]
CONCERNS: [comma-separated list of environmental concerns, or "None observed"]
LAND_USE: [single phrase describing primary land use]`,

  site_reconnaissance: `You are an environmental site assessment expert analyzing site photographs for a Phase I ESA report (ASTM E1527-21).

Examine this site photograph carefully and provide a structured analysis. Focus on:
- Current property condition and maintenance
- Evidence of hazardous substances or petroleum products (staining, discoloration, stressed vegetation)
- Underground storage tanks (USTs): fill ports, vent pipes, dispensers
- Aboveground storage tanks (ASTs) or drum storage areas
- Potential asbestos-containing materials (old insulation, floor tiles, roofing)
- Potential lead-based paint (peeling paint on older structures)
- PCB-containing equipment (older transformers, capacitors)
- Drainage features, floor drains, sumps, or discharge points
- Chemical storage areas, waste accumulation areas
- General property condition indicators

Respond in this exact format:
OBSERVATIONS: [2-4 sentences describing what you see]
FEATURES: [comma-separated list of notable features]
CONCERNS: [comma-separated list of environmental concerns, or "None observed"]
LAND_USE: [single phrase describing current property use/condition]`,

  general: `You are a document analysis expert. Describe the contents of this image in detail, noting any environmental or property-related information visible.

Respond in this exact format:
OBSERVATIONS: [2-4 sentences describing what you see]
FEATURES: [comma-separated list of notable features]
CONCERNS: [comma-separated list of any concerns, or "None observed"]
LAND_USE: [single phrase describing what is shown, or "N/A"]`,
};

// ── Skill implementation ────────────────────────────────────────────────────

export class VisionAnalyzerSkill extends BaseSkill<VisionAnalysisInput, VisionAnalysisOutput> {
  private llm: LLMClient;

  constructor(config: AppConfig, llm: LLMClient) {
    super(config);
    this.llm = llm;
  }

  get name(): string {
    return 'VisionAnalyzer';
  }

  get usesAI(): boolean {
    return true;
  }

  protected async execute(input: VisionAnalysisInput): Promise<VisionAnalysisOutput> {
    const { images, analysisType, projectContext } = input;
    // Higher resolution for site reconnaissance (tank labels, valve markings need detail)
    const defaultWidth = analysisType === 'site_reconnaissance' ? 1536 : 1280;
    const maxWidth = this.config.research?.vision_image_max_width ?? defaultWidth;

    const analyses: VisionAnalysisOutput['analyses'] = [];
    let totalCostUsd = 0;

    // Analyze images in parallel (up to 4 concurrent — Sonnet is expensive but parallel is safe)
    const pLimitMod = await import('p-limit');
    const limit = pLimitMod.default(4);

    const imageResults = await Promise.allSettled(
      images.map(image => limit(async () => {
        this.logger.info({ label: image.label, analysisType }, 'Analyzing image');
        const downscaled = await this.downscaleImage(image.buffer, maxWidth);
        const systemPrompt = SYSTEM_PROMPTS[analysisType] || SYSTEM_PROMPTS.general;
        const textPrompt = `Analyze this image: "${image.label}" for the property at ${projectContext.propertyAddress} (${projectContext.reportType}).`;
        const response = await this.llm.analyzeImage(systemPrompt, textPrompt, [downscaled], image.mediaType);
        return { analysis: this.parseVisionResponse(response.rawText, image.label), costUsd: response.costUsd };
      }))
    );

    for (const result of imageResults) {
      if (result.status === 'fulfilled') {
        analyses.push(result.value.analysis);
        totalCostUsd += result.value.costUsd;
      }
    }

    // Synthesize all observations into a combined narrative
    const synthesizedNarrative = await this.synthesizeNarrative(
      analyses,
      analysisType,
      projectContext
    );
    totalCostUsd += synthesizedNarrative.costUsd;

    return {
      analyses,
      synthesizedNarrative: synthesizedNarrative.text,
      totalCostUsd,
    };
  }

  /**
   * Downscale an image buffer to max width using sharp.
   */
  private async downscaleImage(buffer: Buffer, maxWidth: number): Promise<Buffer> {
    try {
      const sharpModule = await import('sharp');
      const sharp = sharpModule.default ?? sharpModule;
      const metadata = await sharp(buffer).metadata();
      if (metadata.width && metadata.width > maxWidth) {
        return await sharp(buffer)
          .resize({ width: maxWidth, withoutEnlargement: true })
          .png()
          .toBuffer();
      }
      return buffer;
    } catch (err) {
      this.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Sharp resize failed, using original image'
      );
      return buffer;
    }
  }

  /**
   * Parse the structured vision response into typed fields.
   */
  private parseVisionResponse(
    rawText: string,
    label: string
  ): VisionAnalysisOutput['analyses'][number] {
    const observations = this.extractField(rawText, 'OBSERVATIONS') || rawText.trim();
    const featuresRaw = this.extractField(rawText, 'FEATURES') || '';
    const concernsRaw = this.extractField(rawText, 'CONCERNS') || '';
    const landUse = this.extractField(rawText, 'LAND_USE') || 'Unknown';

    const features = featuresRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const concerns = concernsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s.toLowerCase() !== 'none observed' && s.toLowerCase() !== 'none');

    return { label, observations, features, concerns, landUse };
  }

  /**
   * Extract a labeled field from the structured response.
   */
  private extractField(text: string, field: string): string | null {
    const regex = new RegExp(`${field}:\\s*(.+?)(?=\\n[A-Z_]+:|$)`, 's');
    const match = text.match(regex);
    return match ? match[1].trim() : null;
  }

  /**
   * Synthesize all individual analyses into a combined narrative paragraph.
   */
  private async synthesizeNarrative(
    analyses: VisionAnalysisOutput['analyses'],
    analysisType: string,
    projectContext: { propertyAddress: string; reportType: string }
  ): Promise<{ text: string; costUsd: number }> {
    if (analyses.length === 0) {
      return { text: 'No images were available for analysis.', costUsd: 0 };
    }

    const observationsSummary = analyses
      .map((a) => `- ${a.label}: ${a.observations}`)
      .join('\n');

    const allConcerns = analyses.flatMap((a) => a.concerns).filter(Boolean);
    const uniqueConcerns = Array.from(new Set(allConcerns));

    const sectionName =
      analysisType === 'aerial_historical'
        ? 'Historical Aerial Photograph Review'
        : analysisType === 'site_reconnaissance'
          ? 'Site Reconnaissance'
          : 'Visual Analysis';

    const systemPrompt = `You are a senior environmental consultant writing the "${sectionName}" section of a Phase I ESA report (ASTM E1527-21) for the property at ${projectContext.propertyAddress}.

Write a professional narrative paragraph (or two) suitable for inclusion in the report. Use past tense for historical observations and present tense for current conditions. Do not use bullet points — write flowing prose. Reference specific images/years when relevant.`;

    const userMessage = `Based on the following image analyses, write the narrative for the "${sectionName}" section:

${observationsSummary}

${uniqueConcerns.length > 0 ? `Environmental concerns noted: ${uniqueConcerns.join('; ')}` : 'No environmental concerns were identified.'}`;

    const response = await this.llm.generateText(systemPrompt, userMessage);

    return { text: response.data, costUsd: response.costUsd };
  }
}

/**
 * REC Detector Skill — AI-powered Recognized Environmental Condition detection.
 *
 * Analyzes all project documents to identify RECs, CRECs, HRECs, and
 * de minimis conditions per ASTM E1527-21 standards.
 *
 * Uses the reasoning model (Sonnet) to cross-reference EDR listings,
 * agency records, historical land use, and site observations to produce
 * a comprehensive list of environmental findings with classifications,
 * citations, and narrative text ready for report injection.
 */

import type { AppConfig } from '../types/index.js';
import { BaseSkill } from './base.js';
import { LLMClient, type LLMResponse } from '../core/llm-client.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type RECClassification = 'REC' | 'CREC' | 'HREC' | 'de_minimis';

export interface DetectedREC {
  id: string;
  classification: RECClassification;
  title: string;
  description: string;
  location: string;
  sourceDocuments: string[];
  citations: string[];
  regulatoryListings: string[];
  severity: 'high' | 'medium' | 'low';
  searchRadius: string;
  recommendation: string;
  confidence: number;
}

export interface RECDetectorInput {
  projectDir: string;
  files: Array<{
    filename: string;
    documentType: string;
    label: string;
    section: string;
  }>;
  projectContext: {
    propertyAddress: string;
    clientName: string;
    reportType: string;
  };
  extractedTexts: Record<string, string>;
  visionObservations?: string;
}

export interface RECDetectorOutput {
  recs: DetectedREC[];
  summary: {
    totalRECs: number;
    totalCRECs: number;
    totalHRECs: number;
    totalDeMinimis: number;
    overallRiskLevel: 'high' | 'moderate' | 'low';
  };
  executiveSummaryText: string;
  findingsText: string;
  totalCostUsd: number;
}

/** Shape of the JSON we ask the AI to return */
interface AIRECAnalysisResponse {
  findings: Array<{
    classification: RECClassification;
    title: string;
    description: string;
    location: string;
    source_documents: string[];
    citations: string[];
    regulatory_listings: string[];
    severity: 'high' | 'medium' | 'low';
    search_radius: string;
    recommendation: string;
    confidence: number;
  }>;
  executive_summary: string;
  findings_narrative: string;
}

// ── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are an expert environmental consultant performing a Recognized Environmental Condition (REC) analysis for a Phase I Environmental Site Assessment (ESA) per ASTM E1527-21.

## ASTM E1527-21 Definitions

**REC (Recognized Environmental Condition):**
The presence or likely presence of any hazardous substances or petroleum products in, on, or at a property: (1) due to a release to the environment; (2) under conditions indicative of a release to the environment; or (3) under conditions that pose a material threat of a future release to the environment. De minimis conditions are NOT RECs.

**CREC (Controlled Recognized Environmental Condition):**
A recognized environmental condition resulting from a past release of hazardous substances or petroleum products that has been addressed to the satisfaction of the applicable regulatory authority with hazardous substances or petroleum products allowed to remain in place subject to the implementation of required controls (e.g., property use restrictions, activity and use limitations, institutional controls, or engineering controls).

**HREC (Historical Recognized Environmental Condition):**
A past release of any hazardous substances or petroleum products that has occurred in connection with the property and has been addressed to the satisfaction of the applicable regulatory authority or meeting unrestricted use criteria established by a regulatory authority, WITHOUT subjecting the property to any required controls.

**De Minimis Condition:**
A condition that generally does not present a threat to human health or the environment and that generally would not be the subject of an enforcement action if brought to the attention of appropriate governmental agencies. Conditions determined to be de minimis are not RECs.

## ASTM E1527-21 Standard Search Radii

When evaluating EDR database listings, apply these standard search distances:
- **NPL (Superfund):** 1.0 mile
- **RCRA CORRACTS / TSD:** 1.0 mile
- **State Equivalent NPL:** 1.0 mile
- **RCRA Generators (LQG/SQG/CESQG):** Subject property and adjoining only
- **LUST / UST:** 0.5 miles
- **ERNS / SPILLS:** Subject property only
- **State Sites / VCP / Brownfield:** 0.5 miles
- **Tribal Sites:** 1.0 mile

## Analysis Instructions

1. **Cross-reference EDR database listings** with the ASTM search radii above. Flag any listed sites within the applicable radius that could impact the subject property.

2. **Check agency records** for cleanup status. If a site has received regulatory closure with no controls, it may be an HREC. If controls remain in place, it is a CREC.

3. **Assess historical land use** from aerial photographs, Sanborn maps, city directories, and other historical records. Look for former gas stations, dry cleaners, auto repair shops, industrial facilities, agricultural use, or other potentially contaminating activities.

4. **Distinguish subject property vs. adjacent property concerns.** Specify the location clearly (e.g., "Subject Property", "Adjacent - 123 Main St to the north", "0.25 miles southwest").

5. **Note data gaps** where investigation was limited (e.g., inaccessible areas, missing historical records, unresponsive agencies).

6. **Be conservative** — flag potential RECs even if uncertain. It is better to over-report than to miss a genuine environmental concern.

7. **For each finding, cite specific source documents** by filename and relevant content.

8. **Vision observations** from site photographs should be evaluated for visible evidence of contamination (staining, distressed vegetation, abandoned drums, vent pipes, monitoring wells, etc.).

## Response Format

Return a JSON object with this EXACT structure:
\`\`\`json
{
  "findings": [
    {
      "classification": "REC",
      "title": "Former Dry Cleaner - PCE Contamination",
      "description": "The adjacent property at 123 Main St operated as a dry cleaning facility from 1965-2002 per historical aerial photographs and city directory listings. The EDR report identifies this site on the LUST database with an open case status involving tetrachloroethylene (PCE) contamination in soil and groundwater.",
      "location": "Adjacent - 123 Main St (north)",
      "source_documents": ["edr_report.pdf", "aerial_photos_1970.pdf"],
      "citations": ["EDR Report p.42 - LUST listing #CA12345", "1970 aerial showing dry cleaner signage"],
      "regulatory_listings": ["LUST - Case #CA12345 (Open)", "DTSC EnviroStor - 60001234"],
      "severity": "high",
      "search_radius": "0.25 miles",
      "recommendation": "Phase II ESA recommended to evaluate potential migration of PCE contamination to the subject property via groundwater.",
      "confidence": 0.92
    }
  ],
  "executive_summary": "A paragraph summarizing all findings suitable for the Executive Summary section of the ESA report...",
  "findings_narrative": "A detailed narrative suitable for the Findings and Opinions section of the ESA report..."
}
\`\`\`

If NO RECs, CRECs, HRECs, or de minimis conditions are identified, return an empty findings array and write the executive_summary and findings_narrative accordingly (stating no RECs were identified).

Return ONLY the JSON object, no other text.`;
}

function buildUserMessage(input: RECDetectorInput): string {
  const parts: string[] = [];

  parts.push(`## Property Information`);
  parts.push(`- Address: ${input.projectContext.propertyAddress}`);
  parts.push(`- Client: ${input.projectContext.clientName}`);
  parts.push(`- Report Type: ${input.projectContext.reportType}`);
  parts.push('');

  // Add each document's extracted text with clear labels
  for (const file of input.files) {
    const text = input.extractedTexts[file.filename];
    if (!text) continue;

    parts.push(`=== ${file.label} (${file.filename}) ===`);
    parts.push(`Document Type: ${file.documentType} | Section: ${file.section}`);
    parts.push(text);
    parts.push('');
  }

  // Add vision observations if present
  if (input.visionObservations) {
    parts.push(`=== Vision Observations (Site Visit Photos) ===`);
    parts.push(input.visionObservations);
    parts.push('');
  }

  return parts.join('\n');
}

// ── Skill Implementation ─────────────────────────────────────────────────────

export class RECDetectorSkill extends BaseSkill<RECDetectorInput, RECDetectorOutput> {
  private llm: LLMClient;

  constructor(config: AppConfig, llm: LLMClient) {
    super(config);
    this.llm = llm;
  }

  get name(): string {
    return 'RECDetector';
  }

  get usesAI(): boolean {
    return true;
  }

  protected async execute(input: RECDetectorInput): Promise<RECDetectorOutput> {
    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(input);

    this.logger.info(
      { propertyAddress: input.projectContext.propertyAddress, fileCount: input.files.length },
      'Starting REC analysis'
    );

    // Primary AI call — ask for structured JSON analysis
    const analysisResponse = await this.llm.reason<AIRECAnalysisResponse>(
      systemPrompt,
      userMessage,
      true
    );

    let totalCostUsd = analysisResponse.costUsd;

    // Resilient parsing — handle variant field names from AI response
    const aiData = analysisResponse.data as any;
    const rawFindings: any[] = aiData.findings || aiData.rec_findings || aiData.recs || aiData.results || [];

    // Assign sequential IDs and map from AI response to our typed output
    const recs: DetectedREC[] = rawFindings.map((f: any, idx: number) => ({
      id: `REC-${String(idx + 1).padStart(3, '0')}`,
      classification: f.classification || f.type || 'REC',
      title: f.title || f.name || 'Untitled Finding',
      description: f.description || f.summary || '',
      location: f.location || f.address || '',
      sourceDocuments: f.source_documents || f.sourceDocuments || f.sources || [],
      citations: f.citations || f.references || [],
      regulatoryListings: f.regulatory_listings || f.regulatoryListings || f.listings || [],
      severity: f.severity || f.risk_level || 'medium',
      searchRadius: f.search_radius || f.searchRadius || '',
      recommendation: f.recommendation || f.action || '',
      confidence: f.confidence ?? 0.5,
    }));

    // Compute summary counts
    const totalRECs = recs.filter(r => r.classification === 'REC').length;
    const totalCRECs = recs.filter(r => r.classification === 'CREC').length;
    const totalHRECs = recs.filter(r => r.classification === 'HREC').length;
    const totalDeMinimis = recs.filter(r => r.classification === 'de_minimis').length;

    const overallRiskLevel: 'high' | 'moderate' | 'low' =
      totalRECs > 0 || recs.some(r => r.severity === 'high')
        ? 'high'
        : totalCRECs > 0 || recs.some(r => r.severity === 'medium')
          ? 'moderate'
          : 'low';

    // Get narrative texts from the AI response (resilient to variant field names)
    let executiveSummaryText = aiData.executive_summary || aiData.executiveSummary || aiData.summary_text || '';
    let findingsText = aiData.findings_narrative || aiData.findingsNarrative || aiData.findings_text || aiData.opinions || '';

    // If narratives are too short or missing, make a follow-up call to generate them
    const needsBetterNarratives =
      executiveSummaryText.length < 100 || findingsText.length < 100;

    if (needsBetterNarratives && recs.length > 0) {
      this.logger.info('Generating improved narrative text for report sections');

      const narrativeResponse = await this.llm.generateText(
        `You are an environmental consultant writing sections of a Phase I Environmental Site Assessment report per ASTM E1527-21. Write in a professional, technical tone. Be thorough but concise.`,
        `Based on the following REC findings for the property at ${input.projectContext.propertyAddress}, write two sections:

## SECTION 1: Executive Summary Paragraph
Write 1-2 paragraphs summarizing the environmental findings for the Executive Summary. State how many RECs, CRECs, HRECs, and de minimis conditions were identified. Briefly describe the most significant findings.

## SECTION 2: Findings and Opinions
Write the detailed Findings and Opinions section. For each finding, describe the condition, its basis, the applicable classification (REC/CREC/HREC/de minimis), and any recommendations. Number each finding.

## Findings Data:
${JSON.stringify(recs, null, 2)}

Format your response as:
EXECUTIVE_SUMMARY:
[your executive summary text]

FINDINGS_AND_OPINIONS:
[your findings and opinions text]`
      );

      totalCostUsd += narrativeResponse.costUsd;

      // Parse the two sections from the response
      const raw = narrativeResponse.data;
      const execMatch = raw.match(/EXECUTIVE_SUMMARY:\s*([\s\S]*?)(?=FINDINGS_AND_OPINIONS:|$)/);
      const findingsMatch = raw.match(/FINDINGS_AND_OPINIONS:\s*([\s\S]*?)$/);

      if (execMatch && execMatch[1].trim().length > 50) {
        executiveSummaryText = execMatch[1].trim();
      }
      if (findingsMatch && findingsMatch[1].trim().length > 50) {
        findingsText = findingsMatch[1].trim();
      }
    }

    this.logger.info(
      {
        totalFindings: recs.length,
        totalRECs,
        totalCRECs,
        totalHRECs,
        totalDeMinimis,
        overallRiskLevel,
        costUsd: totalCostUsd.toFixed(4),
      },
      `REC analysis complete: ${recs.length} findings identified`
    );

    return {
      recs,
      summary: {
        totalRECs,
        totalCRECs,
        totalHRECs,
        totalDeMinimis,
        overallRiskLevel,
      },
      executiveSummaryText,
      findingsText,
      totalCostUsd,
    };
  }
}

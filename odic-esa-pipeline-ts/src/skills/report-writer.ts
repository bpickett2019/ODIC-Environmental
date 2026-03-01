/**
 * Report Writer Skill — AI-powered narrative section generation for Phase I ESAs.
 *
 * Uses a multi-pass approach to generate professional report narratives:
 *   Pass 1: Extract key facts from all classified documents (Haiku for speed)
 *   Pass 2: Write each section using Sonnet with extracted facts + north star style
 *   Pass 3: Generate executive summary from all completed sections (Sonnet)
 *
 * Each generated section is rendered to a PDF page buffer using pdf-lib.
 *
 * The AI is instructed to:
 * - Write in ODIC Environmental's professional style
 * - Follow ASTM E1527-21 terminology and structure
 * - Reference specific document findings (EDR results, historical records, etc.)
 * - Maintain consistency with the north star template
 * - Flag data gaps or missing information
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { AppConfig, ClassifiedDocument, ReportType } from '../types/index.js';
import { REPORT_TYPE_LABELS } from '../types/documents.js';
import { BaseSkill } from './base.js';
import { LLMClient, type LLMResponse } from '../core/llm-client.js';

// ── Input / Output types ──────────────────────────────────────────────────────

export interface ReportWriterInput {
  projectContext: {
    projectId: string;
    projectName: string;
    clientName: string;
    propertyAddress: string;
    reportType: ReportType;
    isSbaLoan: boolean;
    reportDate: string;
    epName: string; // Environmental Professional
  };
  classifiedDocuments: ClassifiedDocument[];
  extractedTexts: Map<string, string>; // filename -> extracted text
  northStarTemplate: any; // loaded from YAML
}

export interface ReportWriterOutput {
  sections: GeneratedSection[];
  totalTokensUsed: { input: number; output: number };
  totalCostUsd: number;
  warnings: string[];
}

export interface GeneratedSection {
  sectionId: string;
  sectionNumber: string;
  title: string;
  content: string; // markdown/text content
  pdfBuffer: Buffer; // rendered PDF
  pageCount: number;
  tokensUsed: { input: number; output: number };
}

// ── Internal types ──────────────────────────────────────────────────────────────

/** Structured facts extracted from documents in Pass 1 */
interface ExtractedFacts {
  /** Facts grouped by document type */
  byDocumentType: Record<string, DocumentFacts>;
  /** Overall project facts distilled across all documents */
  projectFacts: ProjectFacts;
}

interface DocumentFacts {
  documentType: string;
  filename: string;
  keyFindings: string[];
  dates: string[];
  addresses: string[];
  chemicals: string[];
  regulatoryListings: string[];
  dataGaps: string[];
}

interface ProjectFacts {
  propertyDescription: string;
  currentUse: string;
  historicalUses: string[];
  adjacentProperties: string[];
  edrFindings: string[];
  historicalFindings: string[];
  agencyFindings: string[];
  recognizedEnvironmentalConditions: string[];
  dataGaps: string[];
}

/** What we ask Haiku to return for fact extraction */
interface AIFactExtractionResponse {
  key_findings: string[];
  dates: string[];
  addresses: string[];
  chemicals_or_substances: string[];
  regulatory_listings: string[];
  data_gaps: string[];
}

/** What we ask Haiku to return for the project-level summary */
interface AIProjectFactsResponse {
  property_description: string;
  current_use: string;
  historical_uses: string[];
  adjacent_properties: string[];
  edr_findings: string[];
  historical_findings: string[];
  agency_findings: string[];
  recognized_environmental_conditions: string[];
  data_gaps: string[];
}

// ── Section Definitions ──────────────────────────────────────────────────────────

interface SectionDefinition {
  sectionId: string;
  sectionNumber: string;
  title: string;
  /** Which document types are relevant to this section */
  relevantDocTypes: string[];
  /** Prompt instructions specific to this section */
  writingInstructions: string;
}

/** All narrative sections to generate, in report order */
const SECTION_DEFINITIONS: SectionDefinition[] = [
  {
    sectionId: 'body_introduction',
    sectionNumber: '1.0',
    title: 'Introduction',
    relevantDocTypes: ['transmittal_letter', 'client_correspondence', 'report_body'],
    writingInstructions: `Write the Introduction section (1.0) for this Phase I ESA.

This section must include:
- Purpose of the Phase I ESA (in accordance with ASTM E1527-21)
- Scope of services performed
- Identity of the client and the user (as defined by ASTM)
- Property identification (address, legal description if available)
- Statement of limitations and exceptions
- If this is an SBA loan, reference the applicable SBA SOP requirements

The introduction should be concise and factual. Reference the specific ASTM standard practice.`,
  },
  {
    sectionId: 'body_property_description',
    sectionNumber: '2.0',
    title: 'Property Description',
    relevantDocTypes: [
      'location_map', 'plot_plan', 'tax_record', 'title_record',
      'site_photograph', 'report_body',
    ],
    writingInstructions: `Write the Property Description section (2.0) for this Phase I ESA.

This section must include:
- Property location and legal description
- Current improvements (buildings, structures, parking areas)
- Property size (acreage or square footage)
- Current use of the property
- General topography and drainage
- Surrounding land uses (north, south, east, west)
- Utilities serving the property
- Reference specific figures (Figure 1 - Location Map, Figure 2 - Plot Plan) as applicable

Use specific factual details from the extracted documents. If information is not available, explicitly note the data gap.`,
  },
  {
    sectionId: 'body_property_reconnaissance',
    sectionNumber: '3.0',
    title: 'Property Reconnaissance',
    relevantDocTypes: ['site_photograph', 'report_body'],
    writingInstructions: `Write the Property Reconnaissance section (3.0) for this Phase I ESA.

This section documents the site visit observations. Include:
- Date and conditions of the site visit
- Name of the environmental professional who conducted the visit
- General property condition observations
- Interior observations (if applicable)
- Exterior observations
- Evidence of hazardous substances or petroleum products
- Evidence of underground storage tanks (USTs) or aboveground storage tanks (ASTs)
- Evidence of PCBs, lead-based paint, asbestos
- Evidence of drains, sumps, or pits
- Potable water supply and wastewater disposal
- Any physical limitations to the site visit

Reference specific photographs from Appendix B where applicable.
If the site visit has not been documented, note this as a significant data gap.`,
  },
  {
    sectionId: 'body_property_history',
    sectionNumber: '4.0',
    title: 'Property and Vicinity History',
    relevantDocTypes: [
      'sanborn_map', 'aerial_photograph', 'topographic_map',
      'city_directory', 'fire_insurance_map', 'title_record',
      'tax_record', 'report_body',
    ],
    writingInstructions: `Write the Property and Vicinity History section (4.0) for this Phase I ESA.

This section must include:
- Historical use of the property based on available records
- Title/ownership history (if available)
- Historical use of surrounding properties
- Summary of historical sources reviewed:
  * Sanborn fire insurance maps (with dates reviewed)
  * Aerial photographs (with dates reviewed)
  * Topographic maps (with dates reviewed)
  * City directories (with dates reviewed)
  * Other historical sources

For each historical source, describe what it shows about the property and vicinity
at each point in time. Organize chronologically where possible.

If any standard historical sources were not available, note the gap.
Reference Appendix D for the complete historical documentation.`,
  },
  {
    sectionId: 'body_records_research',
    sectionNumber: '5.0',
    title: 'Standard Environmental Records Research',
    relevantDocTypes: [
      'edr_report', 'agency_records', 'regulatory_correspondence',
      'report_body',
    ],
    writingInstructions: `Write the Standard Environmental Records Research section (5.0) for this Phase I ESA.

This section summarizes the regulatory database search results (EDR Radius Map Report)
and any agency records. Include:

- Summary of the EDR database search methodology
- Federal database findings (NPL, CERCLIS, RCRA, ERNS, etc.)
- State database findings (state equivalent lists)
- Tribal database findings (if applicable)
- Local database findings
- Summary of listings found within ASTM-specified search distances
- For each significant listing: name, address, distance/direction, database(s),
  status, and whether it represents a potential concern
- Orphan site summary (sites that could not be mapped)
- Vapor encroachment screening (if applicable)

Reference Appendix C for the complete EDR report.
If no EDR report was provided, flag this as a critical data gap.`,
  },
  {
    sectionId: 'body_user_information',
    sectionNumber: '6.0',
    title: 'User Provided Information',
    relevantDocTypes: [
      'client_correspondence', 'prior_environmental_report',
      'building_permit', 'report_body',
    ],
    writingInstructions: `Write the User Provided Information section (6.0) for this Phase I ESA.

Per ASTM E1527-21, the "user" must provide certain information. This section documents:
- Whether the user completed an Environmental Questionnaire
- Reason for performing the Phase I ESA (transaction, refinancing, SBA loan, etc.)
- Any specialized knowledge of the user regarding the property
- Any environmental liens or activity and use limitations (AULs)
- Previous environmental reports known to the user
- Any commonly known or reasonably ascertainable information
- Property valuation relative to comparable uncontaminated property

If user information was not provided, note this as a data gap per ASTM requirements.`,
  },
  {
    sectionId: 'body_references',
    sectionNumber: '7.0',
    title: 'References',
    relevantDocTypes: [],
    writingInstructions: `Write the References section (7.0) for this Phase I ESA.

List all references cited in the report. Standard references include:
- ASTM E1527-21, Standard Practice for Environmental Site Assessments: Phase I
  Environmental Site Assessment Process
- EDR Radius Map Report (with date and report number)
- Historical sources reviewed (Sanborn maps, aerials, city directories, etc.)
- Agency records and correspondence
- Prior environmental reports (if any)
- Any other documents referenced in the report body

Format as a numbered or bulleted reference list.`,
  },
  {
    sectionId: 'body_findings_recommendations',
    sectionNumber: 'Conclusions',
    title: 'Findings and Recommendations / Conclusions',
    relevantDocTypes: [],
    writingInstructions: `Write the Findings and Recommendations / Conclusions section for this Phase I ESA.

This section must include:
- Summary of all identified recognized environmental conditions (RECs)
- Summary of all identified controlled recognized environmental conditions (CRECs)
- Summary of all identified historical recognized environmental conditions (HRECs)
- De minimis conditions (if any)
- Business environmental risks (if contracted)
- Data gaps identified during the assessment
- Recommendations for further investigation (if any)
- Professional opinion of the Environmental Professional

Use ASTM E1527-21 terminology precisely:
- REC: "the presence or likely presence of any hazardous substances or petroleum
  products in, on, or at a property..."
- CREC: "a recognized environmental condition resulting from a past release...
  that has been addressed to the satisfaction of the applicable regulatory authority..."
- HREC: "a past release... that has been addressed to the satisfaction of the
  applicable regulatory authority... and where no controls or restrictions remain..."

Be specific about each finding. Reference the section of the report where
each finding is discussed in detail.`,
  },
];

/** Executive Summary is generated last (Pass 3) since it summarizes everything */
const EXECUTIVE_SUMMARY_DEFINITION: SectionDefinition = {
  sectionId: 'body_executive_summary',
  sectionNumber: 'ES',
  title: 'Executive Summary / Findings & Recommendations',
  relevantDocTypes: [],
  writingInstructions: `Write the Executive Summary for this Phase I ESA.

The Executive Summary appears at the front of the report and provides a concise
overview for decision-makers. It must include:

- Property identification (address, size, current use)
- Purpose and scope of the Phase I ESA
- Summary of findings from each major section
- All identified RECs, CRECs, and HRECs
- Data gaps, if any
- Overall conclusion and recommendations

The executive summary should be 1-2 pages maximum. Write for a reader who may not
read the full report — a loan officer, investor, or attorney who needs to quickly
understand the environmental status of the property.

Be direct and clear. Lead with the most important findings.`,
};

// ── System Prompts ───────────────────────────────────────────────────────────────

function buildFactExtractionSystemPrompt(): string {
  return `You are a document analyst for ODIC Environmental, an environmental consulting firm.

Your task is to extract key facts from documents that will be used to write a Phase I Environmental Site Assessment (ESA) report following ASTM E1527-21.

Extract the following from the provided document text:
- **key_findings**: Important factual findings relevant to the environmental assessment
- **dates**: Any dates mentioned (report dates, historical dates, regulatory dates)
- **addresses**: Any property addresses or locations mentioned
- **chemicals_or_substances**: Any hazardous substances, petroleum products, or chemicals mentioned
- **regulatory_listings**: Any regulatory database listings (RCRA, CERCLIS, LUST, NPL, etc.)
- **data_gaps**: Any noted gaps in information or missing data

Be thorough but concise. Extract facts, not opinions. Each finding should be a single clear sentence.

Return a JSON object with this EXACT structure:
\`\`\`json
{
  "key_findings": ["finding 1", "finding 2"],
  "dates": ["2024-01-15 - report date", "1962 - earliest aerial photograph"],
  "addresses": ["123 Main St, City, State"],
  "chemicals_or_substances": ["petroleum hydrocarbons", "chlorinated solvents"],
  "regulatory_listings": ["RCRA SQG - ABC Company, 0.1 miles SE"],
  "data_gaps": ["No Sanborn maps available for this area"]
}
\`\`\`

Return ONLY the JSON object, no other text.`;
}

function buildProjectFactsSystemPrompt(): string {
  return `You are a senior environmental analyst at ODIC Environmental.

Given a collection of extracted facts from multiple documents for a Phase I ESA project,
synthesize them into a coherent project-level summary.

Return a JSON object with this EXACT structure:
\`\`\`json
{
  "property_description": "Brief description of the property",
  "current_use": "Current use of the property",
  "historical_uses": ["Historical use 1 (date range)", "Historical use 2 (date range)"],
  "adjacent_properties": ["North: description", "South: description"],
  "edr_findings": ["Significant EDR finding 1", "Finding 2"],
  "historical_findings": ["Historical finding from maps/aerials/directories"],
  "agency_findings": ["Agency record finding 1"],
  "recognized_environmental_conditions": ["Potential REC 1", "Potential CREC 1"],
  "data_gaps": ["Missing data item 1"]
}
\`\`\`

Be precise and factual. Distinguish between RECs, CRECs, and HRECs per ASTM E1527-21.
If there are no findings in a category, use an empty array.

Return ONLY the JSON object, no other text.`;
}

function buildSectionWriterSystemPrompt(
  projectContext: ReportWriterInput['projectContext'],
  northStarTemplate: any
): string {
  const reportTypeLabel = REPORT_TYPE_LABELS[projectContext.reportType]
    ?? projectContext.reportType;

  // Extract style guidance from north star template if available
  let styleGuidance = '';
  if (northStarTemplate?.style_guide) {
    styleGuidance = `
## Writing Style Guide (from North Star Template)
${typeof northStarTemplate.style_guide === 'string'
    ? northStarTemplate.style_guide
    : JSON.stringify(northStarTemplate.style_guide, null, 2)}`;
  }

  let sampleSections = '';
  if (northStarTemplate?.sample_sections) {
    const samples = northStarTemplate.sample_sections;
    const sampleEntries = Object.entries(samples).slice(0, 3);
    if (sampleEntries.length > 0) {
      sampleSections = `
## Sample Section Excerpts (Match This Style)
${sampleEntries
    .map(([key, val]) => `### ${key}\n${typeof val === 'string' ? val : JSON.stringify(val)}`)
    .join('\n\n')}`;
    }
  }

  return `You are a senior environmental report writer at ODIC Environmental, a professional environmental consulting firm.

You are writing sections of a ${reportTypeLabel} following ASTM E1527-21 standard practice.

## Project Context
- Project ID: ${projectContext.projectId}
- Project Name: ${projectContext.projectName}
- Client: ${projectContext.clientName}
- Property Address: ${projectContext.propertyAddress}
- Report Type: ${reportTypeLabel}
- SBA Loan: ${projectContext.isSbaLoan ? 'Yes — include SBA SOP 50 10 8 requirements' : 'No'}
- Report Date: ${projectContext.reportDate}
- Environmental Professional: ${projectContext.epName}
${styleGuidance}
${sampleSections}

## Writing Rules

1. **Professional Tone**: Write in a formal, professional tone consistent with environmental consulting reports. Use third person ("the Environmental Professional" not "I/we").

2. **ASTM E1527-21 Compliance**: Follow the terminology, definitions, and structure of ASTM E1527-21. Use the standard's defined terms precisely (REC, CREC, HREC, de minimis condition, etc.).

3. **Specificity**: Reference specific document findings. Do not make vague generalizations. If an EDR report found 3 RCRA sites within the search radius, state that. If Sanborn maps from 1922 show a gas station, state that.

4. **Data Gaps**: Explicitly identify and discuss any data gaps per ASTM E1527-21 Section 9. A data gap exists when the source of information consulted is not sufficient to make a reasonable professional judgment.

5. **Appendix References**: Reference appendices where supporting documentation can be found (e.g., "See Appendix C for the complete EDR Radius Map Report").

6. **No Speculation**: State facts and professional opinions. Do not speculate beyond what the data supports. Qualify uncertainty appropriately.

7. **Formatting**: Use clear paragraph structure. Use subsection headers (e.g., 5.1, 5.2) when content naturally divides into subtopics. Do not use bullet lists in the narrative body — write in full paragraphs.

8. **Consistency**: Maintain consistent terminology throughout. Use the property address as stated in the project context. Reference the property as "the subject property" or "the site" throughout.

Return ONLY the section narrative text. Do not include the section number or title as a header — those will be added programmatically.`;
}

// ── PDF Rendering ────────────────────────────────────────────────────────────────

/** Page layout constants (in points, 72 pt = 1 inch) */
const PAGE_WIDTH = 612; // 8.5 inches (Letter)
const PAGE_HEIGHT = 792; // 11 inches (Letter)
const MARGIN_TOP = 72;
const MARGIN_BOTTOM = 72;
const MARGIN_LEFT = 72;
const MARGIN_RIGHT = 72;
const LINE_HEIGHT = 14;
const HEADING_SIZE = 14;
const BODY_SIZE = 11;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

/**
 * Render a section's text content into a PDF buffer using pdf-lib.
 *
 * This produces clean, professional pages with:
 * - Section header on the first page
 * - Body text with word wrapping
 * - Page breaks as needed
 */
async function renderSectionToPdf(
  sectionNumber: string,
  title: string,
  content: string
): Promise<{ buffer: Buffer; pageCount: number }> {
  const pdfDoc = await PDFDocument.create();
  const timesRoman = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const timesRomanBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  let currentPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let yPosition = PAGE_HEIGHT - MARGIN_TOP;

  /** Add a new page and reset y position */
  function newPage(): PDFPage {
    currentPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    yPosition = PAGE_HEIGHT - MARGIN_TOP;
    return currentPage;
  }

  /** Check if we need a new page; if so, add one */
  function ensureSpace(needed: number): void {
    if (yPosition - needed < MARGIN_BOTTOM) {
      newPage();
    }
  }

  /** Draw a line of text and advance y position */
  function drawLine(text: string, font: PDFFont, size: number, indent = 0): void {
    currentPage.drawText(text, {
      x: MARGIN_LEFT + indent,
      y: yPosition,
      size,
      font,
      color: rgb(0, 0, 0),
    });
    yPosition -= LINE_HEIGHT * (size / BODY_SIZE);
  }

  /** Word-wrap a string to fit within the usable width */
  function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = font.widthOfTextAtSize(testLine, size);

      if (testWidth > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  }

  // ── Draw section header ──
  const headerText = `${sectionNumber}  ${title}`;
  const headerLines = wrapText(headerText, timesRomanBold, HEADING_SIZE, USABLE_WIDTH);
  for (const line of headerLines) {
    ensureSpace(LINE_HEIGHT * (HEADING_SIZE / BODY_SIZE));
    drawLine(line, timesRomanBold, HEADING_SIZE);
  }

  // Add spacing after header
  yPosition -= LINE_HEIGHT;

  // ── Draw body content ──
  // Split content into paragraphs, then render each
  const paragraphs = content.split(/\n\n+/);

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // Check if this is a subsection header (e.g., "5.1 Federal Databases")
    const isSubheading = /^\d+\.\d+\s/.test(trimmed);
    const font = isSubheading ? timesRomanBold : timesRoman;
    const size = isSubheading ? BODY_SIZE + 1 : BODY_SIZE;

    // Word-wrap the paragraph
    const lines = wrapText(trimmed, font, size, USABLE_WIDTH);

    for (const line of lines) {
      ensureSpace(LINE_HEIGHT);
      drawLine(line, font, size);
    }

    // Paragraph spacing
    yPosition -= LINE_HEIGHT * 0.5;
  }

  const pdfBytes = await pdfDoc.save();
  const pageCount = pdfDoc.getPageCount();

  return {
    buffer: Buffer.from(pdfBytes),
    pageCount,
  };
}

// ── Skill Implementation ──────────────────────────────────────────────────────

export class ReportWriterSkill extends BaseSkill<ReportWriterInput, ReportWriterOutput> {
  private llm: LLMClient;

  constructor(config: AppConfig, llm: LLMClient) {
    super(config);
    this.llm = llm;
  }

  get name(): string {
    return 'ReportWriter';
  }

  get usesAI(): boolean {
    return true;
  }

  protected async execute(input: ReportWriterInput): Promise<ReportWriterOutput> {
    const { projectContext, classifiedDocuments, extractedTexts, northStarTemplate } = input;
    const warnings: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    // ── Pass 1: Extract key facts from all documents (Haiku) ──────────────
    this.logger.info(
      { projectId: projectContext.projectId, docCount: classifiedDocuments.length },
      'Pass 1: Extracting key facts from classified documents'
    );

    const extractedFacts = await this.extractFacts(
      classifiedDocuments,
      extractedTexts,
      projectContext
    );
    totalInputTokens += extractedFacts.tokensUsed.input;
    totalOutputTokens += extractedFacts.tokensUsed.output;
    totalCostUsd += extractedFacts.costUsd;

    this.logger.info(
      {
        factGroups: Object.keys(extractedFacts.facts.byDocumentType).length,
        projectFacts: extractedFacts.facts.projectFacts.recognizedEnvironmentalConditions.length,
        costUsd: extractedFacts.costUsd.toFixed(4),
      },
      'Pass 1 complete: Facts extracted'
    );

    // ── Pass 2: Write each section using Sonnet ──────────────────────────
    this.logger.info('Pass 2: Writing narrative sections');

    const sections: GeneratedSection[] = [];
    const sectionSystemPrompt = buildSectionWriterSystemPrompt(projectContext, northStarTemplate);

    for (const sectionDef of SECTION_DEFINITIONS) {
      this.logger.info(
        { sectionId: sectionDef.sectionId, sectionNumber: sectionDef.sectionNumber },
        `Writing section: ${sectionDef.sectionNumber} ${sectionDef.title}`
      );

      const section = await this.writeSection(
        sectionDef,
        extractedFacts.facts,
        sectionSystemPrompt,
        projectContext,
        warnings
      );

      totalInputTokens += section.tokensUsed.input;
      totalOutputTokens += section.tokensUsed.output;
      totalCostUsd += section.costUsd;
      sections.push(section.generated);

      this.logger.info(
        {
          sectionId: sectionDef.sectionId,
          pages: section.generated.pageCount,
          costUsd: section.costUsd.toFixed(4),
        },
        `Section complete: ${sectionDef.sectionNumber} ${sectionDef.title} (${section.generated.pageCount} pages)`
      );
    }

    // ── Pass 3: Generate executive summary from all completed sections ──
    this.logger.info('Pass 3: Generating executive summary');

    const execSummary = await this.writeExecutiveSummary(
      sections,
      extractedFacts.facts,
      sectionSystemPrompt,
      projectContext,
      warnings
    );

    totalInputTokens += execSummary.tokensUsed.input;
    totalOutputTokens += execSummary.tokensUsed.output;
    totalCostUsd += execSummary.costUsd;

    // Insert executive summary at the beginning of the sections array
    sections.unshift(execSummary.generated);

    this.logger.info(
      {
        projectId: projectContext.projectId,
        totalSections: sections.length,
        totalPages: sections.reduce((sum, s) => sum + s.pageCount, 0),
        totalInputTokens,
        totalOutputTokens,
        totalCostUsd: totalCostUsd.toFixed(4),
        warnings: warnings.length,
      },
      'Report writing complete'
    );

    return {
      sections,
      totalTokensUsed: { input: totalInputTokens, output: totalOutputTokens },
      totalCostUsd,
      warnings,
    };
  }

  // ── Pass 1: Fact Extraction ──────────────────────────────────────────────────

  /**
   * Extract key facts from all classified documents using Haiku for speed.
   * Also synthesizes project-level facts from the individual document facts.
   */
  private async extractFacts(
    documents: ClassifiedDocument[],
    extractedTexts: Map<string, string>,
    projectContext: ReportWriterInput['projectContext']
  ): Promise<{
    facts: ExtractedFacts;
    tokensUsed: { input: number; output: number };
    costUsd: number;
  }> {
    const factExtractionPrompt = buildFactExtractionSystemPrompt();
    const byDocumentType: Record<string, DocumentFacts> = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    // Extract facts from each document in parallel (up to 8 concurrent)
    const skipTypes = ['blank_page', 'appendix_divider', 'cover_page', 'insurance_certificate'];
    const maxTextLen = 12000;

    const pLimitMod = await import('p-limit');
    const limit = pLimitMod.default(8);

    await Promise.allSettled(
      documents
        .filter(doc => {
          const filename = doc.raw.filename;
          const text = extractedTexts.get(filename);
          if (!text || text.trim().length < 50) {
            this.logger.debug({ filename }, 'Skipping fact extraction — insufficient text');
            return false;
          }
          if (skipTypes.includes(doc.classification.documentType)) return false;
          return true;
        })
        .map(doc => limit(async () => {
          const filename = doc.raw.filename;
          const text = extractedTexts.get(filename)!;
          const truncatedText = text.length > maxTextLen
            ? text.substring(0, maxTextLen) + '\n\n[... text truncated for extraction ...]'
            : text;

          const userMessage = `## Document: ${filename}
Type: ${doc.classification.documentType}
Pages: ${doc.classification.pageCount}

## Text Content:
${truncatedText}`;

          try {
            const response = await this.llm.classify<AIFactExtractionResponse>(
              factExtractionPrompt,
              userMessage
            );

            totalInput += response.usage.inputTokens;
            totalOutput += response.usage.outputTokens;
            totalCost += response.costUsd;

            byDocumentType[filename] = {
              documentType: doc.classification.documentType,
              filename,
              keyFindings: response.data.key_findings ?? [],
              dates: response.data.dates ?? [],
              addresses: response.data.addresses ?? [],
              chemicals: response.data.chemicals_or_substances ?? [],
              regulatoryListings: response.data.regulatory_listings ?? [],
              dataGaps: response.data.data_gaps ?? [],
            };
          } catch (err) {
            this.logger.warn(
              { filename, error: err instanceof Error ? err.message : String(err) },
              'Failed to extract facts from document — skipping'
            );
          }
        }))
    );

    // Synthesize project-level facts from all document facts
    const projectFacts = await this.synthesizeProjectFacts(
      byDocumentType,
      projectContext
    );
    totalInput += projectFacts.tokensUsed.input;
    totalOutput += projectFacts.tokensUsed.output;
    totalCost += projectFacts.costUsd;

    return {
      facts: {
        byDocumentType,
        projectFacts: projectFacts.facts,
      },
      tokensUsed: { input: totalInput, output: totalOutput },
      costUsd: totalCost,
    };
  }

  /**
   * Synthesize individual document facts into a project-level summary.
   * Uses Haiku since this is aggregation rather than creative writing.
   */
  private async synthesizeProjectFacts(
    byDocumentType: Record<string, DocumentFacts>,
    projectContext: ReportWriterInput['projectContext']
  ): Promise<{
    facts: ProjectFacts;
    tokensUsed: { input: number; output: number };
    costUsd: number;
  }> {
    const systemPrompt = buildProjectFactsSystemPrompt();

    // Build a summary of all extracted facts for synthesis
    const factSummaryParts: string[] = [];
    factSummaryParts.push(`## Project: ${projectContext.projectName}`);
    factSummaryParts.push(`Property: ${projectContext.propertyAddress}`);
    factSummaryParts.push(`Report Type: ${projectContext.reportType}`);
    factSummaryParts.push('');

    for (const [filename, facts] of Object.entries(byDocumentType)) {
      factSummaryParts.push(`### Document: ${filename} (${facts.documentType})`);
      if (facts.keyFindings.length > 0) {
        factSummaryParts.push(`Key Findings: ${facts.keyFindings.join('; ')}`);
      }
      if (facts.chemicals.length > 0) {
        factSummaryParts.push(`Chemicals: ${facts.chemicals.join(', ')}`);
      }
      if (facts.regulatoryListings.length > 0) {
        factSummaryParts.push(`Regulatory Listings: ${facts.regulatoryListings.join('; ')}`);
      }
      if (facts.dataGaps.length > 0) {
        factSummaryParts.push(`Data Gaps: ${facts.dataGaps.join('; ')}`);
      }
      factSummaryParts.push('');
    }

    const userMessage = factSummaryParts.join('\n');

    try {
      const response = await this.llm.classify<AIProjectFactsResponse>(
        systemPrompt,
        userMessage
      );

      return {
        facts: {
          propertyDescription: response.data.property_description ?? '',
          currentUse: response.data.current_use ?? '',
          historicalUses: response.data.historical_uses ?? [],
          adjacentProperties: response.data.adjacent_properties ?? [],
          edrFindings: response.data.edr_findings ?? [],
          historicalFindings: response.data.historical_findings ?? [],
          agencyFindings: response.data.agency_findings ?? [],
          recognizedEnvironmentalConditions:
            response.data.recognized_environmental_conditions ?? [],
          dataGaps: response.data.data_gaps ?? [],
        },
        tokensUsed: {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
        },
        costUsd: response.costUsd,
      };
    } catch (err) {
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to synthesize project facts — using empty defaults'
      );
      return {
        facts: {
          propertyDescription: '',
          currentUse: '',
          historicalUses: [],
          adjacentProperties: [],
          edrFindings: [],
          historicalFindings: [],
          agencyFindings: [],
          recognizedEnvironmentalConditions: [],
          dataGaps: ['Unable to synthesize project facts from documents'],
        },
        tokensUsed: { input: 0, output: 0 },
        costUsd: 0,
      };
    }
  }

  // ── Pass 2: Section Writing ────────────────────────────────────────────────────

  /**
   * Write a single report section using Sonnet.
   * Gathers relevant facts and sends them as context for the writer.
   */
  private async writeSection(
    sectionDef: SectionDefinition,
    facts: ExtractedFacts,
    systemPrompt: string,
    projectContext: ReportWriterInput['projectContext'],
    warnings: string[]
  ): Promise<{
    generated: GeneratedSection;
    costUsd: number;
    tokensUsed: { input: number; output: number };
  }> {
    // Gather facts relevant to this section
    const relevantFacts = this.gatherRelevantFacts(sectionDef, facts);

    // Build the user message with section instructions + relevant facts
    const userMessage = this.buildSectionUserMessage(
      sectionDef,
      relevantFacts,
      facts.projectFacts,
      projectContext
    );

    // Generate the section narrative using Sonnet
    const response = await this.llm.generateText(systemPrompt, userMessage);

    const content = response.data.trim();

    // Check for potential issues
    if (content.length < 200) {
      warnings.push(
        `Section ${sectionDef.sectionNumber} "${sectionDef.title}" is unusually short ` +
        `(${content.length} chars). May indicate insufficient source data.`
      );
    }

    // Render to PDF
    const { buffer, pageCount } = await renderSectionToPdf(
      sectionDef.sectionNumber,
      sectionDef.title,
      content
    );

    return {
      generated: {
        sectionId: sectionDef.sectionId,
        sectionNumber: sectionDef.sectionNumber,
        title: sectionDef.title,
        content,
        pdfBuffer: buffer,
        pageCount,
        tokensUsed: {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
        },
      },
      costUsd: response.costUsd,
      tokensUsed: {
        input: response.usage.inputTokens,
        output: response.usage.outputTokens,
      },
    };
  }

  /**
   * Gather facts relevant to a specific section based on its document type filter.
   */
  private gatherRelevantFacts(
    sectionDef: SectionDefinition,
    facts: ExtractedFacts
  ): DocumentFacts[] {
    if (sectionDef.relevantDocTypes.length === 0) {
      // No filter — return all facts (used for Conclusions, References)
      return Object.values(facts.byDocumentType);
    }

    return Object.values(facts.byDocumentType).filter((df) =>
      sectionDef.relevantDocTypes.includes(df.documentType)
    );
  }

  /**
   * Build the user message for section writing, incorporating extracted facts
   * and project-level context.
   */
  private buildSectionUserMessage(
    sectionDef: SectionDefinition,
    relevantFacts: DocumentFacts[],
    projectFacts: ProjectFacts,
    projectContext: ReportWriterInput['projectContext']
  ): string {
    const parts: string[] = [];

    parts.push(`## Task: Write Section ${sectionDef.sectionNumber} — ${sectionDef.title}`);
    parts.push('');
    parts.push(sectionDef.writingInstructions);
    parts.push('');

    // Project-level facts summary
    parts.push('## Project Facts Summary');
    if (projectFacts.propertyDescription) {
      parts.push(`Property Description: ${projectFacts.propertyDescription}`);
    }
    if (projectFacts.currentUse) {
      parts.push(`Current Use: ${projectFacts.currentUse}`);
    }
    if (projectFacts.historicalUses.length > 0) {
      parts.push(`Historical Uses: ${projectFacts.historicalUses.join('; ')}`);
    }
    if (projectFacts.adjacentProperties.length > 0) {
      parts.push(`Adjacent Properties: ${projectFacts.adjacentProperties.join('; ')}`);
    }
    if (projectFacts.edrFindings.length > 0) {
      parts.push(`EDR Findings: ${projectFacts.edrFindings.join('; ')}`);
    }
    if (projectFacts.historicalFindings.length > 0) {
      parts.push(`Historical Findings: ${projectFacts.historicalFindings.join('; ')}`);
    }
    if (projectFacts.agencyFindings.length > 0) {
      parts.push(`Agency Findings: ${projectFacts.agencyFindings.join('; ')}`);
    }
    if (projectFacts.recognizedEnvironmentalConditions.length > 0) {
      parts.push(
        `Recognized Environmental Conditions: ${projectFacts.recognizedEnvironmentalConditions.join('; ')}`
      );
    }
    if (projectFacts.dataGaps.length > 0) {
      parts.push(`Data Gaps: ${projectFacts.dataGaps.join('; ')}`);
    }
    parts.push('');

    // Relevant document facts
    if (relevantFacts.length > 0) {
      parts.push('## Relevant Document Findings');
      for (const df of relevantFacts) {
        parts.push(`### ${df.filename} (${df.documentType})`);
        if (df.keyFindings.length > 0) {
          parts.push(`Findings: ${df.keyFindings.join('; ')}`);
        }
        if (df.dates.length > 0) {
          parts.push(`Dates: ${df.dates.join('; ')}`);
        }
        if (df.chemicals.length > 0) {
          parts.push(`Chemicals/Substances: ${df.chemicals.join(', ')}`);
        }
        if (df.regulatoryListings.length > 0) {
          parts.push(`Regulatory Listings: ${df.regulatoryListings.join('; ')}`);
        }
        if (df.dataGaps.length > 0) {
          parts.push(`Data Gaps: ${df.dataGaps.join('; ')}`);
        }
        parts.push('');
      }
    } else {
      parts.push('## Note: No directly relevant documents found for this section.');
      parts.push(
        'Use the project facts summary above to write this section. ' +
        'Explicitly note any data gaps where source documents were not available.'
      );
      parts.push('');
    }

    // SBA-specific reminder
    if (projectContext.isSbaLoan) {
      parts.push('## SBA Loan Reminder');
      parts.push(
        'This is an SBA-financed transaction. Ensure this section addresses any ' +
        'applicable SBA SOP 50 10 8 requirements for environmental due diligence.'
      );
      parts.push('');
    }

    parts.push(
      'Write the section narrative now. Return ONLY the section text content, ' +
      'no additional commentary or metadata.'
    );

    return parts.join('\n');
  }

  // ── Pass 3: Executive Summary ──────────────────────────────────────────────────

  /**
   * Generate the executive summary based on all previously written sections.
   * This runs last because it summarizes the entire report.
   */
  private async writeExecutiveSummary(
    completedSections: GeneratedSection[],
    facts: ExtractedFacts,
    systemPrompt: string,
    projectContext: ReportWriterInput['projectContext'],
    warnings: string[]
  ): Promise<{
    generated: GeneratedSection;
    costUsd: number;
    tokensUsed: { input: number; output: number };
  }> {
    const parts: string[] = [];

    parts.push(`## Task: Write the Executive Summary`);
    parts.push('');
    parts.push(EXECUTIVE_SUMMARY_DEFINITION.writingInstructions);
    parts.push('');

    // Provide the content of all completed sections as context
    parts.push('## Completed Report Sections');
    parts.push('');
    for (const section of completedSections) {
      parts.push(`### ${section.sectionNumber} ${section.title}`);
      // Truncate very long sections to stay within token limits
      const maxSectionLen = 3000;
      const sectionText = section.content.length > maxSectionLen
        ? section.content.substring(0, maxSectionLen) + '\n[... section continues ...]'
        : section.content;
      parts.push(sectionText);
      parts.push('');
    }

    // Key findings summary
    parts.push('## Key Environmental Findings');
    const pf = facts.projectFacts;
    if (pf.recognizedEnvironmentalConditions.length > 0) {
      parts.push(`RECs/CRECs/HRECs: ${pf.recognizedEnvironmentalConditions.join('; ')}`);
    } else {
      parts.push('No recognized environmental conditions were identified.');
    }
    if (pf.dataGaps.length > 0) {
      parts.push(`Data Gaps: ${pf.dataGaps.join('; ')}`);
    }
    parts.push('');

    if (projectContext.isSbaLoan) {
      parts.push('## SBA Loan Reminder');
      parts.push(
        'This is an SBA-financed transaction. The executive summary must clearly address ' +
        'whether the property meets SBA environmental requirements.'
      );
      parts.push('');
    }

    parts.push(
      'Write the executive summary now. Return ONLY the summary text, ' +
      'no additional commentary or metadata.'
    );

    const userMessage = parts.join('\n');
    const response = await this.llm.generateText(systemPrompt, userMessage);

    const content = response.data.trim();

    if (content.length < 300) {
      warnings.push(
        'Executive summary is unusually short. May need manual review and expansion.'
      );
    }

    // Render to PDF
    const { buffer, pageCount } = await renderSectionToPdf(
      EXECUTIVE_SUMMARY_DEFINITION.sectionNumber,
      EXECUTIVE_SUMMARY_DEFINITION.title,
      content
    );

    return {
      generated: {
        sectionId: EXECUTIVE_SUMMARY_DEFINITION.sectionId,
        sectionNumber: EXECUTIVE_SUMMARY_DEFINITION.sectionNumber,
        title: EXECUTIVE_SUMMARY_DEFINITION.title,
        content,
        pdfBuffer: buffer,
        pageCount,
        tokensUsed: {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
        },
      },
      costUsd: response.costUsd,
      tokensUsed: {
        input: response.usage.inputTokens,
        output: response.usage.outputTokens,
      },
    };
  }
}

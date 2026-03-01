/**
 * Keyword Scorer — content-based classification without any LLM call.
 *
 * Runs after the evidence pack is extracted. Checks for highly distinctive
 * keyword patterns that unambiguously identify a document type.
 *
 * Returns a KeywordScorerResult with:
 *   - match: the best matching rule (or null if none fired)
 *   - nearMisses: rules that almost matched (for WHY_LLM diagnostics)
 *
 * Rules use a data-driven format (required/anyGroups/negative/page gates)
 * rather than ad-hoc test() functions, enabling structured near-miss tracking.
 *
 * All checks are case-insensitive (uppercase comparison).
 */

import type { DocumentType, ReportSection } from '../types/documents.js';
import { DOCUMENT_TYPE_TO_DEFAULT_SECTION } from '../types/documents.js';
import type { EvidencePack } from '../core/evidence-extractor.js';

// ── Public result types ──────────────────────────────────────────────────────

export interface KeywordScoreResult {
  documentType: DocumentType;
  suggestedSection: ReportSection;
  confidence: number;
  matchedRules: string[];
}

export interface NearMissInfo {
  ruleName: string;
  documentType: DocumentType;
  /** Required terms that DID match */
  matchedRequired: string[];
  /** Required terms that did NOT match */
  missingRequired: string[];
  /** Terms from anyGroups that DID match */
  matchedFromAny: string[];
  /** anyGroup sub-arrays with NO match at all */
  missingFromAny: string[][];
}

export interface KeywordScorerResult {
  match: KeywordScoreResult | null;
  nearMisses: NearMissInfo[];
}

// ── Rule definition ──────────────────────────────────────────────────────────

interface KeywordRule {
  name: string;
  documentType: DocumentType;
  confidence: number;
  /** ALL of these must appear in combined text (uppercase comparison) */
  required: string[];
  /** Each sub-array: at least 1 term must match (AND-of-ORs) */
  anyGroups?: string[][];
  /** ANY of these disqualifies the rule */
  negative?: string[];
  /** Rule only applies if pageCount >= this */
  minPageCount?: number;
  /** Rule only applies if pageCount <= this */
  maxPageCount?: number;
  /** Override for rules that can't be expressed in structured form (no near-miss generated) */
  customTest?: (upperText: string, pageCount: number) => boolean;
}

/** Minimum confidence for a keyword match to be accepted (vs. sending to Haiku) */
const CONFIDENCE_THRESHOLD = 0.85;

// ── Rule evaluation helpers ──────────────────────────────────────────────────

function testRule(rule: KeywordRule, upperText: string, pageCount: number): boolean {
  if (rule.customTest) return rule.customTest(upperText, pageCount);
  if (rule.minPageCount !== undefined && pageCount < rule.minPageCount) return false;
  if (rule.maxPageCount !== undefined && pageCount > rule.maxPageCount) return false;
  if (rule.required.length > 0 && !rule.required.every(r => upperText.includes(r.toUpperCase()))) return false;
  if (rule.anyGroups) {
    for (const group of rule.anyGroups) {
      if (!group.some(t => upperText.includes(t.toUpperCase()))) return false;
    }
  }
  if (rule.negative?.some(n => upperText.includes(n.toUpperCase()))) return false;
  return true;
}

function checkNearMiss(rule: KeywordRule, upperText: string, pageCount: number): NearMissInfo | null {
  // customTest rules don't produce structured near-miss info
  if (rule.customTest) return null;
  if (rule.minPageCount !== undefined && pageCount < rule.minPageCount) return null;
  if (rule.maxPageCount !== undefined && pageCount > rule.maxPageCount) return null;

  const uRequired = rule.required.map(r => r.toUpperCase());
  const matchedRequired = uRequired.filter(r => upperText.includes(r));
  const missingRequired = uRequired.filter(r => !upperText.includes(r));

  // Need at least 1 required term to match to be worth reporting as a near-miss
  if (uRequired.length > 0 && matchedRequired.length === 0) return null;

  const anyGroups = rule.anyGroups ?? [];
  const failedGroups = anyGroups.filter(group => !group.some(t => upperText.includes(t.toUpperCase())));
  const matchedFromAny = anyGroups.flatMap(group => group.filter(t => upperText.includes(t.toUpperCase())));

  // Would this rule fire? If so, it's a match, not a near-miss
  const wouldFire =
    missingRequired.length === 0 &&
    failedGroups.length === 0 &&
    !(rule.negative?.some(n => upperText.includes(n.toUpperCase())));
  if (wouldFire) return null;

  // Something positive matched but the rule didn't fully fire
  const hasPositiveMatch = matchedRequired.length > 0 || matchedFromAny.length > 0;
  if (!hasPositiveMatch) return null;

  return {
    ruleName: rule.name,
    documentType: rule.documentType,
    matchedRequired,
    missingRequired,
    matchedFromAny,
    missingFromAny: failedGroups,
  };
}

// ── Rule definitions (26 total) ──────────────────────────────────────────────

const RULES: KeywordRule[] = [
  // ── Insurance certificate ─────────────────────────────────────────────────
  {
    name: 'acord_liability_cert',
    documentType: 'insurance_certificate',
    confidence: 0.98,
    required: ['CERTIFICATE OF LIABILITY INSURANCE', 'ACORD'],
  },

  // ── Reliance letter ───────────────────────────────────────────────────────
  {
    name: 'reliance_sop_ref',
    documentType: 'reliance_letter',
    confidence: 0.98,
    required: ['SOP 50 10 8'],
  },
  {
    name: 'reliance_letter_lender',
    documentType: 'reliance_letter',
    confidence: 0.97,
    required: ['RELIANCE LETTER', 'LENDER'],
  },
  {
    name: 'reliance_sba',
    documentType: 'reliance_letter',
    confidence: 0.97,
    required: ['SMALL BUSINESS ADMINISTRATION'],
    anyGroups: [['RELIANCE', 'ENVIRONMENTAL LIABILITY', 'SITE ASSESSMENT']],
  },

  // ── EDR report (Environmental Data Resources) ─────────────────────────────
  {
    name: 'edr_full_name',
    documentType: 'edr_report',
    confidence: 0.97,
    required: ['ENVIRONMENTAL DATA RESOURCES'],
    minPageCount: 20,
  },
  {
    name: 'edr_radius_map',
    documentType: 'edr_report',
    confidence: 0.97,
    required: ['EDR', 'RADIUS MAP'],
    minPageCount: 20,
  },
  {
    name: 'edr_lightbox_branding',
    documentType: 'edr_report',
    confidence: 0.97,
    required: ['LIGHTBOX'],
    anyGroups: [['RADIUS', 'GEOCHECK']],
    minPageCount: 20,
  },
  {
    name: 'edr_geocheck',
    documentType: 'edr_report',
    confidence: 0.96,
    required: ['GEOCHECK'],
    anyGroups: [['REGULATORY', 'ENVIRONMENTAL', 'DATABASE']],
    minPageCount: 20,
  },
  {
    name: 'edr_envirostor',
    documentType: 'edr_report',
    confidence: 0.96,
    required: ['ENVIROSTOR'],
    anyGroups: [['CLEANUP', 'HAZARDOUS', 'WASTE']],
    minPageCount: 20,
  },

  // ── Sanborn fire insurance maps ───────────────────────────────────────────
  {
    name: 'sanborn_fire_insurance_map',
    documentType: 'sanborn_map',
    confidence: 0.97,
    required: ['SANBORN', 'FIRE INSURANCE MAP'],
  },
  {
    name: 'fire_ins_nonsanborn',
    documentType: 'sanborn_map',
    confidence: 0.94,
    required: ['FIRE INSURANCE MAP'],
    negative: ['SANBORN'],
  },

  // ── Topographic maps ──────────────────────────────────────────────────────
  {
    name: 'usgs_quadrangle',
    documentType: 'topographic_map',
    confidence: 0.97,
    required: ['USGS', 'QUADRANGLE'],
  },

  // ── EP Declaration ────────────────────────────────────────────────────────
  {
    name: 'ep_declaration_40cfr312',
    documentType: 'ep_declaration',
    confidence: 0.97,
    required: ['40 CFR 312', 'ENVIRONMENTAL PROFESSIONAL'],
  },
  {
    name: 'ep_decl_astm',
    documentType: 'ep_declaration',
    confidence: 0.97,
    required: ['ASTM E1527'],
    anyGroups: [['ENVIRONMENTAL PROFESSIONAL', 'USER OF THE DATA']],
  },

  // ── City directories ──────────────────────────────────────────────────────
  {
    name: 'city_directory_publishers',
    documentType: 'city_directory',
    confidence: 0.96,
    required: [],
    anyGroups: [['CITY DIRECTORY', 'POLK', 'HAINES DIRECTORY']],
    minPageCount: 2,
  },

  // ── Executive summary ─────────────────────────────────────────────────────
  {
    name: 'executive_summary_header',
    documentType: 'executive_summary',
    confidence: 0.96,
    required: ['EXECUTIVE SUMMARY', 'PERFORMED A PHASE I'],
  },

  // ── EP qualifications / resume ────────────────────────────────────────────
  {
    name: 'ep_qualifications_resume',
    documentType: 'ep_qualifications',
    confidence: 0.96,
    required: ['EDUCATION', 'PROFESSIONAL DESIGNATION'],
  },

  // ── Site photographs ──────────────────────────────────────────────────────
  {
    name: 'odic_site_photo_captions',
    documentType: 'site_photograph',
    confidence: 0.95,
    required: ['VIEW OF PROPERTY', 'CAMERA FACING'],
    maxPageCount: 10,
  },

  // ── Building permit ───────────────────────────────────────────────────────
  {
    name: 'building_permit_number',
    documentType: 'building_permit',
    confidence: 0.95,
    required: ['BUILDING PERMIT', 'PERMIT NUMBER'],
  },

  // ── Title record ──────────────────────────────────────────────────────────
  {
    name: 'deed_grantor',
    documentType: 'title_record',
    confidence: 0.95,
    required: ['DEED', 'GRANTOR'],
  },

  // ── ODIC report body ──────────────────────────────────────────────────────
  {
    name: 'odic_report_body_header',
    documentType: 'report_body',
    confidence: 0.94,
    required: ['ODIC ENVIRONMENTAL', 'PHASE I ENVIRONMENTAL SITE ASSESSMENT', 'PROJECT NO'],
  },

  // ── Tax / assessor record ─────────────────────────────────────────────────
  {
    name: 'tax_assessor_parcel',
    documentType: 'tax_record',
    confidence: 0.94,
    required: ['ASSESSOR', 'PARCEL'],
  },

  // ── Prior environmental report ────────────────────────────────────────────
  {
    name: 'prior_env_report',
    documentType: 'prior_environmental_report',
    confidence: 0.93,
    required: ['PHASE I', 'ENVIRONMENTAL SITE ASSESSMENT'],
    anyGroups: [['PREPARED BY', 'CONDUCTED BY', 'SUBMITTED TO']],
    negative: ['ODIC ENVIRONMENTAL'],
  },

  // ── Regulatory correspondence ─────────────────────────────────────────────
  // Presence of 2+ regulatory agency acronyms — count-based, use customTest
  {
    name: 'regulatory_agency_acronyms',
    documentType: 'regulatory_correspondence',
    confidence: 0.93,
    required: [],
    customTest: (text) =>
      ['DTSC', 'RWQCB', 'AQMD', 'DEH', 'EPA', 'LUST', 'RCRA'].filter(t => text.includes(t)).length >= 2,
  },

  // ── Location / plot plan (figure-referenced) ──────────────────────────────
  {
    name: 'location_map_fig',
    documentType: 'location_map',
    confidence: 0.94,
    required: ['SITE LOCATION'],
    anyGroups: [['FIGURE 1', 'FIG. 1', 'FIG 1']],
  },
  {
    name: 'plot_plan_fig',
    documentType: 'location_map',
    confidence: 0.94,
    required: ['SITE PLAN'],
    anyGroups: [['FIGURE 2', 'FIG. 2', 'FIG 2', 'PLOT PLAN']],
  },

  // ── Aerial photograph (text-based) ───────────────────────────────────────
  {
    name: 'aerial_text',
    documentType: 'aerial_photograph',
    confidence: 0.95,
    required: ['AERIAL PHOTOGRAPH'],
    anyGroups: [['HISTORICAL', 'LAND USE', 'COVERAGE AREA']],
  },

  // ── Boring log ────────────────────────────────────────────────────────────
  {
    name: 'boring_log',
    documentType: 'agency_records',
    confidence: 0.96,
    required: ['BORING LOG'],
    anyGroups: [['DEPTH', 'SOIL', 'GROUNDWATER']],
  },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Score a document's content against keyword rules.
 *
 * @param filename     Original filename (for additional signals if needed)
 * @param evidencePack Extracted text from progressive pages
 * @returns KeywordScorerResult with match (or null) and near-miss diagnostics
 */
export function scoreKeywords(filename: string, evidencePack: EvidencePack): KeywordScorerResult {
  const combinedText = evidencePack.sampleTexts.map(s => s.text).join('\n');
  const upperText = combinedText.toUpperCase();
  const pageCount = evidencePack.pageCount;

  const nearMisses: NearMissInfo[] = [];

  for (const rule of RULES) {
    if (rule.confidence >= CONFIDENCE_THRESHOLD && testRule(rule, upperText, pageCount)) {
      const { documentType, confidence, name } = rule;
      const suggestedSection = DOCUMENT_TYPE_TO_DEFAULT_SECTION[documentType];
      return {
        match: {
          documentType,
          suggestedSection,
          confidence,
          matchedRules: [name],
        },
        nearMisses,
      };
    }
    // Collect near-miss info for WHY_LLM diagnostics
    const nm = checkNearMiss(rule, upperText, pageCount);
    if (nm) nearMisses.push(nm);
  }

  return { match: null, nearMisses };
}

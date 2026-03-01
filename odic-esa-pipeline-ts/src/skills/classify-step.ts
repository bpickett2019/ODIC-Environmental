/**
 * Classification Step Executor — wires PDFReader + DocumentClassifier
 * into the pipeline as the "classify" step.
 *
 * For each document in the project:
 * 1. Read the PDF (extract text + page images)
 * 2. Classify the document type using AI
 * 3. Store the classification result in state
 * 4. Track API usage for cost reporting
 *
 * Returns a StepResult with summary data for the pipeline.
 */

import pino from 'pino';
import pLimit from 'p-limit';
import type {
  AppConfig,
  PipelineContext,
  StepResult,
  ClassificationResult,
} from '../types/index.js';
import { StateManager, type DocumentRow } from '../core/state.js';
import { LLMClient } from '../core/llm-client.js';
import type { DocumentTypesConfig } from '../core/config-loader.js';
import { PDFReaderSkill, type PDFReaderOutput } from './pdf-reader.js';
import { DocumentClassifierSkill, type ClassifierOutput } from './document-classifier.js';
import { isValidPDF, getPageCount } from '../core/pdf-utils.js';
import { extractEvidencePack, type EvidencePack } from '../core/evidence-extractor.js';
import { scoreKeywords } from './keyword-scorer.js';

const logger = pino({ name: 'ClassifyStep', level: process.env.LOG_LEVEL || 'info' });

/** Summary data returned from the classify step */
export interface ClassifyStepData {
  /** Total documents processed */
  totalDocuments: number;
  /** Successfully classified */
  classified: number;
  /** Documents needing manual review */
  needsReview: number;
  /** Documents that failed classification */
  failed: number;
  /** Heuristic classifications (filename or metadata, no AI call needed) */
  heuristicClassifications: number;
  /** SHA-256 cache hits (zero cost) */
  cacheHits: number;
  /** Keyword scorer hits (no AI call) */
  keywordHits: number;
  /** Actual Haiku LLM API calls */
  llmCalls: number;
  /** Documents routed to manual review because too large for LLM */
  manualLargeDocs: number;
  /** Sonnet escalations (legacy — always 0, kept for compatibility) */
  sonnetEscalations: number;
  /** Evidence pack retrieved from cache (no PDF read) */
  evidenceCacheHits: number;
  /** Scanned PDFs routed to manual review (no extractable text) */
  scannedManual: number;
  /** Docs that hit the LLM budget cap → manual review */
  llmBudgetExceeded: number;
  /** Per-document results */
  results: Array<{
    docId: string;
    filename: string;
    documentType: string;
    confidence: number;
    needsReview: boolean;
    costUsd: number;
  }>;
}

/**
 * Create the "classify" step executor function.
 *
 * This factory pattern lets the pipeline register the step without
 * importing all skill dependencies directly.
 */
export function createClassifyExecutor(
  config: AppConfig,
  state: StateManager,
  llm: LLMClient,
  docTypes: DocumentTypesConfig
): (ctx: PipelineContext) => Promise<StepResult> {
  const pdfReader = new PDFReaderSkill(config);
  const classifier = new DocumentClassifierSkill(config, llm);

  return async (ctx: PipelineContext): Promise<StepResult> => {
    const startTime = Date.now();
    const projectId = ctx.project.id;

    logger.info({ projectId }, 'Starting classification step');

    // Get all documents for this project from state
    const documents = state.getDocuments(projectId);
    if (documents.length === 0) {
      return {
        step: 'classify',
        success: false,
        durationMs: Date.now() - startTime,
        error: 'No documents found for project',
      };
    }

    const stepData: ClassifyStepData = {
      totalDocuments: documents.length,
      classified: 0,
      needsReview: 0,
      failed: 0,
      heuristicClassifications: 0,
      cacheHits: 0,
      keywordHits: 0,
      llmCalls: 0,
      manualLargeDocs: 0,
      sonnetEscalations: 0,
      evidenceCacheHits: 0,
      scannedManual: 0,
      llmBudgetExceeded: 0,
      results: [],
    };

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    let totalEvidenceChars = 0;
    let evidencePackCount = 0;

    // LLM budget enforcement — shared counters across concurrent classifyOne calls
    let llmCallsThisStep = 0;
    const maxLlmCallsPerProject = config.pipeline.max_llm_calls_per_project ?? 2;
    let evidenceCacheHitCount = 0;

    // Process documents in parallel with configurable concurrency
    const concurrency = config.pipeline.classification_concurrency ?? 8;
    const limit = pLimit(concurrency);
    let completedCount = 0;

    logger.info({ concurrency, totalDocs: documents.length }, `Classifying ${documents.length} documents with concurrency=${concurrency}`);

    const classifyOne = async (doc: DocumentRow) => {
      try {
        // Skip already classified documents (for resume capability)
        if (doc.document_type && doc.confidence !== null) {
          logger.info({ docId: doc.id, filename: doc.filename }, 'Already classified, skipping');
          return {
            status: 'skipped' as const,
            doc,
            result: {
              docId: doc.id,
              filename: doc.filename,
              documentType: doc.document_type,
              confidence: doc.confidence,
              needsReview: Boolean(doc.needs_manual_review),
              costUsd: 0,
            },
          };
        }

        const fileSizeBytes = doc.size_bytes;

        // ── TIER 1: Filename heuristic — no PDF reading at all ──────────────────
        const filenameHeuristic = classifier.tryHeuristicFromFilename(doc.filename, fileSizeBytes);
        if (filenameHeuristic) {
          logger.info(
            { filename: doc.filename, type: filenameHeuristic.documentType, confidence: filenameHeuristic.confidence },
            `[heuristic:filename] ${doc.filename} → ${filenameHeuristic.documentType} — skipping PDF read`
          );
          state.updateDocumentClassification(doc.id, filenameHeuristic);
          completedCount++;
          logger.info(
            { filename: doc.filename, progress: `${completedCount}/${documents.length}` },
            `Classified (filename): ${doc.filename} → ${filenameHeuristic.documentType} [${completedCount}/${documents.length}]`
          );
          return {
            status: 'classified' as const,
            doc,
            classOutput: {
              classification: filenameHeuristic,
              usedEscalation: false,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCostUsd: 0,
              models: ['heuristic_filename'],
            } as ClassifierOutput,
            classification: filenameHeuristic,
            readerOutput: null,
            result: {
              docId: doc.id,
              filename: doc.filename,
              documentType: filenameHeuristic.documentType,
              confidence: filenameHeuristic.confidence,
              needsReview: filenameHeuristic.needsManualReview,
              costUsd: 0,
            },
          };
        }

        // Verify the file is a valid PDF before any PDF work
        const isValid = await isValidPDF(doc.local_path);
        if (!isValid) {
          logger.warn({ docId: doc.id, filename: doc.filename }, 'Not a valid PDF, skipping');
          state.updateDocumentClassification(doc.id, {
            documentType: 'other_unknown',
            confidence: 0,
            reasoning: 'File is not a valid PDF',
            dateDetected: null,
            projectIdDetected: null,
            pageCount: 0,
            pageRange: { start: 0, end: 0 },
            suggestedSection: 'appendix_i_additional',
            needsManualReview: true,
            isSbaSpecific: false,
            metadata: { error: 'invalid_pdf' },
          });
          return { status: 'invalid' as const, doc };
        }

        // ── TIER 2: Metadata heuristic — page count only, no full text extraction ──
        const pageCount = await getPageCount(doc.local_path);
        const metaHeuristic = classifier.tryHeuristicFromMetadata(doc.filename, pageCount, fileSizeBytes);
        if (metaHeuristic) {
          logger.info(
            { filename: doc.filename, type: metaHeuristic.documentType, pageCount, confidence: metaHeuristic.confidence },
            `[heuristic:metadata] ${doc.filename} → ${metaHeuristic.documentType} (${pageCount} pages) — skipping full text extraction`
          );
          state.updateDocumentClassification(doc.id, metaHeuristic);
          completedCount++;
          logger.info(
            { filename: doc.filename, progress: `${completedCount}/${documents.length}` },
            `Classified (metadata): ${doc.filename} → ${metaHeuristic.documentType} [${completedCount}/${documents.length}]`
          );
          return {
            status: 'classified' as const,
            doc,
            classOutput: {
              classification: metaHeuristic,
              usedEscalation: false,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCostUsd: 0,
              models: ['heuristic_metadata'],
            } as ClassifierOutput,
            classification: metaHeuristic,
            readerOutput: null,
            result: {
              docId: doc.id,
              filename: doc.filename,
              documentType: metaHeuristic.documentType,
              confidence: metaHeuristic.confidence,
              needsReview: metaHeuristic.needsManualReview,
              costUsd: 0,
            },
          };
        }

        // ── SIZE GATE: Skip LLM for very large documents ─────────────────────
        const MAX_PAGES_FOR_LLM = 300;
        const MAX_BYTES_FOR_LLM = 80 * 1024 * 1024; // 80 MB
        if (pageCount > MAX_PAGES_FOR_LLM || doc.size_bytes > MAX_BYTES_FOR_LLM) {
          const manualResult: ClassificationResult = {
            documentType: 'other_unknown',
            confidence: 0.5,
            reasoning: `Document too large for AI classification (${pageCount} pages, ${(doc.size_bytes / 1024 / 1024).toFixed(1)} MB). Needs manual review.`,
            dateDetected: null,
            projectIdDetected: null,
            pageCount,
            pageRange: { start: 1, end: pageCount },
            suggestedSection: 'appendix_i_additional',
            needsManualReview: true,
            isSbaSpecific: false,
            metadata: { classifiedBy: 'large_doc_manual', pageCount: String(pageCount) },
          };
          logger.info(
            { filename: doc.filename, pageCount, sizeMB: (doc.size_bytes / 1024 / 1024).toFixed(1) },
            `[large_doc_manual] ${doc.filename} — too large for LLM, routed to manual review`
          );
          state.updateDocumentClassification(doc.id, manualResult);
          completedCount++;
          return {
            status: 'classified' as const,
            doc,
            classOutput: {
              classification: manualResult,
              usedEscalation: false,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCostUsd: 0,
              models: ['large_doc_manual'],
            } as ClassifierOutput,
            classification: manualResult,
            readerOutput: null,
            result: {
              docId: doc.id,
              filename: doc.filename,
              documentType: manualResult.documentType,
              confidence: manualResult.confidence,
              needsReview: true,
              costUsd: 0,
            },
          };
        }

        // ── SHA-256 CACHE CHECK (before evidence extraction) ─────────────────
        const sha256 = doc.sha256 ?? '';
        if (sha256) {
          const cached = state.getCachedClassification(sha256);
          if (cached) {
            const cachedResult = { ...cached, pageCount: doc.page_count || pageCount };
            logger.info(
              { filename: doc.filename, type: cachedResult.documentType },
              `[cache] ${doc.filename} → ${cachedResult.documentType} (sha256 cache hit)`
            );
            state.updateDocumentClassification(doc.id, cachedResult);
            completedCount++;
            return {
              status: 'classified' as const,
              doc,
              classOutput: {
                classification: cachedResult,
                usedEscalation: false,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCostUsd: 0,
                models: ['cache'],
              } as ClassifierOutput,
              classification: cachedResult,
              readerOutput: null,
              result: {
                docId: doc.id,
                filename: doc.filename,
                documentType: cachedResult.documentType,
                confidence: cachedResult.confidence,
                needsReview: cachedResult.needsManualReview,
                costUsd: 0,
              },
            };
          }
        }

        // ── EVIDENCE CACHE CHECK (before PDF read) ────────────────────────────
        let evidencePack: EvidencePack | null = null;
        if (sha256) {
          const cachedEvidence = state.getEvidenceCache(sha256);
          if (cachedEvidence) {
            evidencePack = {
              ...cachedEvidence,
              pageCount,
              fileSizeBytes: doc.size_bytes,
            };
            evidenceCacheHitCount++;
            logger.info(
              { filename: doc.filename },
              `[evidence_cache] ${doc.filename} — evidence pack from cache, skipping PDF read`
            );
          }
        }
        if (!evidencePack) {
          // ── EVIDENCE EXTRACTION (progressive, with early-exit scorer) ───────
          logger.info({ filename: doc.filename }, `Extracting evidence pack: ${doc.filename}`);
          evidencePack = await extractEvidencePack(doc.local_path, pageCount, doc.size_bytes, {
            filename: doc.filename,
            scorerFn: (fn, pack) => scoreKeywords(fn, pack).match !== null,
          });
          if (sha256) state.setEvidenceCache(sha256, evidencePack);
        }

        // ── SCANNED PDF ROUTING ───────────────────────────────────────────────
        if (evidencePack.isLikelyScanned) {
          const scannedResult: ClassificationResult = {
            documentType: 'other_unknown',
            confidence: 0.5,
            reasoning: 'Scanned PDF with no extractable text — needs manual classification.',
            dateDetected: null,
            projectIdDetected: null,
            pageCount,
            pageRange: { start: 1, end: pageCount },
            suggestedSection: 'appendix_i_additional',
            needsManualReview: true,
            isSbaSpecific: false,
            metadata: { classifiedBy: 'scanned_manual', isLikelyScanned: 'true' },
          };
          logger.info(
            { filename: doc.filename },
            `[scanned_manual] ${doc.filename} — isLikelyScanned=true → needsManualReview`
          );
          state.updateDocumentClassification(doc.id, scannedResult);
          completedCount++;
          return {
            status: 'classified' as const,
            doc,
            classOutput: {
              classification: scannedResult,
              usedEscalation: false,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCostUsd: 0,
              models: ['scanned_manual'],
            } as ClassifierOutput,
            classification: scannedResult,
            readerOutput: null,
            evidenceChars: evidencePack.totalChars,
            result: {
              docId: doc.id,
              filename: doc.filename,
              documentType: scannedResult.documentType,
              confidence: scannedResult.confidence,
              needsReview: true,
              costUsd: 0,
            },
          };
        }

        // ── TIER 3: Keyword scorer (no LLM) ──────────────────────────────────
        const { match: kwMatch, nearMisses } = scoreKeywords(doc.filename, evidencePack);
        if (kwMatch) {
          const kwResult: ClassificationResult = {
            documentType: kwMatch.documentType,
            confidence: kwMatch.confidence,
            reasoning: `Keyword scorer matched: ${kwMatch.matchedRules.join(', ')}`,
            dateDetected: null,
            projectIdDetected: null,
            pageCount,
            pageRange: { start: 1, end: pageCount },
            suggestedSection: kwMatch.suggestedSection,
            needsManualReview: false,
            isSbaSpecific: false,
            metadata: { classifiedBy: 'keyword_scorer', matchedRules: kwMatch.matchedRules.join(',') },
          };
          logger.info(
            { filename: doc.filename, type: kwResult.documentType, rules: kwMatch.matchedRules },
            `[keyword_scorer] ${doc.filename} → ${kwResult.documentType}`
          );
          state.updateDocumentClassification(doc.id, kwResult);
          if (sha256) state.setCachedClassification(sha256, kwResult, 'keyword_scorer');
          completedCount++;
          return {
            status: 'classified' as const,
            doc,
            classOutput: {
              classification: kwResult,
              usedEscalation: false,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCostUsd: 0,
              models: ['keyword_scorer'],
            } as ClassifierOutput,
            classification: kwResult,
            readerOutput: null,
            evidenceChars: evidencePack.totalChars,
            result: {
              docId: doc.id,
              filename: doc.filename,
              documentType: kwResult.documentType,
              confidence: kwResult.confidence,
              needsReview: kwResult.needsManualReview,
              costUsd: 0,
            },
          };
        }

        // ── LLM BUDGET CHECK ──────────────────────────────────────────────────
        if (llmCallsThisStep >= maxLlmCallsPerProject) {
          const budgetResult: ClassificationResult = {
            documentType: 'other_unknown',
            confidence: 0.5,
            reasoning: `LLM budget exceeded (limit: ${maxLlmCallsPerProject} calls per project run). Needs manual review.`,
            dateDetected: null,
            projectIdDetected: null,
            pageCount,
            pageRange: { start: 1, end: pageCount },
            suggestedSection: 'appendix_i_additional',
            needsManualReview: true,
            isSbaSpecific: false,
            metadata: { classifiedBy: 'llm_budget_exceeded' },
          };
          logger.warn(
            { filename: doc.filename, llmCallsThisStep, maxLlmCallsPerProject },
            `[llm_budget_exceeded] ${doc.filename} — LLM budget cap reached, routing to manual review`
          );
          state.updateDocumentClassification(doc.id, budgetResult);
          completedCount++;
          return {
            status: 'classified' as const,
            doc,
            classOutput: {
              classification: budgetResult,
              usedEscalation: false,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCostUsd: 0,
              models: ['llm_budget_exceeded'],
            } as ClassifierOutput,
            classification: budgetResult,
            readerOutput: null,
            evidenceChars: evidencePack.totalChars,
            result: {
              docId: doc.id,
              filename: doc.filename,
              documentType: budgetResult.documentType,
              confidence: budgetResult.confidence,
              needsReview: true,
              costUsd: 0,
            },
          };
        }

        // WHY LLM? Log near-miss diagnostics before calling Haiku
        llmCallsThisStep++;
        logger.warn(
          {
            filename: doc.filename,
            nearMisses: nearMisses.map(m => ({
              rule: m.ruleName,
              missing: m.missingRequired,
              missingAny: m.missingFromAny,
            })),
          },
          `[WHY_LLM] ${doc.filename} — no keyword match, dispatching to Haiku`
        );

        // ── TIER 4: Haiku via evidence pack (last resort) ────────────────────
        logger.info({ filename: doc.filename }, `AI classifying from evidence pack: ${doc.filename}`);
        const classOutput = await classifier.classifyFromEvidencePack({
          evidencePack,
          docTypes,
          projectContext: {
            projectId: ctx.project.id,
            projectName: ctx.project.name,
            clientName: ctx.project.clientName,
            propertyAddress: ctx.project.propertyAddress,
            reportType: ctx.project.reportType,
            isSbaLoan: ctx.project.isSbaLoan,
          },
          filename: doc.filename,
        });

        const classification = classOutput.classification;
        state.updateDocumentClassification(doc.id, classification);
        if (sha256) state.setCachedClassification(sha256, classification, 'haiku');

        completedCount++;
        logger.info(
          {
            filename: doc.filename,
            type: classification.documentType,
            confidence: classification.confidence.toFixed(2),
            needsReview: classification.needsManualReview,
            progress: `${completedCount}/${documents.length}`,
          },
          `Classified (AI): ${doc.filename} → ${classification.documentType} (${(classification.confidence * 100).toFixed(0)}%) [${completedCount}/${documents.length}]`
        );

        return {
          status: 'classified' as const,
          doc,
          classOutput,
          classification,
          readerOutput: null,
          evidenceChars: evidencePack.totalChars,
          result: {
            docId: doc.id,
            filename: doc.filename,
            documentType: classification.documentType,
            confidence: classification.confidence,
            needsReview: classification.needsManualReview,
            costUsd: classOutput.totalCostUsd,
          },
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { docId: doc.id, filename: doc.filename, error: errorMsg },
          `Failed to classify: ${doc.filename}`
        );

        state.updateDocumentClassification(doc.id, {
          documentType: 'other_unknown',
          confidence: 0,
          reasoning: `Classification error: ${errorMsg}`,
          dateDetected: null,
          projectIdDetected: null,
          pageCount: 0,
          pageRange: { start: 0, end: 0 },
          suggestedSection: 'appendix_i_additional',
          needsManualReview: true,
          isSbaSpecific: false,
          metadata: { error: errorMsg },
        });

        return {
          status: 'failed' as const,
          doc,
          error: errorMsg,
          result: {
            docId: doc.id,
            filename: doc.filename,
            documentType: 'other_unknown',
            confidence: 0,
            needsReview: true,
            costUsd: 0,
          },
        };
      }
    };

    // Launch all classification tasks with concurrency limit
    const outcomes = await Promise.allSettled(
      documents.map(doc => limit(() => classifyOne(doc)))
    );

    // Aggregate results
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        // Should not happen since classifyOne catches errors, but be safe
        stepData.failed++;
        continue;
      }

      const res = outcome.value;

      if (res.status === 'skipped') {
        stepData.classified++;
        stepData.results.push(res.result);
      } else if (res.status === 'invalid') {
        stepData.failed++;
      } else if (res.status === 'failed') {
        stepData.failed++;
        stepData.results.push(res.result!);
      } else if (res.status === 'classified') {
        const { classOutput, classification, doc } = res;

        totalInputTokens += classOutput.totalInputTokens;
        totalOutputTokens += classOutput.totalOutputTokens;
        totalCostUsd += classOutput.totalCostUsd;

        // Track evidence pack metrics (for log summary)
        const ec = (res as any).evidenceChars as number | undefined;
        if (ec !== undefined) {
          totalEvidenceChars += ec;
          evidencePackCount++;
        }

        stepData.classified++;
        if (classification.needsManualReview) stepData.needsReview++;

        // Tier counter bucketing
        const firstModel = classOutput.models[0];
        if (firstModel === 'cache') {
          stepData.cacheHits++;
        } else if (firstModel === 'keyword_scorer') {
          stepData.keywordHits++;
        } else if (firstModel === 'large_doc_manual') {
          stepData.manualLargeDocs++;
        } else if (firstModel === 'scanned_manual') {
          stepData.scannedManual++;
        } else if (firstModel === 'llm_budget_exceeded') {
          stepData.llmBudgetExceeded++;
        } else if (classOutput.models.some(m => m.startsWith('heuristic'))) {
          stepData.heuristicClassifications++;
        } else {
          stepData.llmCalls++; // actual Haiku API call
        }

        if (classOutput.usedEscalation) stepData.sonnetEscalations++;

        stepData.results.push(res.result);

        // Update pipeline context with classified document
        ctx.project.classifiedDocuments.push({
          raw: {
            filename: doc.filename,
            localPath: doc.local_path,
            sizeBytes: doc.size_bytes,
            sha256: doc.sha256,
            downloadedAt: new Date(doc.created_at),
            projectId,
            pageCount: classification.pageCount ?? 0,
          },
          classification,
          included: true,
        });
      }
    }

    // Propagate shared counters into stepData
    stepData.evidenceCacheHits = evidenceCacheHitCount;

    // Build the step result
    const durationMs = Date.now() - startTime;

    // Add notification about classification results
    if (stepData.needsReview > 0) {
      state.addNotification(
        projectId,
        'warning',
        `Classification complete: ${stepData.classified}/${stepData.totalDocuments} documents classified. ` +
        `${stepData.needsReview} need manual review.`
      );
    } else {
      state.addNotification(
        projectId,
        'info',
        `Classification complete: all ${stepData.classified} documents classified successfully.`
      );
    }

    const avgEvidenceChars = evidencePackCount > 0
      ? Math.round(totalEvidenceChars / evidencePackCount)
      : 0;

    logger.info(
      {
        total: stepData.totalDocuments,
        heuristic: stepData.heuristicClassifications,
        cache: stepData.cacheHits,
        keyword: stepData.keywordHits,
        llm: stepData.llmCalls,
        manual_large: stepData.manualLargeDocs,
        scanned_manual: stepData.scannedManual,
        llm_budget_exceeded: stepData.llmBudgetExceeded,
        evidence_cache_hits: stepData.evidenceCacheHits,
        needs_review: stepData.needsReview,
        cost_usd: totalCostUsd.toFixed(4),
        avg_evidence_chars: avgEvidenceChars,
      },
      '=== CLASSIFICATION TIER BREAKDOWN ==='
    );

    logger.info(
      {
        projectId,
        total: stepData.totalDocuments,
        classified: stepData.classified,
        needsReview: stepData.needsReview,
        failed: stepData.failed,
        heuristic: stepData.heuristicClassifications,
        cache: stepData.cacheHits,
        keyword: stepData.keywordHits,
        llm: stepData.llmCalls,
        totalCostUsd: totalCostUsd.toFixed(4),
        durationMs,
      },
      `Classification step complete for ${projectId}`
    );

    return {
      step: 'classify',
      success: stepData.failed < stepData.totalDocuments, // Succeed if at least one classified
      durationMs,
      data: stepData,
      tokenUsage:
        totalInputTokens > 0
          ? {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              model: 'mixed',
              costUsd: totalCostUsd,
            }
          : undefined,
    };
  };
}

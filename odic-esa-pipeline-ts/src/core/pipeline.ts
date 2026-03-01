/**
 * Pipeline orchestrator — coordinates skill execution order.
 *
 * Manages the sequence of steps for processing a single project:
 *   download → classify → [triage pause] → organize → generate → assemble → QA → compress → notify
 *
 * Handles:
 * - Step sequencing
 * - State updates between steps
 * - Human-in-the-loop pauses (triage review)
 * - Error handling and recovery
 * - Cost tracking per project
 */

import pino from 'pino';
import type { AppConfig, PipelineStep, PipelineContext, StepResult, ProjectStatus } from '../types/index.js';
import { StateManager } from './state.js';
import { LLMClient } from './llm-client.js';
import type { ESATemplate, DocumentTypesConfig } from './config-loader.js';

const logger = pino({ name: 'Pipeline', level: process.env.LOG_LEVEL || 'info' });

/** The ordered list of pipeline steps */
const STEP_ORDER: PipelineStep[] = [
  'download',
  'classify',
  'triage_review',
  'organize',
  'generate_narrative',
  'generate_cover',
  'generate_toc',
  'assemble',
  'qa_check',
  'compress',
  'notify',
];

/** Mapping from step to the project status it sets */
const STEP_TO_STATUS: Partial<Record<PipelineStep, ProjectStatus>> = {
  download: 'downloading',
  classify: 'classifying',
  triage_review: 'awaiting_triage',
  organize: 'organizing',
  assemble: 'assembling',
  qa_check: 'qa_checking',
  compress: 'compressing',
  notify: 'complete',
};

export class Pipeline {
  private config: AppConfig;
  private state: StateManager;
  private llm: LLMClient;
  private esaTemplate: ESATemplate;
  private docTypes: DocumentTypesConfig;

  /** Registry of skill executors keyed by step name */
  private skillExecutors: Map<PipelineStep, (ctx: PipelineContext) => Promise<StepResult>> = new Map();

  constructor(
    config: AppConfig,
    state: StateManager,
    llm: LLMClient,
    esaTemplate: ESATemplate,
    docTypes: DocumentTypesConfig
  ) {
    this.config = config;
    this.state = state;
    this.llm = llm;
    this.esaTemplate = esaTemplate;
    this.docTypes = docTypes;
  }

  /**
   * Register a skill executor for a pipeline step.
   * Skills are registered externally so the pipeline doesn't import them directly.
   */
  registerStep(step: PipelineStep, executor: (ctx: PipelineContext) => Promise<StepResult>): void {
    this.skillExecutors.set(step, executor);
    logger.info({ step }, `Registered executor for step: ${step}`);
  }

  /**
   * Run the full pipeline for a project.
   *
   * @param projectId The project to process
   * @param startFromStep Optional step to resume from (skips earlier steps)
   */
  async run(projectId: string, startFromStep?: PipelineStep): Promise<PipelineContext> {
    const project = this.state.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const ctx: PipelineContext = {
      project: {
        id: project.id,
        name: project.name,
        clientName: project.client_name,
        propertyAddress: project.property_address,
        reportType: (project.report_type ?? 'ESAI') as any,
        isSbaLoan: !!(project as any).is_sba_loan,
        status: project.status as ProjectStatus,
        priority: (project.priority ?? 'normal') as any,
        ftpPath: project.ftp_path,
        localPath: project.local_path,
        fileCount: project.file_count,
        classifiedDocuments: [],
        organizedDocuments: [],
        reportManifest: null,
        qaResult: null,
        outputPdfPath: project.output_pdf_path,
        outputDocxPath: project.output_docx_path,
        estimatedCostUsd: project.estimated_cost_usd,
        errorMessage: project.error_message,
        createdAt: new Date(project.created_at),
        updatedAt: new Date(project.updated_at),
        completedAt: project.completed_at ? new Date(project.completed_at) : null,
      },
      stepResults: new Map(),
      haltOnQAFailure: true,
      triageApproved: this.config.pipeline.auto_assemble_when_complete,
      cancelled: false,
    };

    // Determine which steps to run
    const startIndex = startFromStep ? STEP_ORDER.indexOf(startFromStep) : 0;
    const stepsToRun = STEP_ORDER.slice(startIndex);

    logger.info(
      { projectId, steps: stepsToRun, startFromStep },
      `Starting pipeline for project ${projectId}`
    );

    // Reset LLM usage tracking for this project
    this.llm.resetUsageStats();

    for (const step of stepsToRun) {
      if (ctx.cancelled) {
        logger.info({ projectId, step }, 'Pipeline cancelled');
        break;
      }

      // Handle triage pause
      if (step === 'triage_review' && !ctx.triageApproved) {
        this.state.updateProjectStatus(projectId, 'awaiting_triage');
        this.state.addNotification(
          projectId,
          'info',
          'Classification complete — awaiting your review. Please check the documents and approve to continue.'
        );
        logger.info({ projectId }, 'Pipeline paused for triage review');
        return ctx; // Caller will resume after Rose approves
      }

      // Check if we have an executor for this step
      const executor = this.skillExecutors.get(step);
      if (!executor) {
        logger.warn({ step }, `No executor registered for step: ${step}, skipping`);
        continue;
      }

      // Update project status
      const newStatus = STEP_TO_STATUS[step];
      if (newStatus) {
        this.state.updateProjectStatus(projectId, newStatus);
        ctx.project.status = newStatus;
      }

      // Execute the step
      try {
        logger.info({ projectId, step }, `Executing step: ${step}`);
        const result = await executor(ctx);
        ctx.stepResults.set(step, result);

        // Track API usage if the step used AI
        if (result.tokenUsage) {
          this.state.recordAPIUsage({
            projectId,
            step,
            model: result.tokenUsage.model,
            inputTokens: result.tokenUsage.inputTokens,
            outputTokens: result.tokenUsage.outputTokens,
            costUsd: result.tokenUsage.costUsd,
            timestamp: new Date(),
          });
        }

        if (!result.success) {
          logger.error(
            { projectId, step, error: result.error },
            `Step failed: ${step}`
          );
          this.state.updateProjectStatus(projectId, 'failed', result.error);
          this.state.addNotification(projectId, 'error', `Step "${step}" failed: ${result.error}`);
          return ctx;
        }

        // Special handling for QA failures
        if (step === 'qa_check' && ctx.project.qaResult && !ctx.project.qaResult.passed) {
          if (ctx.haltOnQAFailure) {
            this.state.updateProjectStatus(projectId, 'qa_failed');
            this.state.addNotification(
              projectId,
              'warning',
              `QA check failed (score: ${ctx.project.qaResult.score.toFixed(2)}). Review issues before proceeding.`
            );
            logger.warn({ projectId, qaScore: ctx.project.qaResult.score }, 'QA failed — pipeline halted');
            return ctx;
          }
        }

        logger.info(
          { projectId, step, durationMs: result.durationMs },
          `Step completed: ${step} in ${result.durationMs}ms`
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error({ projectId, step, error: errorMsg }, `Unhandled error in step: ${step}`);
        this.state.updateProjectStatus(projectId, 'failed', errorMsg);
        this.state.addNotification(projectId, 'error', `Unexpected error in "${step}": ${errorMsg}`);

        ctx.stepResults.set(step, {
          step,
          success: false,
          durationMs: 0,
          error: errorMsg,
        });

        return ctx;
      }
    }

    // Pipeline complete
    if (!ctx.cancelled) {
      this.state.updateProjectStatus(projectId, 'complete');
      this.state.addNotification(
        projectId,
        'success',
        `Report assembly complete! Cost: $${this.llm.getUsageStats().totalCostUsd.toFixed(2)}`
      );
      logger.info(
        {
          projectId,
          totalCost: this.llm.getUsageStats().totalCostUsd.toFixed(4),
          totalCalls: this.llm.getUsageStats().callCount,
        },
        'Pipeline complete'
      );
    }

    return ctx;
  }

  /**
   * Resume a pipeline that was paused for triage review.
   * Called after Rose approves the document classification.
   */
  async resumeAfterTriage(projectId: string): Promise<PipelineContext> {
    const project = this.state.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    if (project.status !== 'awaiting_triage') {
      throw new Error(`Project ${projectId} is not awaiting triage (status: ${project.status})`);
    }

    logger.info({ projectId }, 'Resuming pipeline after triage approval');
    return this.run(projectId, 'organize');
  }

  /**
   * Re-run QA on an already assembled report.
   */
  async rerunQA(projectId: string): Promise<PipelineContext> {
    return this.run(projectId, 'qa_check');
  }
}

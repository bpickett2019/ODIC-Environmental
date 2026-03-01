/**
 * Abstract base class for all pipeline skills.
 *
 * Each skill is a self-contained processing step with a standard interface.
 * Skills receive input data, process it (possibly calling AI), and return
 * a typed result with success/failure status.
 */

import pino from 'pino';
import type { AppConfig } from '../types/index.js';

/** Standard result wrapper for all skill outputs */
export interface SkillResult<T = unknown> {
  /** Whether the skill completed successfully */
  success: boolean;
  /** The skill's output data */
  data: T;
  /** Error message if success is false */
  error?: string;
  /** Additional metadata (timing, token usage, etc.) */
  metadata: {
    /** Execution time in milliseconds */
    durationMs: number;
    /** AI model used (if any) */
    model?: string;
    /** Input tokens consumed (if AI was used) */
    inputTokens?: number;
    /** Output tokens consumed (if AI was used) */
    outputTokens?: number;
    /** Estimated cost in USD (if AI was used) */
    costUsd?: number;
    /** Any extra metadata */
    [key: string]: unknown;
  };
}

/** Options for skill execution */
export interface SkillOptions {
  /** Override the default timeout (ms) */
  timeoutMs?: number;
  /** Whether to retry on failure */
  retryOnFailure?: boolean;
  /** Max retries */
  maxRetries?: number;
}

/**
 * Abstract base class for pipeline skills.
 *
 * Subclasses must implement the `execute` method.
 * The base class provides logging, timing, and error handling.
 */
export abstract class BaseSkill<TInput = unknown, TOutput = unknown> {
  protected config: AppConfig;
  protected logger: pino.Logger;

  constructor(config: AppConfig) {
    this.config = config;
    this.logger = pino({
      name: this.constructor.name,
      level: process.env.LOG_LEVEL || 'info',
    });
  }

  /** Human-readable skill name */
  abstract get name(): string;

  /** Whether this skill uses AI (for cost tracking) */
  abstract get usesAI(): boolean;

  /**
   * Execute the skill's core logic.
   * Subclasses implement this — it should NOT handle timing/error wrapping.
   */
  protected abstract execute(input: TInput): Promise<TOutput>;

  /**
   * Run the skill with timing, error handling, and logging.
   * This is the public entry point.
   */
  async process(input: TInput, options?: SkillOptions): Promise<SkillResult<TOutput>> {
    const startTime = Date.now();
    this.logger.info({ skill: this.name }, `Starting skill: ${this.name}`);

    const maxRetries = options?.retryOnFailure
      ? (options.maxRetries ?? this.config.llm.max_retries)
      : 1;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          this.logger.warn(
            { skill: this.name, attempt, maxRetries },
            `Retrying skill: ${this.name} (attempt ${attempt}/${maxRetries})`
          );
          // Exponential backoff: 1s, 2s, 4s, etc.
          await this.sleep(Math.pow(2, attempt - 1) * 1000);
        }

        const data = await this.withTimeout(
          this.execute(input),
          options?.timeoutMs ?? this.config.llm.timeout_seconds * 1000
        );

        const durationMs = Date.now() - startTime;
        this.logger.info(
          { skill: this.name, durationMs },
          `Skill completed: ${this.name} in ${durationMs}ms`
        );

        return {
          success: true,
          data,
          metadata: { durationMs },
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          { skill: this.name, attempt, error: lastError.message },
          `Skill error: ${this.name} - ${lastError.message}`
        );
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      success: false,
      data: undefined as unknown as TOutput,
      error: lastError?.message ?? 'Unknown error',
      metadata: { durationMs },
    };
  }

  /** Wrap a promise with a timeout */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Skill ${this.name} timed out after ${ms}ms`));
      }, ms);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /** Utility sleep */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

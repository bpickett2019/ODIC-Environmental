/**
 * LLM Client — Routes AI calls through the Claude Code CLI.
 *
 * Uses `claude -p` (prompt mode) which automatically bills to your
 * Claude Code subscription. No separate API key or credits needed.
 *
 * Fallback: if `claude` CLI is not available, uses the Anthropic SDK
 * directly with ANTHROPIC_API_KEY.
 *
 * This is the single interface through which all AI calls flow.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam, ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages.js';
import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import pino from 'pino';
import type { LLMConfig } from '../types/index.js';

/** Cost per million tokens by model (approximate) */
const COST_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
};

/** Result of an LLM call with metadata */
export interface LLMResponse<T = string> {
  /** Parsed response data */
  data: T;
  /** Raw text response */
  rawText: string;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Estimated cost in USD */
  costUsd: number;
  /** Which model was used */
  model: string;
  /** Stop reason */
  stopReason: string | null;
}

/** Options for an LLM call */
export interface LLMCallOptions {
  /** Which model tier to use */
  modelTier: 'classifier' | 'reasoning';
  /** System prompt */
  system: string;
  /** Max tokens in response */
  maxTokens?: number;
  /** Temperature (0-1) */
  temperature?: number;
  /** If true, parse response as JSON */
  parseJson?: boolean;
}

/** Input content that can include text and images */
export interface LLMContent {
  /** Text content */
  text?: string;
  /** Base64-encoded images with media types */
  images?: Array<{
    base64: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  }>;
}

export class LLMClient {
  private client: Anthropic | null = null;
  private config: LLMConfig;
  private logger: pino.Logger;
  private mode: 'cli' | 'sdk';
  private claudeCLIPath: string = 'claude';

  /** Running totals for cost tracking */
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;
  private callCount = 0;

  constructor(config: LLMConfig) {
    this.config = config;
    this.logger = pino({ name: 'LLMClient', level: process.env.LOG_LEVEL || 'info' });

    // Priority 1: Use `claude` CLI (routes through Claude Code subscription — no credits needed)
    // Priority 2: Use Anthropic SDK with API key (requires API credits)
    const cliPath = this.findClaudeCLI();
    if (cliPath) {
      this.mode = 'cli';
      this.claudeCLIPath = cliPath;
      this.logger.info({ cliPath }, 'LLMClient initialized via Claude Code CLI (uses your subscription)');
    } else {
      const apiKey = process.env[config.api_key_env];
      if (!apiKey) {
        throw new Error(
          'No AI backend available. Install Claude Code CLI or set ANTHROPIC_API_KEY.'
        );
      }
      this.client = new Anthropic({ apiKey });
      this.mode = 'sdk';
      this.logger.info('LLMClient initialized via Anthropic SDK (API key)');
    }
  }

  /**
   * Find the `claude` CLI binary. Checks PATH + common install locations.
   * Returns the path if found, null if not available.
   */
  private findClaudeCLI(): string | null {
    const home = process.env.HOME || '/Users/bp';

    // Try `which claude` first (covers PATH)
    try {
      const result = execSync('which claude', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
      if (result) {
        execSync(`"${result}" --version`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
        return result;
      }
    } catch {}

    // Try common install locations
    const candidates = [
      '/usr/local/bin/claude',
      `${home}/.claude/bin/claude`,
      `${home}/.npm-global/bin/claude`,
    ];

    // Expand nvm paths
    try {
      const nvmExpanded = execSync(`ls ${home}/.nvm/versions/node/*/bin/claude 2>/dev/null || true`, {
        encoding: 'utf-8', timeout: 3000, stdio: 'pipe',
      }).trim();
      if (nvmExpanded) candidates.push(nvmExpanded.split('\n')[0]);
    } catch {}

    // npm global bin
    try {
      const npxPath = execSync('npm root -g', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' }).trim();
      if (npxPath) {
        const binDir = npxPath.replace(/\/lib\/node_modules$/, '/bin');
        candidates.push(`${binDir}/claude`);
      }
    } catch {}

    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) {
          execSync(`"${candidate}" --version`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
          return candidate;
        }
      } catch {}
    }

    this.logger.warn('Claude CLI not found — tried PATH and common locations');
    return null;
  }

  /**
   * Make an LLM call with text and optional images.
   * Handles retries, parsing, and cost tracking.
   */
  async call<T = string>(
    content: LLMContent,
    options: LLMCallOptions
  ): Promise<LLMResponse<T>> {
    const model =
      options.modelTier === 'classifier'
        ? this.config.classifier_model
        : this.config.reasoning_model;

    if (this.mode === 'cli') {
      return this.callViaCLI<T>(content, options, model);
    } else {
      // SDK mode — but auto-fallback to CLI if credit balance error
      try {
        return await this.callViaSDK<T>(content, options, model);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('credit balance')) {
          this.logger.warn('SDK credit balance error — attempting CLI fallback');
          const cliPath = this.findClaudeCLI();
          if (cliPath) {
            this.claudeCLIPath = cliPath;
            this.mode = 'cli';
            this.logger.info({ cliPath }, 'Switched to CLI mode (subscription billing)');
            return this.callViaCLI<T>(content, options, model);
          }
        }
        throw err;
      }
    }
  }

  /**
   * Call via `claude -p` CLI — uses Claude Code subscription billing.
   */
  private async callViaCLI<T>(
    content: LLMContent,
    options: LLMCallOptions,
    model: string
  ): Promise<LLMResponse<T>> {
    const maxTokens = options.maxTokens ?? 4096;

    // Build the prompt: system instruction + user content
    let prompt = '';
    if (options.system) {
      prompt += `${options.system}\n\n---\n\n`;
    }
    if (content.text) {
      prompt += content.text;
    }

    // Note: CLI mode doesn't support images directly. For image classification,
    // we fall through to SDK mode or use text-only classification.
    if (content.images && content.images.length > 0 && !content.text) {
      this.logger.warn('CLI mode does not support image-only input — falling back to text');
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.config.max_retries; attempt++) {
      try {
        if (attempt > 1) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000;
          this.logger.warn({ model, attempt, backoffMs }, `Retrying CLI call`);
          await new Promise((r) => setTimeout(r, backoffMs));
        }

        this.logger.debug({ model, promptLength: prompt.length, maxTokens }, 'Making CLI call');

        const rawText = await this.execClaude(prompt, model);

        // Estimate tokens (rough: 4 chars per token)
        const inputTokens = Math.ceil(prompt.length / 4);
        const outputTokens = Math.ceil(rawText.length / 4);
        const rates = COST_PER_MILLION_TOKENS[model] ?? { input: 3.0, output: 15.0 };
        const costUsd =
          (inputTokens / 1_000_000) * rates.input +
          (outputTokens / 1_000_000) * rates.output;

        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;
        this.totalCostUsd += costUsd;
        this.callCount++;

        this.logger.info(
          { model, inputTokens, outputTokens, costUsd: costUsd.toFixed(4), via: 'cli' },
          'LLM call completed'
        );

        let data: T;
        if (options.parseJson) {
          data = this.parseJsonResponse<T>(rawText);
        } else {
          data = rawText as unknown as T;
        }

        return {
          data,
          rawText,
          usage: { inputTokens, outputTokens },
          costUsd,
          model,
          stopReason: 'end_turn',
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.error({ model, attempt, error: lastError.message }, 'CLI call failed');

        if (this.isNonRetryableError(lastError)) throw lastError;
      }
    }

    throw lastError ?? new Error('LLM call failed after all retries');
  }

  /** Execute claude CLI with stdin input */
  private execClaude(prompt: string, _model: string): Promise<string> {
    return new Promise((resolve, reject) => {

      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.CLAUDECODE;

      // Use the resolved CLI path; don't specify --model so it uses
      // the subscription's default model (avoids API credit routing)
      const child = spawn(this.claudeCLIPath, [
        '-p',
        '--output-format', 'text',
        '--max-turns', '1',
      ], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: (this.config.timeout_seconds || 120) * 1000,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      child.on('close', (code: number | null) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`claude CLI exited with code ${code}: ${stderr || 'no output'}`));
        }
      });

      child.on('error', (err: Error) => reject(err));

      // Write prompt to stdin and close
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  /**
   * Call via Anthropic SDK — uses API key with credits.
   */
  private async callViaSDK<T>(
    content: LLMContent,
    options: LLMCallOptions,
    model: string
  ): Promise<LLMResponse<T>> {
    if (!this.client) throw new Error('SDK client not initialized');

    const maxTokens = options.maxTokens ?? 4096;
    const temperature = options.temperature ?? 0;

    const contentBlocks: ContentBlockParam[] = [];

    if (content.images && content.images.length > 0) {
      for (const img of content.images) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.base64,
          },
        } as ImageBlockParam);
      }
    }

    if (content.text) {
      contentBlocks.push({ type: 'text', text: content.text } as TextBlockParam);
    }

    if (contentBlocks.length === 0) {
      throw new Error('LLM call requires at least text or images');
    }

    const messages: MessageParam[] = [{ role: 'user', content: contentBlocks }];

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.config.max_retries; attempt++) {
      try {
        if (attempt > 1) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000;
          this.logger.warn({ model, attempt, backoffMs }, `Retrying SDK call`);
          await new Promise((r) => setTimeout(r, backoffMs));
        }

        this.logger.debug({ model, contentBlocks: contentBlocks.length, maxTokens }, 'Making SDK call');

        const response = await this.client.messages.create({
          model,
          max_tokens: maxTokens,
          temperature,
          system: options.system,
          messages,
        });

        const rawText = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n');

        const inputTokens = response.usage.input_tokens;
        const outputTokens = response.usage.output_tokens;
        const rates = COST_PER_MILLION_TOKENS[model] ?? { input: 3.0, output: 15.0 };
        const costUsd =
          (inputTokens / 1_000_000) * rates.input +
          (outputTokens / 1_000_000) * rates.output;

        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;
        this.totalCostUsd += costUsd;
        this.callCount++;

        this.logger.info(
          { model, inputTokens, outputTokens, costUsd: costUsd.toFixed(4), via: 'sdk' },
          'LLM call completed'
        );

        let data: T;
        if (options.parseJson) {
          data = this.parseJsonResponse<T>(rawText);
        } else {
          data = rawText as unknown as T;
        }

        return {
          data,
          rawText,
          usage: { inputTokens, outputTokens },
          costUsd,
          model,
          stopReason: response.stop_reason,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (this.isNonRetryableError(lastError)) throw lastError;
        this.logger.error({ model, attempt, error: lastError.message }, 'SDK call failed');
      }
    }

    throw lastError ?? new Error('LLM call failed after all retries');
  }

  /**
   * Convenience: classify a document (uses Haiku).
   */
  async classify<T>(systemPrompt: string, text: string, images?: Buffer[]): Promise<LLMResponse<T>> {
    const content: LLMContent = { text };

    if (images && images.length > 0) {
      content.images = images.map((buf) => ({
        base64: buf.toString('base64'),
        mediaType: 'image/png' as const,
      }));
    }

    return this.call<T>(content, {
      modelTier: 'classifier',
      system: systemPrompt,
      maxTokens: 2048,
      temperature: 0,
      parseJson: true,
    });
  }

  /**
   * Convenience: reasoning/generation task (uses Sonnet).
   */
  async reason<T>(systemPrompt: string, userMessage: string, parseJson = true): Promise<LLMResponse<T>> {
    return this.call<T>(
      { text: userMessage },
      {
        modelTier: 'reasoning',
        system: systemPrompt,
        maxTokens: 8192,
        temperature: 0,
        parseJson,
      }
    );
  }

  /**
   * Convenience: generate narrative text (uses Sonnet, no JSON parsing).
   */
  async generateText(systemPrompt: string, userMessage: string): Promise<LLMResponse<string>> {
    return this.call<string>(
      { text: userMessage },
      {
        modelTier: 'reasoning',
        system: systemPrompt,
        maxTokens: 8192,
        temperature: 0.3,
        parseJson: false,
      }
    );
  }

  /**
   * Convenience: analyze images with vision (uses Sonnet via SDK).
   * CLI mode does not support images, so this requires ANTHROPIC_API_KEY.
   */
  async analyzeImage(
    systemPrompt: string,
    textPrompt: string,
    imageBuffers: Buffer[],
    mediaType: 'image/png' | 'image/jpeg' = 'image/png'
  ): Promise<LLMResponse<string>> {
    if (this.mode === 'cli' && !this.client) {
      const apiKey = process.env[this.config.api_key_env];
      if (!apiKey) {
        throw new Error(
          'Vision analysis requires ANTHROPIC_API_KEY — the Claude CLI does not support image input.'
        );
      }
      // Temporarily create an SDK client for this vision call
      const tempClient = new Anthropic({ apiKey });
      const savedClient = this.client;
      const savedMode = this.mode;
      this.client = tempClient;
      this.mode = 'sdk';
      try {
        return await this.call<string>(
          {
            text: textPrompt,
            images: imageBuffers.map((buf) => ({
              base64: buf.toString('base64'),
              mediaType,
            })),
          },
          {
            modelTier: 'reasoning',
            system: systemPrompt,
            maxTokens: 2048,
            temperature: 0.2,
            parseJson: false,
          }
        );
      } finally {
        this.client = savedClient;
        this.mode = savedMode;
      }
    }

    return this.call<string>(
      {
        text: textPrompt,
        images: imageBuffers.map((buf) => ({
          base64: buf.toString('base64'),
          mediaType,
        })),
      },
      {
        modelTier: 'reasoning',
        system: systemPrompt,
        maxTokens: 2048,
        temperature: 0.2,
        parseJson: false,
      }
    );
  }

  /** Get cumulative usage stats */
  getUsageStats() {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCostUsd: this.totalCostUsd,
      callCount: this.callCount,
    };
  }

  /** Reset usage stats (e.g., per project) */
  resetUsageStats() {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCostUsd = 0;
    this.callCount = 0;
  }

  /**
   * Parse a JSON response from the AI, handling markdown code fences.
   */
  private parseJsonResponse<T>(rawText: string): T {
    let text = rawText.trim();

    const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonBlockMatch) {
      text = jsonBlockMatch[1].trim();
    }

    const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      text = jsonMatch[1];
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      this.logger.error(
        { rawText: rawText.substring(0, 500) },
        'Failed to parse JSON from LLM response'
      );
      throw new Error(
        `Failed to parse JSON from LLM response: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /** Check if an error is non-retryable */
  private isNonRetryableError(err: Error): boolean {
    const message = err.message.toLowerCase();
    return (
      message.includes('authentication') ||
      message.includes('invalid api key') ||
      message.includes('permission denied') ||
      message.includes('credit balance')
    );
  }
}


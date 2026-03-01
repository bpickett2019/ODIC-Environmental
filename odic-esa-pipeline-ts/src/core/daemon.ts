/**
 * Main daemon process — the persistent background service.
 *
 * Responsibilities:
 * - Watch FTP for new project folders
 * - Queue new projects for processing
 * - Manage concurrent pipeline execution
 * - Expose the dashboard API
 *
 * This is a placeholder for Phase 5 — the full daemon will be built
 * after all skills are working. For now, it provides the initialization
 * logic that wires everything together.
 */

import pino from 'pino';
import path from 'path';
import { loadAppConfig, loadESATemplate, loadDocumentTypes } from './config-loader.js';
import { StateManager } from './state.js';
import { LLMClient } from './llm-client.js';
import { Pipeline } from './pipeline.js';
import { ensureDir } from './pdf-utils.js';
import type { AppConfig } from '../types/index.js';
import type { ESATemplate, DocumentTypesConfig } from './config-loader.js';

const logger = pino({ name: 'Daemon', level: process.env.LOG_LEVEL || 'info' });

export interface DaemonContext {
  config: AppConfig;
  state: StateManager;
  llm: LLMClient;
  pipeline: Pipeline;
  esaTemplate: ESATemplate;
  docTypes: DocumentTypesConfig;
}

/**
 * Initialize all core services and return the daemon context.
 * This is the bootstrap function used by both the daemon and
 * individual test/dev scripts.
 */
export async function initializeDaemon(configPath?: string): Promise<DaemonContext> {
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info('  ODIC Environmental — Phase I ESA Pipeline');
  logger.info('═══════════════════════════════════════════════════════════');

  // 1. Load configuration
  const config = await loadAppConfig(configPath);
  const esaTemplate = await loadESATemplate();
  const docTypes = await loadDocumentTypes();

  // 2. Ensure directories exist
  await ensureDir(config.pipeline.project_base_dir);
  await ensureDir(config.pipeline.output_dir);
  await ensureDir(config.ftp.download_directory);

  // 3. Initialize SQLite state manager
  const dbPath = path.join(config.pipeline.project_base_dir, 'pipeline.db');
  const state = new StateManager(dbPath);
  await state.init();

  // 4. Initialize LLM client
  let llm: LLMClient;
  try {
    llm = new LLMClient(config.llm);
  } catch (err) {
    // If no API key is set, create a placeholder that warns
    logger.warn('LLM client initialization failed — AI features will be unavailable');
    logger.warn(`Set ${config.llm.api_key_env} environment variable to enable AI`);
    // Re-throw so caller knows
    throw err;
  }

  // 5. Create pipeline orchestrator
  const pipeline = new Pipeline(config, state, llm, esaTemplate, docTypes);

  logger.info('Daemon initialized successfully');

  return { config, state, llm, pipeline, esaTemplate, docTypes };
}

/**
 * Initialize daemon with graceful handling of missing API key.
 * Returns context with LLM potentially null for dashboard-only mode.
 */
export async function initializeDaemonSafe(configPath?: string): Promise<DaemonContext & { llmAvailable: boolean }> {
  const config = await loadAppConfig(configPath);
  const esaTemplate = await loadESATemplate();
  const docTypes = await loadDocumentTypes();

  await ensureDir(config.pipeline.project_base_dir);
  await ensureDir(config.pipeline.output_dir);
  await ensureDir(config.ftp.download_directory);

  const dbPath = path.join(config.pipeline.project_base_dir, 'pipeline.db');
  const state = new StateManager(dbPath);

  let llm: LLMClient;
  let llmAvailable = true;

  try {
    llm = new LLMClient(config.llm);
  } catch {
    logger.warn('Running in dashboard-only mode (no API key)');
    llmAvailable = false;
    // Create a stub that throws on use
    llm = new Proxy({} as LLMClient, {
      get: (_, prop) => {
        if (prop === 'getUsageStats') return () => ({ totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, callCount: 0 });
        if (prop === 'resetUsageStats') return () => {};
        return () => {
          throw new Error('LLM not available — set ANTHROPIC_API_KEY');
        };
      },
    });
  }

  const pipeline = new Pipeline(config, state, llm, esaTemplate, docTypes);

  return { config, state, llm, pipeline, esaTemplate, docTypes, llmAvailable };
}

/**
 * Graceful shutdown handler.
 */
export function setupShutdownHandlers(ctx: DaemonContext): void {
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    ctx.state.close();
    logger.info('Cleanup complete, exiting');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * ODIC Environmental — Phase I ESA Pipeline
 * Entry Point
 *
 * Usage:
 *   tsx src/index.ts                    # Start full daemon (FTP watcher + dashboard)
 *   tsx src/index.ts --dashboard-only   # Start dashboard only (no FTP, no AI required)
 *   tsx src/index.ts --process <id>     # Process a single project by ID
 *   tsx src/index.ts --health           # Health check and exit
 */

import pino from 'pino';
import { initializeDaemon, initializeDaemonSafe, setupShutdownHandlers } from './core/daemon.js';

const logger = pino({
  name: 'ODIC-ESA',
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

async function main() {
  const args = process.argv.slice(2);

  // ── Health check mode ──────────────────────────────────────────────────
  if (args.includes('--health')) {
    try {
      const ctx = await initializeDaemonSafe();
      logger.info({
        llmAvailable: ctx.llmAvailable,
        dbReady: true,
        configLoaded: true,
      }, 'Health check passed');
      ctx.state.close();
      process.exit(0);
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Health check failed');
      process.exit(1);
    }
  }

  // ── Dashboard-only mode ────────────────────────────────────────────────
  if (args.includes('--dashboard-only')) {
    logger.info('Starting in dashboard-only mode');
    const ctx = await initializeDaemonSafe();
    setupShutdownHandlers(ctx);

    // Dashboard will be wired up in Phase 6
    logger.info(
      { port: ctx.config.dashboard.port },
      `Dashboard available at http://localhost:${ctx.config.dashboard.port}`
    );
    logger.info('Dashboard server not yet implemented — coming in Phase 6');

    // Keep process alive
    await new Promise(() => {});
    return;
  }

  // ── Single project processing mode ─────────────────────────────────────
  const processIndex = args.indexOf('--process');
  if (processIndex !== -1) {
    const projectId = args[processIndex + 1];
    if (!projectId) {
      logger.error('--process requires a project ID');
      process.exit(1);
    }

    logger.info({ projectId }, 'Processing single project');
    const ctx = await initializeDaemon();
    setupShutdownHandlers(ctx);

    try {
      const result = await ctx.pipeline.run(projectId);
      const finalStatus = result.project.status;
      logger.info({ projectId, status: finalStatus }, 'Project processing complete');

      if (finalStatus === 'failed') {
        process.exit(1);
      }
    } catch (err) {
      logger.error({ projectId, error: (err as Error).message }, 'Project processing failed');
      process.exit(1);
    } finally {
      ctx.state.close();
    }
    return;
  }

  // ── Full daemon mode ───────────────────────────────────────────────────
  logger.info('Starting full daemon mode');

  try {
    const ctx = await initializeDaemon();
    setupShutdownHandlers(ctx);

    logger.info('');
    logger.info('  ╔═══════════════════════════════════════════╗');
    logger.info('  ║  ODIC ESA Pipeline — Ready                ║');
    logger.info('  ║                                           ║');
    logger.info(`  ║  Dashboard: http://localhost:${ctx.config.dashboard.port}       ║`);
    logger.info('  ║  FTP Watcher: Pending (Phase 5)           ║');
    logger.info('  ║  Press Ctrl+C to stop                     ║');
    logger.info('  ╚═══════════════════════════════════════════╝');
    logger.info('');

    // Keep process alive (FTP watcher loop will go here in Phase 5)
    await new Promise(() => {});
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Daemon startup failed');
    logger.info('Tip: Set ANTHROPIC_API_KEY or use --dashboard-only mode');
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ error: (err as Error).message }, 'Unhandled fatal error');
  process.exit(1);
});

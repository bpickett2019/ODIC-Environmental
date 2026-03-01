/**
 * Simple .env file loader — reads key=value pairs from .env into process.env.
 * No external dependencies (no dotenv package needed).
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Load environment variables from a .env file into process.env.
 * Skips lines that are comments (#) or empty.
 * Does NOT override existing environment variables.
 */
export function dotenvLoad(envPath?: string): void {
  const filePath = envPath ?? path.resolve(process.cwd(), '.env');

  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf-8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

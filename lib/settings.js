/**
 * Prompt Optimizer — persistent settings.
 *
 * Settings live in one small JSON file inside the user's home so they survive
 * app restarts, work for every browser profile, and need no profile patch edit.
 * The store is injected into the HTTP layer, which keeps it testable: tests
 * pass their own temp file instead of the real one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeSettings } from './rewrite.js';

export const SETTINGS_FILE_NAME = 'prompt-optimizer.json';

/** `~/.dsh/prompt-optimizer.json` — per user, not per machine install. */
export function defaultSettingsPath() {
  return path.join(os.homedir(), '.dsh', SETTINGS_FILE_NAME);
}

function readJsonFile(file, log) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch (cause) {
    log?.(`settings file is not valid JSON, ignoring it: ${cause instanceof Error ? cause.message : String(cause)}`);
    return undefined;
  }
}

function writeJsonFile(file, value, log) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  log?.(`settings written to ${file}`);
}

/**
 * @param {{ file?: string, log?: (message: string) => void }} [options]
 */
export function createSettingsStore({ file = defaultSettingsPath(), log } = {}) {
  let cached;

  function load() {
    if (cached !== undefined) return cached;
    const parsed = readJsonFile(file, log);
    cached = normalizeSettings(parsed).settings;
    return cached;
  }

  return {
    file,
    /** Current settings, always a complete validated object. */
    get() {
      return { ...load() };
    },
    /** Merge a partial patch, validate, persist. */
    patch(partial) {
      const merged = normalizeSettings({ ...load(), ...(partial && typeof partial === 'object' ? partial : {}) });
      if (merged.rejected.length > 0) {
        return { ok: false, error: `Invalid setting${merged.rejected.length > 1 ? 's' : ''}: ${merged.rejected.join(', ')}.` };
      }
      cached = merged.settings;
      try {
        writeJsonFile(file, cached, log);
      } catch (cause) {
        log?.(`could not persist settings: ${cause instanceof Error ? cause.message : String(cause)}`);
        return { ok: false, error: 'Could not save the settings file.' };
      }
      return { ok: true, settings: { ...cached } };
    },
    /** Drop the file and go back to built-in defaults. */
    reset() {
      cached = normalizeSettings({}).settings;
      try {
        writeJsonFile(file, cached, log);
      } catch (cause) {
        log?.(`could not persist settings: ${cause instanceof Error ? cause.message : String(cause)}`);
        return { ok: false, error: 'Could not save the settings file.' };
      }
      return { ok: true, settings: { ...cached } };
    },
  };
}

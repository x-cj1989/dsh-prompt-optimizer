/**
 * Prompt Optimizer — tiny append-only log for the Host half.
 *
 * The Host runs inside the desktop app, whose stdout is not reachable from the
 * plugin author's terminal, so diagnosing "the button says HTTP 404" needs a
 * durable breadcrumb. This writes one line per event to
 * `<tmp>/dsh-prompt-optimizer.log`, rotates once past 128 KiB and never throws:
 * a broken log must not break the feature.
 *
 * Nothing private is written here — route paths, status codes and error
 * messages only. Draft text is never logged.
 */

import { appendFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOG_PATH = join(tmpdir(), 'dsh-prompt-optimizer.log');
const MAX_BYTES = 128 * 1024;

export function hostLog(message) {
  try {
    try {
      if (statSync(LOG_PATH).size > MAX_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.1`);
    } catch {
      /* no log yet */
    }
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* logging is best effort only */
  }
}

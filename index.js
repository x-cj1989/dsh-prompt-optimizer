/**
 * Prompt Optimizer — Host half.
 *
 * Registers three exact, authenticated routes on the Web connection bridge:
 *
 *   POST /api/prompt.optimize          rewrite a draft (JSON or SSE)
 *   GET  /api/prompt.optimize/models   model catalogue + current default
 *   *    /api/prompt.optimize/settings  read / merge / reset user settings
 *
 * The composer UI calls them same-origin, so the page's signed browser cookie
 * authenticates the request and no token has to reach the plugin. The only file
 * this plugin writes is `~/.dsh/prompt-optimizer.json` (its own settings), and
 * only when the user saves the settings panel.
 *
 * `ctx.inject(['connection'])` matters: the connection service is provided by
 * another plugin, so probing it eagerly from `apply` can run before it exists —
 * the routes were then silently skipped and every click ended in HTTP 404.
 */

import { MODELS_ROUTE, ROUTE, SETTINGS_ROUTE, createRoutes } from './lib/handler.js';
import { LOG_PATH, hostLog } from './lib/hostlog.js';
import { createSettingsStore } from './lib/settings.js';

/** Keep in sync with package.json — `test/package.test.js` enforces it. */
export const VERSION = '1.7.0';

/**
 * Optional bundle settings, read straight from the patch row's `config`:
 *
 *   - id: prompt-optimizer
 *     name: '@local/dsh-prompt-optimizer'
 *     config: { provider: openrouter, model: anthropic/claude-sonnet-4 }
 *
 * Everything is optional. With no config at all the plugin follows the model
 * selected in the composer, then the profile default, then the first model the
 * configured LLM service offers — so it works on a fresh machine unchanged.
 */
function readConfig(config) {
  if (config === null || typeof config !== 'object') return {};
  const provider = typeof config.provider === 'string' ? config.provider.trim() : '';
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  return provider === '' || model === '' ? {} : { provider, model };
}

export function apply(ctx, config) {
  const log = (message, cause) =>
    hostLog(`${message}${cause === undefined ? '' : ` :: ${cause instanceof Error ? cause.message : String(cause)}`}`);

  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection;
    if (typeof connection?.fetch?.register !== 'function') {
      hostLog('apply: connection.fetch is unavailable — routes NOT registered');
      return;
    }

    const store = createSettingsStore({ log: (message) => hostLog(message) });
    const routes = createRoutes({
      getServices: () => {
        // llm/agentDefaultModel are guaranteed by the inject callback; the two
        // grounding services belong to other plugins and may not exist yet, so
        // a failed lookup must degrade to undefined, never throw.
        const optional = (name) => {
          try {
            return scope.get(name);
          } catch {
            return undefined;
          }
        };
        return {
          llm: scope.get('llm'),
          defaultModel: scope.get('agentDefaultModel'),
          agents: optional('agents'),
          workingDirectory: optional('workingDirectory'),
        };
      },
      pluginVersion: VERSION,
      config: readConfig(config),
      store,
      log,
    });

    const registrations = [
      { path: ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: (request) => routes.optimize(request) },
      { path: MODELS_ROUTE, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: (request) => routes.models(request) },
      { path: SETTINGS_ROUTE, methods: ['GET', 'HEAD', 'POST'], requestBody: 'buffered', fetch: (request) => routes.settings(request) },
    ];

    for (const registration of registrations) {
      scope.effect(() => {
        const dispose = connection.fetch.register(registration);
        hostLog(`registered route ${registration.methods.join('/')} ${registration.path} (v${VERSION})`);
        return () => {
          hostLog(`disposed route ${registration.path}`);
          void dispose();
        };
      }, `prompt-optimizer: route ${registration.path}`);
    }

    hostLog(`ready (v${VERSION}), settings at ${store.file}, log at ${LOG_PATH}`);
  });
}
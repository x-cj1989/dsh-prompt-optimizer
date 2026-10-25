/**
 * Prompt Optimizer — Host half.
 *
 * Registers two exact, authenticated routes on the Web connection bridge:
 *
 *   POST /api/prompt.optimize          rewrite a draft (JSON or SSE)
 *   GET  /api/prompt.optimize/models   model catalogue + profile default
 *
 * The composer UI calls them same-origin, so the page's signed browser cookie
 * authenticates the request and no token has to reach the plugin. Nothing is
 * persisted on disk; the only side effect is the model call itself.
 *
 * `ctx.inject(['connection'])` matters: the connection service is provided by
 * another plugin, so probing it eagerly from `apply` can run before it exists —
 * the routes were then silently skipped and every click ended in HTTP 404.
 */

import { MODELS_ROUTE, ROUTE, createRoutes } from './lib/handler.js';
import { LOG_PATH, hostLog } from './lib/hostlog.js';

/** Keep in sync with package.json — `test/package.test.js` enforces it. */
export const VERSION = '1.3.2';

export function apply(ctx) {
  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection;
    if (typeof connection?.fetch?.register !== 'function') {
      hostLog('apply: connection.fetch is unavailable — routes NOT registered');
      return;
    }

    const routes = createRoutes({
      getServices: () => ({ llm: scope.get('llm'), defaultModel: scope.get('agentDefaultModel') }),
      pluginVersion: VERSION,
      log: (message, cause) => hostLog(`${message}${cause === undefined ? '' : ` :: ${cause instanceof Error ? cause.message : String(cause)}`}`),
    });

    const registrations = [
      { path: ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: (request) => routes.optimize(request) },
      { path: MODELS_ROUTE, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: (request) => routes.models(request) },
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

    hostLog(`ready (v${VERSION}), log at ${LOG_PATH}`);
  });
}

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
 */

import { MODELS_ROUTE, ROUTE, createRoutes } from './lib/handler.js';

/** Keep in sync with package.json — `test/package.test.js` enforces it. */
export const VERSION = '1.2.0';

export function apply(ctx) {
  const connection = ctx.get('connection');
  if (connection === undefined || typeof connection?.fetch?.register !== 'function') {
    console.warn('[prompt-optimizer] connection.fetch is unavailable; the optimize routes were not registered.');
    return;
  }

  const routes = createRoutes({
    getServices: () => ({ llm: ctx.get('llm'), defaultModel: ctx.get('agentDefaultModel') }),
    pluginVersion: VERSION,
    log: (message, cause) => console.warn('[prompt-optimizer]', message, cause),
  });

  const registrations = [
    { path: ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: (request) => routes.optimize(request) },
    { path: MODELS_ROUTE, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: (request) => routes.models(request) },
  ];

  for (const registration of registrations) {
    ctx.effect(() => {
      const dispose = connection.fetch.register(registration);
      return () => {
        void dispose();
      };
    }, `prompt-optimizer: route ${registration.path}`);
  }
}

/**
 * Prompt Optimizer — model-aware rewrite policy.
 *
 * One instruction block is not equally good for every model family. A reasoning
 * model already thinks before it writes, so "plan first / think step by step"
 * spends a budget it is already paying and can even push the answer out of the
 * output window (the 1.5.4 empty-answer bug). A plain instruct model needs that
 * plan, and needs one example of the output shape.
 *
 * This module maps a model id onto the few knobs that actually change the
 * rewrite, so the same draft is optimised differently for a thinking model and
 * for an instruct model. It is deliberately conservative: an unknown model name
 * falls back to the instruct profile, which is the safer default.
 */

/** Ids that indicate a hidden reasoning pass. Kept narrow to avoid false hits. */
const REASONING_HINTS = /(?:\bv4\.1\b|-flash\b|\bflash-|thinking|\breasoner\b|deepseek-r|\bqwq|\bo[134](?:-|$|mini|preview)|\bgpt-5\b|\bgrok-[34][^ ]*think|\bgemini[^ ]*think)/iu;

/** Output budgets: a thinking model spends part of the same window on reasoning. */
export const DEFAULT_MODEL_BUDGET = 6000;
export const REASONING_MODEL_BUDGET = 8000;

/**
 * @param {unknown} modelId
 * @param {unknown} [provider]
 * @returns {{ id: string, provider: string, family: 'reasoning' | 'general', reasoning: boolean,
 *   wantsPlanRule: boolean, wantsExample: boolean, tokenBudget: number, container: 'markdown' }}
 */
export function modelProfile(modelId, provider) {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  const prov = typeof provider === 'string' ? provider.trim() : '';
  const reasoning = REASONING_HINTS.test(id);
  return {
    id,
    provider: prov,
    family: reasoning ? 'reasoning' : 'general',
    reasoning,
    wantsPlanRule: reasoning !== true,
    wantsExample: reasoning !== true,
    tokenBudget: reasoning ? REASONING_MODEL_BUDGET : DEFAULT_MODEL_BUDGET,
    container: 'markdown',
  };
}

/**
 * The lines appended to SYSTEM_PROMPT for one profile. Empty for an unknown
 * model, so an install that never resolved a model keeps the plain prompt.
 * @param {{ family?: string } | null | undefined} profile
 * @returns {string}
 */
export function modelGuidance(profile) {
  if (profile === null || profile === undefined || typeof profile !== 'object') return '';
  if (profile.family === 'reasoning') {
    return 'Target model: reasoning-style, it thinks before it answers. Do not tell it to think step by step or to plan first (that budget is already spent): put the weight on the goal, the constraints, the acceptance criteria and the verification. Add a line saying the answer must not restate the reasoning process.';
  }
  return 'Target model: instruct-style, no hidden reasoning pass. Keep the plan-first rule for open-ended work, and give one short example of the output shape whenever the format matters.';
}

/** Small, log-safe projection for HTTP responses. */
export function profileSummary(profile) {
  if (profile === null || profile === undefined || typeof profile !== 'object') return null;
  return { family: profile.family, reasoning: profile.reasoning === true, tokenBudget: profile.tokenBudget };
}

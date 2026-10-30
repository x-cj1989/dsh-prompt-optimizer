/**
 * Prompt Optimizer — Level 1 contract check (free, static, no model call).
 *
 * The anchor ledger answers "did the rewrite keep what the draft said". This
 * answers a different question: "can someone hand this prompt to an agent and
 * get a checkable result". It is a heuristic gate, not a judge — it catches the
 * failures that are visible without executing anything: placeholders left in
 * place, meta commentary, a prompt with no acceptance criteria, no way to
 * verify the result, and leaked credentials.
 *
 * Every rule is a plain regex so the check stays deterministic and testable.
 */

export const CONTRACT_WEIGHTS = Object.freeze({
  placeholder: 30,
  meta: 15,
  acceptance: 20,
  verification: 20,
  stop: 5,
  tooLong: 15,
  secret: 40,
});

const PLACEHOLDER = /\[(?:insert|fill in|todo|tbd|placeholder|填|待补充|待定|占位)/iu;
const META = /^(?:here is|below is|sure[,.!]|certainly[,.!]|以下是为|这是我为你|好的[，,]|优化后)/iu;
const ACCEPTANCE = /(?:验收|完成标准|通过标准|判定标准|definition of done|acceptance criteria|done when|must pass)/iu;
const VERIFICATION = /(?:验证|自检|测试|运行|执行|命令|检查|verify|test|check|run\s|assert)/iu;
const STOP = /(?:停止条件|遇到[^\n]{0,12}(?:失败|不确定|冲突)|无法完成|blocked|stop and|otherwise report|report back)/iu;
const SECRET = /(?:sk-[A-Za-z0-9]{16,}|gh[pous]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})/u;
const TOO_LONG = 12000;

/**
 * @param {unknown} text
 * @param {{ maxChars?: number }} [options]
 * @returns {{ ok: boolean, score: number, issues: { code: string, severity: 'error' | 'warn' | 'info', message: string }[] }}
 */
export function checkContract(text, options = {}) {
  const value = typeof text === 'string' ? text.trim() : '';
  const maxChars = Number.isFinite(options?.maxChars) && options.maxChars > 0 ? options.maxChars : TOO_LONG;
  /** @type {{ code: string, severity: 'error' | 'warn' | 'info', message: string }[]} */
  const issues = [];

  if (value === '') {
    issues.push({ code: 'empty', severity: 'error', message: 'The rewrite is empty.' });
    return { ok: false, score: 0, issues };
  }
  if (PLACEHOLDER.test(value)) {
    issues.push({ code: 'placeholder', severity: 'error', message: 'A placeholder survived: the prompt must state an assumption instead of asking for a value later.' });
  }
  if (META.test(value)) {
    issues.push({ code: 'meta', severity: 'warn', message: 'The rewrite opens with meta commentary instead of the prompt itself.' });
  }
  if (!ACCEPTANCE.test(value)) {
    issues.push({ code: 'acceptance', severity: 'warn', message: 'No acceptance criterion: nobody can tell when the result is done.' });
  }
  if (!VERIFICATION.test(value)) {
    issues.push({ code: 'verification', severity: 'warn', message: 'No verification step: say how the result is checked (a test, a command, a file that must exist).' });
  }
  if (!STOP.test(value)) {
    issues.push({ code: 'stop', severity: 'info', message: 'No stop condition: say what to report when the task cannot be completed.' });
  }
  if (value.length > maxChars) {
    issues.push({ code: 'tooLong', severity: 'warn', message: 'The rewrite is longer than ' + maxChars + ' characters; the model may truncate it.' });
  }
  if (SECRET.test(value)) {
    issues.push({ code: 'secret', severity: 'error', message: 'The rewrite appears to contain a credential; prompts travel through logs and history.' });
  }

  const penalty = issues.reduce((sum, issue) => sum + (CONTRACT_WEIGHTS[issue.code] ?? 0), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { ok: issues.every((issue) => issue.severity !== 'error'), score, issues };
}

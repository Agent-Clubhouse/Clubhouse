/**
 * clubhouse/catch-must-report (telemetry spec §12.4).
 *
 * A `catch` that swallows an error, or turns it into a toast, must also tell
 * telemetry. A catch block passes when it:
 *   - rethrows (contains a `throw`), or
 *   - calls `tel.<anything>(...)`, `reportMainProcessError(...)` or
 *     `reportChromeActionFailed(...)` (which emits clubhouse.ui.action_failed), or
 *   - carries a `// telemetry-exempt: <reason>` comment explaining why not.
 *
 * Nested functions inside the catch don't count: a `throw` or `tel.` call
 * there doesn't run when the catch does.
 */
const EXEMPT = /telemetry-exempt:\s*\S/;
const REPORTERS = new Set(['reportMainProcessError', 'reportChromeActionFailed']);

function isFunction(node) {
  return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

function reports(node) {
  if (!node || typeof node.type !== 'string') return false;
  if (isFunction(node)) return false;
  if (node.type === 'ThrowStatement') return true;
  if (node.type === 'CallExpression') {
    const callee = node.callee.type === 'ChainExpression' ? node.callee.expression : node.callee;
    if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'tel') return true;
    if (callee.type === 'Identifier' && REPORTERS.has(callee.name)) return true;
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      if (child.some((c) => c && typeof c.type === 'string' && reports(c))) return true;
    } else if (child && typeof child.type === 'string' && reports(child)) return true;
  }
  return false;
}

export const catchMustReport = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      report:
        'This catch swallows the error. Report it (tel.exception / tel.event, or a ui.action_failed event), rethrow it, or add `// telemetry-exempt: <reason>`.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      CatchClause(node) {
        if (reports(node.body)) return;
        const comments = sourceCode.getCommentsInside ? sourceCode.getCommentsInside(node) : [];
        if (comments.some((c) => EXEMPT.test(c.value))) return;
        const before = sourceCode.getCommentsBefore ? sourceCode.getCommentsBefore(node) : [];
        if (before.some((c) => EXEMPT.test(c.value))) return;
        context.report({ node, messageId: 'report' });
      },
    };
  },
};

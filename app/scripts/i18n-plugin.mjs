// Rewrites user-visible string literals to sqT("…") during `vite` / `vite build`.
// Vitest does not load this plugin (see vitest.config.ts), and sqT is English
// under VITEST, so unit tests keep asserting the English source text.
//
// Only display positions are rewritten: JSX text, a whitelist of attributes and
// object fields (label, title, placeholder, …), toast messages, and document.title.
// Values, class names, paths and identifiers stay as they are, so logic and
// persisted user content are not translated by accident.
import ts from 'typescript';

const COPY_PROPS = new Set([
  'label', 'title', 'placeholder', 'caption', 'detail',
  'hint', 'subtitle', 'heading', 'tooltip', 'aria-label', 'alt', 'error',
]);

const TOAST_METHODS = new Set(['success', 'error', 'loading']);

export function looksLikeCopy(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 2 || !/[A-Za-z]/.test(text)) return false;
  if (/^https?:\/\//.test(text)) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(text)) return false;
  if (/^[./\\]/.test(text) && !/\s/.test(text)) return false;
  if (!/\s/.test(text)) {
    if (/^[a-z][a-zA-Z0-9_-]*$/.test(text)) return false;
    if (/^[a-z0-9:/.[\]_%+-]+$/.test(text)) return false;
    if (/\.[a-z0-9]{1,5}$/i.test(text)) return false;
    if (text.includes('/') || text.includes('\\')) return false;
    if (/[+|]/.test(text)) return false;
    if (!/^[A-Z0-9][A-Za-z0-9'’&.…/-]*$/.test(text)) return false;
  }
  return true;
}

function propName(node) {
  if (!node?.name) return '';
  const text = node.name.text ?? node.name.getText?.() ?? '';
  return String(text).replace(/^['"]|['"]$/g, '');
}

function isToastCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (ts.isIdentifier(expr) && expr.text === 'toast') return true;
  return ts.isPropertyAccessExpression(expr)
    && ts.isIdentifier(expr.expression)
    && expr.expression.text === 'toast'
    && TOAST_METHODS.has(expr.name.text);
}

function isDocumentTitle(parent, current) {
  if (!ts.isBinaryExpression(parent) || parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  if (parent.right !== current) return false;
  const left = parent.left;
  return ts.isPropertyAccessExpression(left)
    && ts.isIdentifier(left.expression) && left.expression.text === 'document'
    && left.name.text === 'title';
}

function insideSqT(node) {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
  const expr = parent.expression;
  return (ts.isIdentifier(expr) && (expr.text === 'sqT' || expr.text === 't'))
    || (ts.isPropertyAccessExpression(expr) && (expr.name.text === 'sqT' || expr.name.text === 't'));
}

/** True when this node is rendered or stored as chrome copy, not as a value or a class. */
function isDisplay(node) {
  if (insideSqT(node)) return false;
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isJsxAttribute(parent) && parent.initializer === current) return COPY_PROPS.has(propName(parent));
    if (ts.isJsxExpression(parent)) {
      const owner = parent.parent;
      if (owner && ts.isJsxAttribute(owner)) return COPY_PROPS.has(propName(owner));
      return !!(owner && (ts.isJsxElement(owner) || ts.isJsxFragment(owner) || ts.isJsxSelfClosingElement(owner)));
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === current) return COPY_PROPS.has(propName(parent));
    if (ts.isCallExpression(parent) && parent.arguments[0] === current && isToastCall(parent)) return true;
    if (isDocumentTitle(parent, current)) return true;
    if (ts.isParenthesizedExpression(parent) || ts.isConditionalExpression(parent) || ts.isBinaryExpression(parent)
      || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent)
      || ts.isSatisfiesExpression(parent)) {
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

function callFor(key, exprs) {
  const flat = key.replace(/\s+/g, ' ').trim();
  if (!looksLikeCopy(flat)) return null;
  if (!exprs.length) return `sqT(${JSON.stringify(flat)})`;
  const vars = exprs.map((expr, i) => `${i}: ${expr}`).join(', ');
  return `sqT(${JSON.stringify(flat)}, { ${vars} })`;
}

function brace(node, call) {
  return node.parent && ts.isJsxAttribute(node.parent) ? `{${call}}` : call;
}

/**
 * @param {string} code
 * @param {string} fileName
 * @returns {{ code: string, keys: string[] }}
 */
export function transformSource(code, fileName) {
  const kind = fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  /** @type {{ start: number, end: number, text: string, key: string }[]} */
  const edits = [];

  function push(node, call, key) {
    if (!call) return;
    edits.push({ start: node.getStart(source), end: node.getEnd(), text: brace(node, call), key });
  }

  function visit(node) {
    if (ts.isJsxText(node)) {
      const raw = node.getText(source);
      const key = raw.replace(/\s+/g, ' ').trim();
      const word = /^(and|or|with|from|the|for|via)$/.test(key);
      if ((looksLikeCopy(key) || word) && isDisplay(node) === false) {
        // JSX text is a child, not an expression. isDisplay walks parents and
        // returns false for a bare text node, so handle it here.
        const lead = /^\s/.test(raw) ? ' ' : '';
        const trail = /\s$/.test(raw) ? ' ' : '';
        edits.push({
          start: node.getStart(source), end: node.getEnd(),
          text: `${lead}{sqT(${JSON.stringify(key)})}${trail}`, key,
        });
      }
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isDisplay(node)) {
      const key = node.text.replace(/\s+/g, ' ').trim();
      push(node, callFor(key, []), key);
    } else if (ts.isTemplateExpression(node) && isDisplay(node)) {
      const parts = [node.head.text];
      const exprs = [];
      for (const span of node.templateSpans) {
        exprs.push(span.expression.getText(source));
        parts.push(`{${exprs.length - 1}}`, span.literal.text);
      }
      const key = parts.join('').replace(/\s+/g, ' ').trim();
      push(node, callFor(key, exprs), key);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  if (!edits.length) return { code, keys: [] };
  let next = code;
  const keys = [];
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    keys.push(edit.key);
  }
  if (!next.includes("from '@/i18n'") && !next.includes('from "@/i18n"')) {
    next = `import { t as sqT } from '@/i18n';\n${next}`;
  } else if (!/\bsqT\b/.test(code)) {
    next = next.replace(/import\s*\{([^}]+)\}\s*from\s*(['"])@\/i18n\2/, (full, names, q) => {
      if (/\bsqT\b/.test(names)) return full;
      return `import {${names}, t as sqT } from ${q}@/i18n${q}`;
    });
  }
  return { code: next, keys };
}

export function shouldTransformFile(id) {
  if (!id) return false;
  const file = id.split('?')[0].replaceAll('\\', '/');
  if (!/\.(tsx|ts|jsx|js)$/.test(file)) return false;
  if (!file.includes('/app/src/')) return false;
  if (file.includes('/node_modules/')) return false;
  if (file.includes('/app/src/i18n/')) return false;
  if (file.includes('/app/src/bridge/')) return false;
  if (file.includes('/app/src/ai/tools/') || file.includes('/app/src/ai/prompts/') || file.includes('/app/src/ai/styles/')) return false;
  if (file.includes('/__tests__/') || /\.(test|spec)\.[tj]sx?$/.test(file)) return false;
  return true;
}

export function i18nPlugin() {
  return {
    name: 'webdilna-i18n',
    enforce: 'pre',
    transform(code, id) {
      if (!shouldTransformFile(id)) return null;
      const result = transformSource(code, id.split('?')[0]);
      if (result.code === code) return null;
      return { code: result.code, map: null };
    },
  };
}

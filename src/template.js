/**
 * Message rendering: {{variable}} substitution plus {a|b|c} spintax.
 */

/** Resolve {a|b|c} by picking one option at random. Supports nesting. */
function spin(text) {
  const pattern = /\{([^{}]*)\}/;
  let out = String(text);
  let guard = 0;
  while (pattern.test(out) && guard++ < 100) {
    out = out.replace(pattern, (_, body) => {
      const options = body.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return out;
}

/** Replace {{var}} with vars.var. Unknown variables render as empty string. */
function substitute(text, vars = {}) {
  return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = vars[key.toLowerCase()];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Full render: substitute first (so variables can't be eaten by spintax), then spin. */
function render(template, vars = {}) {
  return spin(substitute(template, vars)).replace(/[ \t]+\n/g, '\n').trim();
}

/** Variable names referenced by a template, for the UI to validate against the list. */
function usedVariables(template) {
  const out = new Set();
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(template)))) out.add(m[1].toLowerCase());
  return [...out];
}

module.exports = { render, spin, substitute, usedVariables };

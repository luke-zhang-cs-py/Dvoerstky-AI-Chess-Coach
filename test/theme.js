// Checks for the page theme and the board colours: every page theme sets the same tokens, every
// pairing the page draws meets WCAG AA in every theme, every board theme's coordinates read on their
// squares, components read tokens only, and js/theme.js restores, switches and remembers the theme.
// Run: node test/theme.js
globalThis.window = globalThis;
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const css = read('css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');   // comments out: they quote token names
const html = read('index.html'), ui = read('js/ui.js');
require('../js/theme.js');
const { Theme } = globalThis;

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}
const show = v => JSON.stringify(v);

// ---------------------------------------------------------------- the stylesheet's token blocks
// @media blocks are cut out first (print colours are raw on purpose), then every plain rule is read.
function cutMedia(text, query) {
  let out = text, i;
  while ((i = out.indexOf(query)) > -1) {
    let depth = 0, j = out.indexOf('{', i);
    for (; j < out.length; j++) { if (out[j] === '{') depth++; else if (out[j] === '}' && --depth === 0) break; }
    out = out.slice(0, i) + out.slice(j + 1);
  }
  return out;
}
const screen = cutMedia(css, '@media print');
const rules = [...screen.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
const decls = body => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map(m => [m[1], m[2].trim()]));
// A token block's selector is made of nothing but :where(:root), :root, :root[data-board-theme...] and .theme-<name>.
const parts = r => r.sel.split(',').map(s => s.trim());
const isTokens = r => parts(r).every(s => /^(:where\(:root\)|:root(\[data-board-theme[\^]?="[a-z-]+"\])?|\.theme-[a-z]+)$/.test(s));

const themes = {};   // name -> tokens
for (const r of rules.filter(isTokens)) for (const s of parts(r)) {
  const m = s.match(/^\.theme-([a-z]+)$/);
  if (m) themes[m[1]] = Object.assign(themes[m[1]] || {}, decls(r.body));
}
const fallback = rules.filter(r => r.sel.split(',').map(s => s.trim()).includes(':where(:root)'));
const rootTokens = Object.assign({}, ...rules.filter(r => r.sel === ':root').map(r => decls(r.body)));
const boards = { cyan: {} };   // name -> what it sets over the :root default
for (const r of rules) {
  const m = r.sel.match(/^:root\[data-board-theme="([a-z-]+)"\]$/);
  if (m) boards[m[1]] = decls(r.body);
}
const board = name => Object.assign({}, rootTokens, boards[name]);

// ---------------------------------------------------------------- page themes: one block each, the same tokens in each
const CONTRACT = ['bg', 'surface', 'surface-subtle', 'border', 'border-strong', 'text-primary', 'text-muted', 'text-subtle',
                  'accent', 'accent-hover', 'accent-subtle', 'text-on-accent', 'danger'].map(t => '--color-' + t);
check('themes: THEMES starts with dark, and the markup opens on it with no script needed',
  Theme.THEMES[0] === 'dark' && /<html lang="en" class="theme-dark">/.test(html), show(Theme.THEMES));
check('themes: every theme in THEMES has a .theme-<name> block, and dark is also the :where(:root) fallback',
  Theme.THEMES.every(t => themes[t]) && fallback.length === 1 && /\.theme-dark/.test(fallback[0].sel),
  show({ blocks: Object.keys(themes), fallback: fallback.map(r => r.sel) }));
const keys = t => Object.keys(themes[t] || {}).sort().join(' ');
check('themes: every block sets the same tokens as the default, the 13 the contract names among them',
  Theme.THEMES.every(t => keys(t) === keys('dark')) && CONTRACT.every(k => k in themes.dark) && Object.keys(themes).length === Theme.THEMES.length,
  show(Theme.THEMES.map(t => [t, Object.keys(themes[t] || {}).filter(k => !(k in themes.dark)).concat(Object.keys(themes.dark).filter(k => !(k in (themes[t] || {}))))])));
check('themes: no prefers-color-scheme switching, so the page is dark until the visitor picks light',
  !/prefers-color-scheme/.test(css));

// ---------------------------------------------------------------- contrast, from the tokens
function lum(hex) {
  const c = hex.replace('#', '').match(/../g).map(h => parseInt(h, 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
}
function ratio(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); }
function short(pairs, need, tokens, prefix) {
  return pairs.map(([f, b]) => [f, b, tokens[prefix + f], tokens[prefix + b]])
    .filter(([, , fc, bc]) => !/^#[0-9a-f]{6}$/i.test(fc || '') || !/^#[0-9a-f]{6}$/i.test(bc || '') || ratio(fc, bc) < need)
    .map(([f, b, fc, bc]) => f + ' on ' + b + ' ' + (fc && bc && /^#/.test(fc + bc) ? ratio(fc, bc).toFixed(2) : 'not a #rrggbb colour'));
}
// Every foreground the page draws, on every background it draws it on (css/app.css; the inline colours in js/ui.js
// are danger and success text on sheets and table rows). Hover, current and error states are in the list too.
const BGS = ['bg', 'surface', 'surface-subtle'];
const TEXT = [
  ...['text-primary', 'text-muted', 'text-subtle', 'accent', 'danger', 'success', 'warning'].flatMap(f => BGS.map(b => [f, b])),
  ['text-primary', 'accent-subtle'], ['text-muted', 'accent-subtle'], ['accent', 'accent-subtle'],   // tags, quiet buttons hovered, side to move
  ['danger', 'danger-subtle'], ['success', 'success-subtle'], ['warning', 'warning-subtle'],         // tags, the goal pin
  ['text-primary', 'success-subtle'], ['text-muted', 'success-subtle'],                              // a calendar day done
  ['text-on-accent', 'accent'], ['text-on-accent', 'accent-hover'],                                  // primary buttons, hovered too
  ['surface', 'text-primary'],                                                                        // the current move, the ruler's pin
  ['bg', 'accent'], ['bg', 'success'],                                                                // letters in the comparison dots
];
// Edges that identify a control, focus rings, and lines or bars that carry meaning: 3:1.
const UI = [
  ...BGS.map(b => ['border-strong', b]),                                                              // form fields, tick marks
  ...['accent', 'danger', 'success', 'warning', 'text-subtle'].flatMap(f => ['bg', 'surface'].map(b => [f, b])),   // focus, bars, chart lines
];
const textShort = Theme.THEMES.map(t => [t, short(TEXT, 4.5, themes[t] || {}, '--color-')]).filter(x => x[1].length);
check('contrast: every text pairing the page draws is 4.5:1 or more, in every theme (' + TEXT.length + ' pairs)', !textShort.length, show(textShort));
const uiShort = Theme.THEMES.map(t => [t, short(UI, 3, themes[t] || {}, '--color-')]).filter(x => x[1].length);
check('contrast: every field edge, focus ring, bar and chart line is 3:1 or more, in every theme (' + UI.length + ' pairs)', !uiShort.length, show(uiShort));

// ---------------------------------------------------------------- board themes: apart from the page theme, coordinates legible
const select = html.match(/<select id="setBoardTheme">([\s\S]*?)<\/select>/)[1];
const offered = [...select.matchAll(/value="([a-z-]+)"/g)].map(m => m[1]).sort();
check('board: every board theme in Settings has its colours, and every set of colours is offered',
  show(offered) === show(Object.keys(boards).sort()), show({ offered, styled: Object.keys(boards) }));
const pageColour = k => /^--color-/.test(k) && !/^--color-board-/.test(k);
const mixed = [...Object.entries(themes).flatMap(([t, v]) => Object.keys(v).filter(k => /^--color-board-|^--shadow-piece/.test(k)).map(k => t + ' ' + k)),
               ...Object.entries(boards).flatMap(([b, v]) => Object.keys(v).filter(pageColour).map(k => b + ' ' + k)),
               ...Object.keys(rootTokens).filter(pageColour)];
check('board: board colours are their own setting: no page theme sets one, no board theme sets a page colour', !mixed.length, show(mixed));
const COORDS = [['coord-on-light', 'light'], ['coord-on-dark', 'dark'], ['coord-on-highlight', 'from'], ['coord-on-highlight', 'to'], ['coord-on-check', 'check']];
const coordShort = Object.keys(boards).map(b => [b, short(COORDS, 4.5, board(b), '--color-board-')]).filter(x => x[1].length);
check('board: coordinates read at 4.5:1 on every square they are drawn on, in every board theme', !coordShort.length, show(coordShort));

// ---------------------------------------------------------------- components read tokens only
const RAW = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
const rawCss = rules.filter(r => !isTokens(r) && RAW.test(r.body)).map(r => r.sel);
const rawInline = [...(html + ui).matchAll(/style=\\?"([^"]*)/g)].map(m => m[1]).filter(s => RAW.test(s));
check('tokens: no raw colour outside the token blocks (print aside), in the stylesheet or an inline style',
  !rawCss.length && !rawInline.length, show(rawCss.concat(rawInline)));
const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]).concat([...ui.matchAll(/setProperty\('(--[\w-]+)'/g)].map(m => m[1])));
const undefinedVars = [...new Set([...(css + html + ui).matchAll(/var\((--[\w-]+)/g)].map(m => m[1]))].filter(v => !defined.has(v));
check('tokens: every var() the stylesheet, index.html and ui.js read is defined', !undefinedVars.length, show(undefinedVars));
const spaces = Object.entries(rootTokens).filter(([k]) => /^--space-\d+$/.test(k));
check('tokens: the spacing scale is --space-N = N quarter-rems',
  spaces.length >= 5 && spaces.every(([k, v]) => parseFloat(v) === +k.split('-').pop() * .25 && /rem$/.test(v)), show(spaces));

// ---------------------------------------------------------------- js/theme.js, on a stand-in document
function page(cls) {
  const on = {}, attrs = {}, el = { className: cls };
  const list = () => el.className.split(/\s+/).filter(Boolean);
  el.classList = {
    contains: c => list().includes(c),
    replace: (a, b) => { const l = list(), i = l.indexOf(a); if (i < 0) return false; l[i] = b; el.className = l.join(' '); return true; },
  };
  const btn = { attrs, setAttribute: (k, v) => { attrs[k] = v; }, addEventListener: (t, f) => { on[t] = f; }, click: () => on.click() };
  return { documentElement: el, getElementById: id => (id === 'themeBtn' ? btn : null), btn };
}
function storage(saved, blocked) {
  const data = saved === undefined ? {} : { theme: saved };
  const s = { data, getItem: k => { if (blocked) throw new Error('blocked'); return k in data ? data[k] : null; },
              setItem: (k, v) => { if (blocked) throw new Error('blocked'); data[k] = String(v); } };
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
  return s;
}
function opened(saved, blocked) { storage(saved, blocked); const d = page('js theme-dark'); Theme.restore(d); return d.documentElement.className; }
const restored = { light: opened('light'), none: opened(undefined), bad: opened('Light!'), blocked: opened('light', true) };
check('restore: a saved light theme replaces theme-dark before first paint; nothing saved, a malformed name or blocked storage leaves dark',
  show(restored) === show({ light: 'js theme-light', none: 'js theme-dark', bad: 'js theme-dark', blocked: 'js theme-dark' }), show(restored));
{
  storage('sepia'); const d = page('theme-dark'); Theme.restore(d); const before = d.documentElement.className;
  Theme.init(d);
  check('init: an unknown saved theme falls back to dark, and the button offers light',
    before === 'theme-sepia' && d.documentElement.className === 'theme-dark' && d.btn.attrs['aria-label'] === 'Switch to light theme',
    show([before, d.documentElement.className, d.btn.attrs]));
}
{
  const s = storage(undefined), d = page('js theme-dark'); Theme.init(d);
  const seen = [];
  for (let i = 0; i < 2; i++) { d.btn.click(); seen.push([d.documentElement.className, s.data.theme, d.btn.attrs['aria-label']]); }
  check('switch: the button steps dark, light, dark, saves each under "theme" and names the theme it goes to next',
    show(seen) === show([['js theme-light', 'light', 'Switch to dark theme'], ['js theme-dark', 'dark', 'Switch to light theme']])
    && Theme.KEY === 'theme' && Theme.next('light') === 'dark' && Theme.current(d) === 'dark', show(seen));
}
{
  storage(undefined, true); const d = page('theme-dark'); Theme.init(d); d.btn.click();
  check('switch: with storage blocked the theme still switches; it is only not remembered', d.documentElement.className === 'theme-light',
    d.documentElement.className);
}
const head = html.slice(0, html.indexOf('</head>'));
check('index.html: theme.js loads in <head> before the stylesheet, and the button is type=button and named for where it goes',
  head.indexOf('<script src="js/theme.js"></script>') > -1 && head.indexOf('js/theme.js') < head.indexOf('css/app.css')
  && /<button type="button" id="themeBtn"[^>]* aria-label="Switch to light theme">/.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

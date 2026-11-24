/* theme.js — the page's colour theme. Loaded in <head>, before the stylesheet.

   Not needed to theme the page: class="theme-dark" on <html> is in the markup, so the page
   is dark with or without JavaScript. This restores a theme picked earlier, before first
   paint so it never flashes, and runs the theme button in the masthead. The board's own
   colours are a separate setting (Settings -> Board colours) and do not change with it. */
(function (root) {
  'use strict';
  // In order; each name needs a .theme-<name> block in css/app.css, and the first is the one in the markup.
  var THEMES = ['dark', 'light'];
  // The same key on every page of luke-zhang-cs-py.github.io, so one choice carries across the site.
  var KEY = 'theme';

  function saved() {
    try { return root.localStorage.getItem(KEY); } catch (e) { return null; }   // storage blocked
  }

  // Before first paint: the markup's theme-dark becomes the saved theme. A name the stylesheet has
  // no block for still renders dark (its :where(:root) fallback), and init() then drops it.
  function restore(doc) {
    var name = saved();
    if (/^[a-z]+$/.test(name || '')) doc.documentElement.classList.replace('theme-dark', 'theme-' + name);
  }

  function current(doc) {
    var cls = doc.documentElement.classList;
    return THEMES.filter(function (t) { return cls.contains('theme-' + t); })[0] || THEMES[0];
  }

  function next(name) { return THEMES[(THEMES.indexOf(name) + 1) % THEMES.length]; }

  function apply(doc, name) {
    var html = doc.documentElement;
    html.className = (html.className.replace(/(^|\s)theme-\S+/g, '') + ' theme-' + name).trim();
    doc.getElementById('themeBtn').setAttribute('aria-label', 'Switch to ' + next(name) + ' theme');
  }

  // The button steps through THEMES and remembers the choice. The label it shows comes from the
  // stylesheet, so it is right before this runs too.
  function init(doc) {
    var theme = current(doc);
    apply(doc, theme);   // also drops a saved theme that no longer exists
    doc.getElementById('themeBtn').addEventListener('click', function () {
      theme = next(theme);
      try { root.localStorage.setItem(KEY, theme); } catch (e) { /* not remembered */ }
      apply(doc, theme);
    });
  }

  root.Theme = { THEMES: THEMES, KEY: KEY, restore: restore, current: current, next: next, init: init };
  if (root.document) {   // in the page; under Node (test/theme.js) the functions are called directly
    restore(root.document);
    root.document.addEventListener('DOMContentLoaded', function () { init(root.document); });
  }
})(window);

// ==UserScript==
// @name         Azure DevOps PR: "f" opens the file-tree keyword filter
// @namespace    personal.ado.tweaks
// @version      1.2.0
// @description  On a PR's Files tab, press "f" (outside any text field) to open the toolbar "Filter results" dropdown and focus its keyword box — type a name and press Enter to filter the file tree. ADO has no inline tree-filter input; the keyword filter inside that dropdown is the native way to narrow the tree, this just makes it one keystroke. Esc closes the dropdown (native bolt behavior).
// @match        https://dev.azure.com/*
// @match        https://*.visualstudio.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/skajfes/violentmonkey-user-scripts/main/ado-filter-shortcut.user.js
// @updateURL    https://raw.githubusercontent.com/skajfes/violentmonkey-user-scripts/main/ado-filter-shortcut.user.js
// @homepageURL  https://github.com/skajfes/violentmonkey-user-scripts
// ==/UserScript==

(() => {
  const KEY = 'f';
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log('[ado-filter]', ...a); };

  // Verified against the live DOM (PR Files tab, 2026-06):
  // - The toolbar funnel is a bolt expandable button inside `.repos-compare-filter`.
  // - Clicking it renders a `.bolt-filter-callout` dropdown ("Filter results") whose
  //   header holds ONE text field — the keyword box. Typing + Enter commits the
  //   keyword and filters the file tree (the other rows: Reviewed, Comments, … are
  //   sub-menus, not text fields).
  // - Esc inside the callout closes it natively; no custom handling needed.
  const TOGGLE_SEL = '.repos-compare-filter button';
  const INPUT_SEL  = '.bolt-filter-callout input[type="text"], .bolt-filter-callout input:not([type])';

  const isEditable = (el) =>
    !!el && (
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable ||
      // Monaco diff editors take typing via a hidden textarea, but guard the
      // container too in case focus sits on the editor shell.
      !!el.closest?.('.monaco-editor')
    );

  const isVisible = (el) => !!el && el.getClientRects().length > 0;

  const findKeywordInput = () =>
    [...document.querySelectorAll(INPUT_SEL)].find(isVisible) || null;

  const focusInput = (input) => {
    input.focus();
    input.select?.();
    log('focused', input);
  };

  const activateFilter = () => {
    // Callout already open — just put the caret in the keyword box.
    const open = findKeywordInput();
    if (open) { focusInput(open); return; }

    const toggle = document.querySelector(TOGGLE_SEL);
    if (!toggle) { log('no .repos-compare-filter toggle found'); return; }
    toggle.click();

    // The callout renders async after the click — poll briefly for its input.
    // (Bolt usually focuses it on open by itself; this makes it deterministic.)
    let tries = 0;
    const poll = () => {
      const input = findKeywordInput();
      if (input) { focusInput(input); return; }
      if (++tries < 30) requestAnimationFrame(poll);
      else log('toggle clicked but callout input never appeared');
    };
    requestAnimationFrame(poll);
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== KEY || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target)) return;
    if (!/\/pullrequest\//i.test(location.pathname)) return;
    if (!document.querySelector(TOGGLE_SEL)) return; // PR page, but not the Files tab

    // Swallow the key so nothing else on the page reacts to a bare "f".
    e.preventDefault();
    e.stopImmediatePropagation();
    activateFilter();
  }, true); // capture, so ADO's own key handlers don't race us
})();

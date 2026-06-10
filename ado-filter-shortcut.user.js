// ==UserScript==
// @name         Azure DevOps: "f" focuses the file-tree filter
// @namespace    personal.ado.tweaks
// @version      1.1.0
// @description  Press "f" (outside any text field) to focus the file filter box that belongs to the file tree — PR Files tab or the repo Files hub. The filter is located by walking up from the tree element itself, so it can't grab global search or other filter boxes; ADO's own "f" handler is suppressed on tree pages. If the filter hides behind the funnel toggle, the toggle is clicked first and the input focused once it appears. Esc blurs the input again so the page gets keyboard scrolling back.
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

  const isEditable = (el) =>
    !!el && (
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable ||
      // Monaco diff editors swallow typing via a hidden textarea, but guard the
      // container too in case focus sits on the editor shell.
      !!el.closest?.('.monaco-editor')
    );

  const isVisible = (el) => !!el && el.getClientRects().length > 0;

  const hintOf = (el) =>
    `${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.title || ''}`.toLowerCase();

  // The file tree itself is the anchor: ADO renders it as a bolt tree
  // ([role="tree"] / .bolt-tree) on the PR Files tab and the repo Files hub.
  const findTree = () =>
    [...document.querySelectorAll('[role="tree"], .bolt-tree')].find(isVisible) || null;

  // Walk UP from the tree, scanning each ancestor pane for a "filter"-flavored
  // control. Nearest ancestor wins, so this can only ever find the filter that
  // belongs to the tree — never global search (its hint says "search", not
  // "filter") or filter boxes in other parts of the page (farther ancestors).
  const findNearTree = (tree, selector) => {
    for (let node = tree.parentElement; node && node !== document.body; node = node.parentElement) {
      const hit = [...node.querySelectorAll(selector)]
        .find((el) => isVisible(el) && /filter/.test(hintOf(el)));
      if (hit) return hit;
    }
    return null;
  };

  const findFilterInput = (tree) =>
    findNearTree(tree, 'input[type="text"], input[type="search"], input:not([type])');

  // The funnel button that reveals the hidden filter bar.
  const findFilterToggle = (tree) => findNearTree(tree, 'button, [role="button"]');

  let lastFocused = null;

  const focusInput = (input) => {
    input.focus();
    input.select?.();
    lastFocused = input;
    log('focused', input);
  };

  const activateFilter = (tree) => {
    const input = findFilterInput(tree);
    if (input) { focusInput(input); return; }

    const toggle = findFilterToggle(tree);
    if (!toggle) { log('no filter input or toggle found near tree'); return; }
    log('clicking toggle', toggle);
    toggle.click();

    // The filter bar renders async after the toggle — poll briefly for the input.
    let tries = 0;
    const poll = () => {
      const late = findFilterInput(tree);
      if (late) { focusInput(late); return; }
      if (++tries < 20) requestAnimationFrame(poll);
      else log('toggle clicked but no input appeared');
    };
    requestAnimationFrame(poll);
  };

  document.addEventListener('keydown', (e) => {
    // Esc inside the input we focused: blur so the page gets key events back.
    // ADO's own Esc handling (clearing the text) runs first via bubbling.
    if (e.key === 'Escape' && lastFocused && e.target === lastFocused) {
      lastFocused.blur();
      lastFocused = null;
      return;
    }

    if (e.key !== KEY || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target)) return;

    const tree = findTree();
    if (!tree) return; // no file tree on this page — leave "f" to ADO

    // Swallow the key unconditionally on tree pages so ADO's own "f" handler
    // (global search) never fires, even while the funnel-toggle poll is pending.
    e.preventDefault();
    e.stopImmediatePropagation();
    activateFilter(tree);
  }, true); // capture, so ADO's global key handlers don't race us
})();

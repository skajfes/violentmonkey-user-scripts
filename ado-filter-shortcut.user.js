// ==UserScript==
// @name         Azure DevOps PR: GitHub-style file filter
// @namespace    personal.ado.tweaks
// @version      2.0.0
// @description  Adds a filter box above the PR file tree that filters AS YOU TYPE — like GitHub's "Filter changed files". Matching narrows both the tree (folders collapse away when nothing under them matches) and the stacked diff view (non-matching file cards are hidden). Press "f" to focus the box, Esc to clear it (second Esc blurs). Matching is case-insensitive on the full path; multiple space-separated terms must all match.
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
  // - Tree rows are <tr class="bolt-tree-row"> with aria-level; folders carry
  //   aria-expanded. Rows only render filenames — full paths are reconstructed
  //   from the aria-level hierarchy (same trick as ado-reviewed-checkbox).
  // - Each stacked-view file is ONE element: .repos-summary-header is the whole
  //   bolt-card (header bar + diff). Its header bar holds the full path as a
  //   text node like "/dir/file.ext".
  // - The tree's scroll host (.vss-Splitter--pane-fixed > .absolute-fill) is a
  //   flex column, so a box prepended there pushes the tree down naturally.
  const PANE_SEL  = '.vss-Splitter--pane-fixed > .absolute-fill';
  const TREE_SEL  = '.repos-changes-explorer-tree';
  const ROW_SEL   = '.bolt-tree-row';
  const CARD_SEL  = '.repos-summary-header';
  const HIDDEN    = 'ado-tf-hidden';

  // ---- styles ------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    .${HIDDEN} { display: none !important; }

    .ado-tf-box {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      margin: 8px 8px 4px 8px;
      padding: 0 8px;
      border: 1px solid var(--palette-neutral-20, rgba(0,0,0,0.25));
      border-radius: 4px;
      background: var(--background-color, transparent);
    }
    .ado-tf-box:focus-within {
      border-color: var(--communication-background, #0078d4);
    }
    .ado-tf-box input {
      flex-grow: 1;
      min-width: 0;
      padding: 6px 0;
      border: none;
      outline: none;
      background: transparent;
      font-size: 13px;
      color: var(--text-primary-color, inherit);
    }
    .ado-tf-count {
      flex-shrink: 0;
      font-size: 11px;
      color: var(--text-secondary-color, rgba(0,0,0,0.55));
      white-space: nowrap;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ---- filtering ---------------------------------------------------------

  let query = '';
  let boxEl = null;
  let inputEl = null;
  let countEl = null;

  const cleanName = (raw) => (raw || '').trim().replace(/\s*[+\-*]+\s*$/, '').trim();

  const terms = () => query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (path, ts) => { const p = path.toLowerCase(); return ts.every((t) => p.includes(t)); };

  // Full path of a stacked diff card, read from its header bar only (the card
  // also contains the diff body, whose content lines could start with "/" too).
  const cardPath = (card) => {
    const bar = card.firstElementChild || card;
    const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT);
    let node, best = null;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue?.trim();
      if (t && t.startsWith('/') && (!best || t.length > best.length)) best = t;
    }
    return best;
  };

  const applyFilter = () => {
    const ts = terms();

    // Tree: walk rows in document order, reconstructing paths from aria-level.
    // A folder stays visible iff any file underneath it matches.
    const rows = [...document.querySelectorAll(`${TREE_SEL} ${ROW_SEL}`)];
    const folders = []; // open ancestor folders: {row, level, anyMatch}
    const names = [];
    let shown = 0, total = 0;

    const closeFoldersAtOrBelow = (level) => {
      while (folders.length && folders[folders.length - 1].level >= level) {
        const f = folders.pop();
        f.row.classList.toggle(HIDDEN, ts.length > 0 && !f.anyMatch);
      }
    };

    for (const row of rows) {
      const level = parseInt(row.getAttribute('aria-level') || '0', 10);
      if (level < 1) continue;
      closeFoldersAtOrBelow(level);
      names.length = level - 1;
      names[level - 1] = cleanName(row.textContent);
      if (row.hasAttribute('aria-expanded')) {
        folders.push({ row, level, anyMatch: false });
        continue;
      }
      total++;
      const path = '/' + names.slice(0, level).join('/');
      const ok = !ts.length || matches(path, ts);
      row.classList.toggle(HIDDEN, !ok);
      if (ok) { shown++; folders.forEach((f) => { f.anyMatch = true; }); }
    }
    closeFoldersAtOrBelow(1);

    // Stacked diff cards. Cards whose path we can't read stay visible — wrongly
    // showing a file beats silently hiding one.
    document.querySelectorAll(CARD_SEL).forEach((card) => {
      const path = cardPath(card);
      const ok = !ts.length || !path || matches(path, ts);
      card.classList.toggle(HIDDEN, !ok);
    });

    if (countEl) countEl.textContent = ts.length ? `${shown}/${total}` : '';
    log('filter applied', { query, shown, total });
  };

  // ---- filter box --------------------------------------------------------

  const ensureBox = () => {
    if (boxEl && boxEl.isConnected) return;
    const pane = document.querySelector(PANE_SEL);
    if (!pane || !pane.querySelector(TREE_SEL)) return;

    boxEl = document.createElement('div');
    boxEl.className = 'ado-tf-box';

    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = 'Filter files  (f)';
    inputEl.setAttribute('aria-label', 'Filter changed files');
    inputEl.value = query;

    countEl = document.createElement('span');
    countEl.className = 'ado-tf-count';

    inputEl.addEventListener('input', () => {
      query = inputEl.value;
      applyFilter();
    });
    inputEl.addEventListener('keydown', (e) => {
      // Keep keystrokes ours — ADO has page-level key handling.
      e.stopPropagation();
      if (e.key === 'Escape') {
        if (inputEl.value) {
          inputEl.value = '';
          query = '';
          applyFilter();
        } else {
          inputEl.blur();
        }
        e.preventDefault();
      }
    });

    boxEl.append(inputEl, countEl);
    pane.prepend(boxEl);
    if (query) applyFilter();
    log('filter box mounted');
  };

  // ---- keyboard shortcut ---------------------------------------------------

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

  document.addEventListener('keydown', (e) => {
    if (e.key !== KEY || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target)) return;
    if (!/\/pullrequest\//i.test(location.pathname)) return;
    ensureBox();
    if (!inputEl || !inputEl.isConnected) return; // not on the Files tab
    e.preventDefault();
    e.stopImmediatePropagation(); // ADO's own key handlers don't get the "f"
    inputEl.focus();
    inputEl.select();
  }, true);

  // ---- scan / observer -----------------------------------------------------

  let scanQueued = false;
  const scan = () => {
    scanQueued = false;
    ensureBox();
    // Lazy-rendered cards and re-rendered tree rows need the filter re-applied.
    if (query) applyFilter();
  };
  const queueScan = () => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  };

  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
  queueScan();
})();

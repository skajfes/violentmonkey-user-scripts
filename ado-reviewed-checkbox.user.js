// ==UserScript==
// @name         Azure DevOps PR: Reviewed checkbox on stacked diff headers
// @namespace    personal.ado.tweaks
// @version      1.0.11
// @description  Adds a "Reviewed" pill to each file header in the stacked folder-diff view. Mirrors the native file tree checkbox, and collapses/expands the file via ADO's built-in card collapse.
// @match        https://dev.azure.com/*
// @match        https://*.visualstudio.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/skajfes/violentmonkey-user-scripts/main/ado-reviewed-checkbox.user.js
// @updateURL    https://raw.githubusercontent.com/skajfes/violentmonkey-user-scripts/main/ado-reviewed-checkbox.user.js
// @homepageURL  https://github.com/skajfes/violentmonkey-user-scripts
// ==/UserScript==

(() => {
  const HEADER_SEL      = '.repos-summary-header';
  const EXPAND_BTN_SEL  = '.bolt-card-expand-button';
  const TREE_ROW_SEL    = '.bolt-tree-row';
  const TREE_CHECK_SEL  = '[role="checkbox"][aria-label="Mark as reviewed"]';
  const MARK_ATTR       = 'data-ado-reviewed-mirror';
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log('[ado-reviewed]', ...a); };

  // ---- styles ------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    .ado-rev-host {
      display: inline-flex;
      align-items: center;
      align-self: center;
      height: 100%;
    }

    .ado-rev-pill {
      --ado-rev-accent: #107c10;
      --ado-rev-fg: inherit;
      --ado-rev-bg: rgba(0,0,0,0.05);
      --ado-rev-bd: rgba(0,0,0,0.12);
      --ado-rev-hover-bg: rgba(0,0,0,0.09);

      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 4px 12px;
      padding: 8px 14px;
      border-radius: 5px;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      color: var(--ado-rev-fg);
      background: var(--ado-rev-bg);
      border: 1px solid var(--ado-rev-bd);
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    .ado-rev-pill:hover { background: var(--ado-rev-hover-bg); }
    .ado-rev-pill:focus-within {
      outline: 2px solid rgba(0,120,212,0.5);
      outline-offset: 2px;
    }

    .ado-rev-pill > input {
      position: absolute;
      width: 1px; height: 1px;
      opacity: 0; pointer-events: none;
      margin: 0;
    }

    .ado-rev-pill .ado-rev-box {
      width: 14px; height: 14px;
      border-radius: 3px;
      border: 1.5px solid currentColor;
      opacity: 0.55;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
      box-sizing: border-box;
    }
    .ado-rev-pill .ado-rev-box::after {
      content: "";
      width: 4px; height: 7px;
      border-right: 2px solid #fff;
      border-bottom: 2px solid #fff;
      transform: rotate(45deg) translate(-0.5px, -1px);
      opacity: 0;
      transition: opacity 90ms ease;
    }

    .ado-rev-pill.is-checked {
      --ado-rev-bg: rgba(16,124,16,0.14);
      --ado-rev-bd: rgba(16,124,16,0.45);
      --ado-rev-hover-bg: rgba(16,124,16,0.22);
      color: var(--ado-rev-accent);
    }
    .ado-rev-pill.is-checked .ado-rev-box {
      background: var(--ado-rev-accent);
      border-color: var(--ado-rev-accent);
      opacity: 1;
    }
    .ado-rev-pill.is-checked .ado-rev-box::after { opacity: 1; }

    @media (prefers-color-scheme: dark) {
      .ado-rev-pill {
        --ado-rev-bg: rgba(255,255,255,0.06);
        --ado-rev-bd: rgba(255,255,255,0.14);
        --ado-rev-hover-bg: rgba(255,255,255,0.11);
      }
      .ado-rev-pill.is-checked {
        --ado-rev-accent: #3fb950;
        --ado-rev-bg: rgba(63,185,80,0.16);
        --ado-rev-bd: rgba(63,185,80,0.5);
        --ado-rev-hover-bg: rgba(63,185,80,0.24);
      }
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ---- helpers -----------------------------------------------------------
  const getPath = (header) => {
    // ADO renders the file's full path in a dedicated subtitle element. For a
    // renamed file the old path sits in a separate container whose inner node
    // lacks `secondary-text`, so this selector uniquely picks the new path.
    // Targeting it avoids scraping the header text, which also contains the
    // entire diff and (for renames) the old path.
    for (const el of header.querySelectorAll('.secondary-text.text-ellipsis')) {
      const t = el.textContent?.trim();
      if (t && t.startsWith('/') && /\.[a-zA-Z0-9]+$/.test(t)) return t;
    }
    // Fallback: walk text nodes, stopping before the "Renamed from" old path.
    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
    let node, best = null;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue?.trim();
      if (!t) continue;
      if (/renamed from/i.test(t)) break;
      if (t.startsWith('/') && /\.[a-zA-Z0-9]+$/.test(t)) {
        if (!best || t.length > best.length) best = t;
      }
    }
    return best;
  };

  const buildTreeMap = () => {
    const rows = [...document.querySelectorAll(TREE_ROW_SEL)];
    const stack = [];
    const byPath = new Map();
    const byName = new Map();

    // ADO appends glyphs like "+", "-", "*" to new/changed/deleted file names in the tree.
    // Strip them so reconstructed paths match the clean header path.
    const cleanName = (raw) => (raw || '').trim().replace(/\s*[+\-*]+\s*$/, '').trim();

    for (const row of rows) {
      const level = parseInt(row.getAttribute('aria-level') || '0', 10);
      // The filename has its own span. Reading row.textContent instead would
      // glue on sibling content like the change-type pill ("rename, edit"),
      // producing "Groups.razorrename, edit" and breaking every path match.
      const nameEl = row.querySelector('.bolt-tree-cell span.text-ellipsis');
      const name = cleanName(nameEl ? nameEl.textContent : row.textContent);
      if (!name || level < 1) continue;
      stack.length = level - 1;
      stack[level - 1] = name;
      // aria-expanded can't be used to detect folders: files with comment
      // threads are expandable too (each thread is a child row). A row is a
      // file iff it carries the reviewed checkbox — folders and comment rows
      // don't have one.
      if (!row.querySelector(TREE_CHECK_SEL)) continue;
      const path = '/' + stack.slice(0, level).join('/');
      byPath.set(path, row);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(row);
    }
    return { byPath, byName };
  };

  // The tree is virtualized: an ancestor row scrolled out of the DOM leaves
  // an empty segment in the reconstructed path — treat it as a wildcard.
  const pathsMatch = (treePath, headerPath) => {
    const a = treePath.split('/');
    const b = headerPath.split('/');
    return a.length === b.length && a.every((seg, i) => seg === '' || seg === b[i]);
  };

  const findTreeRow = (headerPath, map) => {
    if (map.byPath.has(headerPath)) return map.byPath.get(headerPath);
    for (const [p, row] of map.byPath) {
      if (pathsMatch(p, headerPath) || headerPath.endsWith(p) || p.endsWith(headerPath)) return row;
    }
    const filename = headerPath.split('/').pop();
    const cands = map.byName.get(filename) || [];
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) {
      let best = cands[0], bestScore = -1;
      for (const row of cands) {
        const entry = [...map.byPath.entries()].find(([, r]) => r === row);
        if (!entry) continue;
        const segs = entry[0].split('/').filter(Boolean);
        const score = segs.reduce((s, seg) => s + (headerPath.includes(seg) ? 1 : 0), 0);
        if (score > bestScore) { bestScore = score; best = row; }
      }
      return best;
    }
    return null;
  };

  // If the given header's top got scrolled above the viewport (i.e. its
  // beginning is no longer visible), bring it back to the top edge. Re-checks
  // across a few frames so it catches ADO's collapse animation / sticky release
  // settling rather than measuring too early.
  const keepTopInView = (header) => {
    let frames = 0;
    const check = () => {
      const top = header.getBoundingClientRect().top;
      if (top < 0) {
        header.scrollIntoView({ block: 'start' });
        return;
      }
      if (++frames < 6) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  };

  // ---- mirror pill -------------------------------------------------------
  const createMirror = (treeCheckbox, card) => {
    const wrap = document.createElement('label');
    wrap.className = 'ado-rev-pill';
    wrap.setAttribute(MARK_ATTR, '1');
    wrap.title = 'Mark this file as reviewed (collapses the diff)';

    const box = document.createElement('input');
    box.type = 'checkbox';

    const visual = document.createElement('span');
    visual.className = 'ado-rev-box';

    const txt = document.createElement('span');
    txt.textContent = 'Reviewed';

    wrap.append(box, visual, txt);

    const expandBtn = card.querySelector(EXPAND_BTN_SEL);

    // One-way: reviewed-state -> collapse. We read the card's aria-expanded
    // but never *observe* it, so native collapse/expand clicks don't feed back.
    const sync = () => {
      const checked = treeCheckbox.getAttribute('aria-checked') === 'true';
      box.checked = checked;
      wrap.classList.toggle('is-checked', checked);
      if (!expandBtn) return;
      const isExpanded = expandBtn.getAttribute('aria-expanded') === 'true';
      const shouldBeExpanded = !checked;
      if (isExpanded === shouldBeExpanded) return;
      const collapsing = !shouldBeExpanded;
      expandBtn.click();
      // When collapsing a file you scrolled into the middle of, the sticky
      // header releases and the card snaps up above the viewport, dragging the
      // following files out of view. If the file's top ends up scrolled past,
      // pull it back to the top so the next files stay where the eye expects.
      if (collapsing) keepTopInView(card);
    };
    sync();

    box.addEventListener('click', (e) => {
      e.stopPropagation();
      treeCheckbox.click();
    });
    wrap.addEventListener('click', (e) => {
      if (e.target !== box) { e.preventDefault(); box.click(); }
    });

    new MutationObserver(sync).observe(treeCheckbox, {
      attributes: true, attributeFilter: ['aria-checked'],
    });

    return wrap;
  };

  // ---- injection / observer ----------------------------------------------
  const pickInjectionTarget = (header) => {
    return header.querySelector('.bolt-card-header') ||
           header.querySelector('.flex-row.flex-center') ||
           header.firstElementChild || header;
  };

  const injectInto = (header, treeMap) => {
    if (header.querySelector(`[${MARK_ATTR}]`)) return;
    const path = getPath(header);
    if (!path) { log('no path for header', header); return; }
    const row = findTreeRow(path, treeMap);
    if (!row) { log('no tree row for', path); return; }
    const cb = row.querySelector(TREE_CHECK_SEL);
    if (!cb) { log('row without checkbox', path); return; }

    const host = document.createElement('div');
    host.className = 'ado-rev-host';
    host.appendChild(createMirror(cb, header));
    pickInjectionTarget(header).appendChild(host);
    log('injected for', path);
  };

  let scanQueued = false;
  const scan = () => {
    scanQueued = false;
    const headers = document.querySelectorAll(HEADER_SEL);
    if (!headers.length) return;
    const treeMap = buildTreeMap();
    if (!treeMap.byPath.size) { log('tree map empty'); return; }
    headers.forEach(h => injectInto(h, treeMap));
  };
  const queueScan = () => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  };

  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
  queueScan();
})();

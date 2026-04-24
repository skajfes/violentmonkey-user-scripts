// ==UserScript==
// @name         Azure DevOps PR: Reviewed checkbox on stacked diff headers
// @namespace    personal.ado.tweaks
// @version      1.0.0
// @description  Adds a "Reviewed" pill to each file header in the stacked folder-diff view. Mirrors the native file tree checkbox, and collapses/expands the file via ADO's built-in card collapse.
// @match        https://dev.azure.com/*
// @match        https://*.visualstudio.com/*
// @run-at       document-idle
// @grant        none
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
      margin-left: 12px;
      padding: 3px 10px 3px 7px;
      border-radius: 999px;
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
    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
    let node, best = null;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue?.trim();
      if (!t) continue;
      if (t.startsWith('/') && /\.[a-zA-Z0-9]+$/.test(t)) {
        if (!best || t.length > best.length) best = t;
      }
    }
    if (best) return best;
    const m = header.textContent?.match(/\/[\w\-./]+\.[a-zA-Z0-9]+/);
    return m?.[0] || null;
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
      const name = cleanName(row.textContent);
      if (!name || level < 1) continue;
      stack.length = level - 1;
      stack[level - 1] = name;
      if (row.hasAttribute('aria-expanded')) continue; // folder
      const path = '/' + stack.slice(0, level).join('/');
      byPath.set(path, row);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(row);
    }
    return { byPath, byName };
  };

  const findTreeRow = (headerPath, map) => {
    if (map.byPath.has(headerPath)) return map.byPath.get(headerPath);
    for (const [p, row] of map.byPath) {
      if (headerPath === p || headerPath.endsWith(p) || p.endsWith(headerPath)) return row;
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
      if (isExpanded !== shouldBeExpanded) expandBtn.click();
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

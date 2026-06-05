// ==UserScript==
// @name         GitHub PR: File-tree viewed checkboxes + folder filter
// @namespace    personal.github.tweaks
// @version      1.1.0
// @description  In the Files Changed / Changes view, mirrors each file's native "Viewed" toggle into the file tree as a checkbox (folders get one too — it checks/unchecks all files underneath and reflects all/some/none viewed), lets you click a folder OR file in the tree to filter the diff list to just that folder's files (or that single file), and adds a "Load all files" button that scrolls through to force every lazy-rendered diff to materialise. Click the same row (or the "Clear filter" pill) to unfilter.
// @match        https://github.com/*/*/pull/*/files*
// @match        https://github.com/*/*/pull/*/changes*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/skajfes/violentmonkey-user-scripts/main/github-pr-file-tree.user.js
// @updateURL    https://raw.githubusercontent.com/skajfes/violentmonkey-user-scripts/main/github-pr-file-tree.user.js
// @homepageURL  https://github.com/skajfes/violentmonkey-user-scripts
// ==/UserScript==

(() => {
  const DEBUG = false;
  const log  = (...a) => { if (DEBUG) console.log('[gh-pr-tree]', ...a); };
  const warn = (...a) => { if (DEBUG) console.warn('[gh-pr-tree]', ...a); };

  const BOUND_ATTR    = 'data-ghpt-bound';
  const VIEWED_ATTR   = 'data-ghpt-viewed';
  const FILTER_CLASS  = 'ghpt-folder-filtered';
  const HIDDEN_CLASS  = 'ghpt-file-hidden';

  // ---- styles ------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    .ghpt-tree-checkbox {
      appearance: none;
      -webkit-appearance: none;
      width: 14px; height: 14px;
      flex-shrink: 0;
      border: 1.5px solid var(--fgColor-muted, #656d76);
      border-radius: 3px;
      background: var(--bgColor-default, #ffffff);
      cursor: pointer;
      box-sizing: border-box;
      transition: background 100ms ease, border-color 100ms ease;
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 5;
      margin: 0;
    }
    .ghpt-tree-checkbox:hover {
      border-color: var(--fgColor-default, #1f2328);
    }
    .ghpt-tree-checkbox:checked {
      background: var(--bgColor-success-emphasis, #1f883d);
      border-color: var(--bgColor-success-emphasis, #1f883d);
    }
    .ghpt-tree-checkbox:checked::after {
      content: "";
      position: absolute;
      left: 3px; top: 0px;
      width: 3px; height: 7px;
      border-right: 2px solid #fff;
      border-bottom: 2px solid #fff;
      transform: rotate(45deg);
    }
    .ghpt-tree-checkbox:indeterminate {
      background: var(--bgColor-success-emphasis, #1f883d);
      border-color: var(--bgColor-success-emphasis, #1f883d);
    }
    .ghpt-tree-checkbox:indeterminate::after {
      content: "";
      position: absolute;
      left: 2px; top: 4.5px;
      width: 7px; height: 2px;
      background: #fff;
    }

    [role="treeitem"][${VIEWED_ATTR}="true"] {
      opacity: 0.55;
    }
    [role="treeitem"][${VIEWED_ATTR}="true"]:hover {
      opacity: 0.9;
    }

    [role="treeitem"].${FILTER_CLASS} > *:first-child,
    [role="treeitem"].${FILTER_CLASS} {
      background: var(--bgColor-accent-muted, rgba(9,105,218,0.15)) !important;
      border-radius: 6px;
    }

    .ghpt-filter-pill {
      position: sticky;
      top: 0;
      z-index: 50;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 12px 0;
      padding: 6px 12px;
      background: var(--bgColor-accent-muted, rgba(9,105,218,0.15));
      border: 1px solid var(--borderColor-accent-muted, rgba(9,105,218,0.4));
      color: var(--fgColor-accent, #0969da);
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      width: fit-content;
    }
    .ghpt-filter-pill button {
      appearance: none;
      border: none;
      background: transparent;
      cursor: pointer;
      color: inherit;
      padding: 0;
      font: inherit;
      text-decoration: underline;
    }
    .${HIDDEN_CLASS} { display: none !important; }

    .ghpt-load-all-btn {
      appearance: none;
      cursor: pointer;
      padding: 4px 10px;
      margin: 0 0 0 8px;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.5;
      border-radius: 6px;
      border: 1px solid var(--borderColor-default, rgba(31,35,40,0.15));
      background: var(--bgColor-default, #f6f8fa);
      color: var(--fgColor-default, #1f2328);
      white-space: nowrap;
      transition: background 100ms ease, border-color 100ms ease;
    }
    .ghpt-load-all-btn:hover {
      background: var(--bgColor-muted, #eaeef2);
      border-color: var(--borderColor-muted, rgba(31,35,40,0.25));
    }
    .ghpt-load-all-btn:disabled {
      cursor: progress;
      opacity: 0.7;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ---- DOM helpers -------------------------------------------------------

  const isFolder = (item) => item.hasAttribute('aria-expanded');

  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    // Try common GitHub Primer treeview content slots
    const span = el.querySelector(
      '.PRIVATE_TreeView-item-content-text, ' +
      '[data-testid="treeview-item-content-text"], ' +
      '.ActionList-item-label, ' +
      '.PRIVATE_TreeView-item-content'
    );
    if (span) return span.textContent.trim();
    return (el.textContent || '').trim().split('\n')[0];
  };

  const getDiffIdFromTreeItem = (item) => {
    // Scope to the row's OWN content (the new Primer tree is nested — folder LIs
    // contain children LIs, so an unscoped querySelector would return a descendant's
    // anchor instead of the row's own).
    const own = item.querySelector(':scope > .PRIVATE_TreeView-item-container') || item;
    const a = own.matches('a[href*="#diff-"]') ? own : own.querySelector('a[href*="#diff-"]');
    if (!a) return null;
    const m = a.getAttribute('href').match(/#(diff-[a-f0-9]+)/);
    return m ? m[1] : null;
  };

  const findFileContainer = (diffId) => document.getElementById(diffId);

  // GitHub's new "Changes" view replaced the <input name="viewed"> checkbox with a
  // <button aria-label="Not Viewed"> / aria-label="Viewed" toggle. State is encoded
  // in aria-label; toggling means .click().
  const findViewedButton = (diffId) => {
    const container = findFileContainer(diffId);
    if (!container) return null;
    return container.querySelector(
      'button[aria-label="Not Viewed"], ' +
      'button[aria-label="Viewed"], ' +
      'input[name="viewed"]'                       // classic view fallback
    );
  };

  const isToggleViewed = (toggle) => {
    if (!toggle) return false;
    if (toggle.tagName === 'INPUT') return toggle.checked;
    return toggle.getAttribute('aria-label') === 'Viewed';
  };

  const allTreeItems = () => [...document.querySelectorAll('[role="treeitem"]')];

  // For a folder treeitem, collect descendant file diff IDs.
  // Tree is rendered as a flat list of treeitems; descendants are items at deeper aria-level
  // that follow until we hit an item at the folder's level or shallower.
  const collectFolderDescendantDiffIds = (folderItem) => {
    // New tree nests children inside the folder LI, so a subtree querySelectorAll
    // picks up every descendant file anchor regardless of expansion state.
    const ids = new Set();
    folderItem.querySelectorAll('a[href*="#diff-"]').forEach((a) => {
      const m = a.getAttribute('href').match(/#(diff-[a-f0-9]+)/);
      if (m) ids.add(m[1]);
    });
    return [...ids];
  };

  const folderPathLabel = (item) => {
    const items = allTreeItems();
    const idx = items.indexOf(item);
    const myLevel = parseInt(item.getAttribute('aria-level') || '1', 10);
    const parts = [labelOf(item)];
    let needLevel = myLevel - 1;
    for (let i = idx - 1; i >= 0 && needLevel >= 1; i--) {
      const lvl = parseInt(items[i].getAttribute('aria-level') || '1', 10);
      if (lvl === needLevel && isFolder(items[i])) {
        parts.unshift(labelOf(items[i]));
        needLevel--;
      }
    }
    return parts.join('/');
  };

  // ---- viewed-state mirror ----------------------------------------------

  const ownCheckbox = (item) =>
    item.querySelector(':scope > .PRIVATE_TreeView-item-container > .ghpt-tree-checkbox');

  // Folder checkbox state is derived from descendant FILE treeitems' VIEWED_ATTR
  // (set by each file's sync). Files whose diff hasn't rendered yet have no attr
  // and count as not-viewed, so the folder can't claim "all viewed" prematurely.
  const syncFolderCheckbox = (folderItem) => {
    const cb = ownCheckbox(folderItem);
    if (!cb) return;
    const files = [...folderItem.querySelectorAll('[role="treeitem"]')].filter((it) => !isFolder(it));
    const viewed = files.filter((it) => it.getAttribute(VIEWED_ATTR) === 'true').length;
    cb.checked = files.length > 0 && viewed === files.length;
    cb.indeterminate = viewed > 0 && viewed < files.length;
  };

  let folderSyncQueued = false;
  const queueFolderSync = () => {
    if (folderSyncQueued) return;
    folderSyncQueued = true;
    requestAnimationFrame(() => {
      folderSyncQueued = false;
      allTreeItems().filter(isFolder).forEach(syncFolderCheckbox);
    });
  };

  const injectFolderCheckbox = (item) => {
    if (ownCheckbox(item)) return;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'ghpt-tree-checkbox';
    cb.title = 'Mark all files in this folder as viewed';

    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const desired = cb.checked;
      collectFolderDescendantDiffIds(item).forEach((diffId) => {
        const toggle = findViewedButton(diffId);
        // Unrendered diffs have no toggle to click — the folder sync below will
        // pull the checkbox back to partial/unchecked so state stays honest.
        if (toggle && isToggleViewed(toggle) !== desired) toggle.click();
      });
      queueFolderSync();
    });

    const container = item.querySelector(':scope > .PRIVATE_TreeView-item-container') || item;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(cb);
    syncFolderCheckbox(item);
  };

  const injectCheckbox = (item) => {
    if (ownCheckbox(item)) return;
    const diffId = getDiffIdFromTreeItem(item);
    if (!diffId) return;
    const toggle = findViewedButton(diffId);
    if (!toggle) {
      // The file diff hasn't been rendered yet (GitHub lazy-loads progressive diffs).
      // Retry on the next observer tick.
      return;
    }

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'ghpt-tree-checkbox';
    cb.title = 'Mark this file as viewed';

    // Stop tree-row click handler (folder-filter or native expand) from firing.
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      // Toggle the native control. For the new <button>, .click() flips state and
      // triggers the server POST. For the classic <input>, .click() does the same.
      if (isToggleViewed(toggle) !== cb.checked) toggle.click();
    });

    const sync = () => {
      const viewed = isToggleViewed(toggle);
      cb.checked = viewed;
      item.setAttribute(VIEWED_ATTR, viewed ? 'true' : 'false');
      // Any file flip can change an ancestor folder's all/some/none state.
      queueFolderSync();
    };
    sync();

    // New view: state lives in aria-label. Classic view: in checked / aria-checked.
    new MutationObserver(sync).observe(toggle, {
      attributes: true,
      attributeFilter: ['aria-label', 'aria-pressed', 'checked', 'aria-checked', 'data-checked'],
    });
    toggle.addEventListener('change', sync);
    toggle.addEventListener('click', () => requestAnimationFrame(sync));

    // Absolute-position the checkbox at the right edge of the row. Primer's grid
    // template doesn't reserve a slot we can hijack reliably, so we sidestep it.
    const container = item.querySelector(':scope > .PRIVATE_TreeView-item-container') || item;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(cb);
    log('mirrored viewed for', diffId);
  };

  // ---- folder filter -----------------------------------------------------

  // activeRow can be a folder treeitem (filter = all its descendant files) OR a
  // file treeitem (filter = just that one file).
  let activeRow = null;
  let activeIds = null;
  let pillEl = null;

  const collectRowDiffIds = (item) => {
    if (isFolder(item)) return collectFolderDescendantDiffIds(item);
    const id = getDiffIdFromTreeItem(item);
    return id ? [id] : [];
  };

  const ensurePill = () => {
    if (pillEl) return pillEl;
    pillEl = document.createElement('div');
    pillEl.className = 'ghpt-filter-pill';
    const txt = document.createElement('span');
    txt.className = 'ghpt-filter-pill-text';
    pillEl.appendChild(txt);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear filter';
    clear.addEventListener('click', clearFilter);
    pillEl.appendChild(clear);
    return pillEl;
  };

  const placePill = () => {
    const pill = ensurePill();
    const host = document.querySelector(
      '#diff-comparison-viewer-container, ' +
      '.js-diff-progressive-container, ' +
      '#files, ' +
      '[data-testid="diff-file-list"]'
    );
    if (host && pill.parentNode !== host) host.insertBefore(pill, host.firstChild);
  };

  // Match real file diff containers only (id like "diff-<long-hex>"), not wrappers
  // such as "diff-comparison-viewer-container" or "diff-file-tree-filter".
  const DIFF_ID_RE = /^diff-[a-f0-9]{20,}$/;

  const applyFilter = () => {
    const ids = activeIds ? new Set(activeIds) : null;
    document.querySelectorAll('[id^="diff-"]').forEach((el) => {
      if (!DIFF_ID_RE.test(el.id)) return;
      // Hide the per-file FLEX SHELL, not just the inner diff. The shell sits inside
      // a `d-flex flex-column gap-3` parent; even when the inner is display:none, the
      // shell still counts as a flex item, so the parent renders its `gap-3` (~16px)
      // between every consecutive hidden shell. With dozens of hidden files that
      // stacks into hundreds of pixels of empty space above the visible diffs.
      const shell = el.closest('[class*="diffEntry" i], [class*="DiffEntry" i]') || el;
      if (!ids) { shell.classList.remove(HIDDEN_CLASS); return; }
      shell.classList.toggle(HIDDEN_CLASS, !ids.has(el.id));
    });
  };

  const setFilter = (item) => {
    if (activeRow === item) { clearFilter(); return; }
    if (activeRow) activeRow.classList.remove(FILTER_CLASS);
    activeRow = item;
    activeIds = collectRowDiffIds(item);
    item.classList.add(FILTER_CLASS);
    placePill();
    pillEl.querySelector('.ghpt-filter-pill-text').textContent =
      `Filtered to ${folderPathLabel(item)} (${activeIds.length} file${activeIds.length === 1 ? '' : 's'})`;
    applyFilter();
    log('filter on', folderPathLabel(item), activeIds);
  };

  function clearFilter() {
    if (activeRow) activeRow.classList.remove(FILTER_CLASS);
    activeRow = null;
    activeIds = null;
    pillEl?.remove();
    pillEl = null;
    applyFilter();
    log('filter cleared');
  }

  // ---- tree row click binding -------------------------------------------

  const bindRow = (item) => {
    if (item.getAttribute(BOUND_ATTR) === '1') return;
    item.setAttribute(BOUND_ATTR, '1');

    item.addEventListener('click', (e) => {
      // Capture-phase fires on every ancestor LI. Make sure the click actually
      // targets THIS row, not a nested treeitem inside it (otherwise clicking a
      // subfolder would filter the outermost ancestor instead).
      const t = e.target;
      const targetItem = t.closest('[role="treeitem"]');
      if (targetItem !== item) return;
      // Let our own checkbox handle itself
      if (t.closest('.ghpt-tree-checkbox')) return;
      // Let the chevron toggle expand/collapse natively
      if (t.closest('.PRIVATE_TreeView-item-toggle, .octicon-chevron-right, .octicon-chevron-down, [data-testid*="chevron"], [aria-label="Expand"], [aria-label="Collapse"]')) return;

      if (isFolder(item)) {
        // Folder rows have no native navigation we want to keep — swallow it.
        e.preventDefault();
        e.stopPropagation();
        setFilter(item);
      } else {
        // File rows have an anchor that scrolls to the diff; let that proceed
        // so the (now sole visible) diff stays scrolled into view.
        setFilter(item);
      }
    }, true); // capture so we run before React's row handler
  };

  // ---- "Load all files" button ------------------------------------------

  let loadAllBtn = null;
  let loadAllInFlight = false;

  const ensureLoadAllButton = () => {
    if (loadAllBtn && loadAllBtn.isConnected) return;
    // Prefer the tree filter row (sits above the file tree). Fall back to the diff
    // viewer container so the button still appears even if the filter row moves.
    const host = document.querySelector('#diff-file-tree-filter')
              || document.querySelector('#diff-comparison-viewer-container');
    if (!host) return;

    loadAllBtn = document.createElement('button');
    loadAllBtn.type = 'button';
    loadAllBtn.className = 'ghpt-load-all-btn';
    loadAllBtn.textContent = 'Load all files';
    loadAllBtn.title = 'Scroll through the PR to force every lazy-rendered diff to materialise';
    loadAllBtn.addEventListener('click', runLoadAll);

    if (host.id === 'diff-file-tree-filter') host.appendChild(loadAllBtn);
    else host.insertBefore(loadAllBtn, host.firstChild);
  };

  async function runLoadAll() {
    if (loadAllInFlight || !loadAllBtn) return;
    loadAllInFlight = true;
    const btn = loadAllBtn;
    const originalLabel = btn.textContent;
    btn.disabled = true;

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const fileEls = () => [...document.querySelectorAll('[id^="diff-"]')].filter((e) => DIFF_ID_RE.test(e.id));
    const totalFiles = () => fileEls().length;
    // "Rendered" = the per-file Viewed toggle exists. If the diff is still a
    // placeholder skeleton, the button isn't there yet.
    const renderedFiles = () => fileEls().filter((e) =>
      e.querySelector('button[aria-label="Viewed"], button[aria-label="Not Viewed"]')
    ).length;

    const clickLoadDiffs = () => {
      let n = 0;
      document.querySelectorAll('button').forEach((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t === 'load diff' || t.startsWith('load diff') || t === 'show diff' || t === 'display the rich diff') {
          b.click();
          n++;
        }
      });
      return n;
    };

    const scroller = document.scrollingElement || document.documentElement;
    const maxScroll = () => scroller.scrollHeight - scroller.clientHeight;
    const initialTop = scroller.scrollTop;

    let stable = 0;
    let step = 0;
    try {
      while (stable < 4 && step < 400) {
        const beforeRendered = renderedFiles();
        const beforeTop = scroller.scrollTop;
        scroller.scrollTo({
          top: Math.min(beforeTop + scroller.clientHeight * 0.85, maxScroll()),
        });
        await wait(300);
        const clicked = clickLoadDiffs();
        if (clicked) await wait(400);

        const r = renderedFiles();
        const atBottom = scroller.scrollTop >= maxScroll() - 1;
        const noProgress = r === beforeRendered && scroller.scrollTop === beforeTop;
        stable = atBottom && noProgress ? stable + 1 : 0;

        btn.textContent = `Loading… ${r}/${totalFiles()}`;
        step++;
      }
    } finally {
      scroller.scrollTo({ top: initialTop, behavior: 'instant' });
      btn.textContent = `Loaded ${renderedFiles()}/${totalFiles()}`;
      setTimeout(() => {
        btn.textContent = originalLabel;
        btn.disabled = false;
      }, 2000);
      loadAllInFlight = false;
      // Newly rendered files have viewed-buttons now — let the scan inject checkboxes.
      queueScan();
    }
  }

  // ---- scan / observer ---------------------------------------------------

  let scanQueued = false;
  const scan = () => {
    scanQueued = false;
    ensureLoadAllButton();
    const items = allTreeItems();
    if (!items.length) { warn('no treeitems found'); return; }
    items.forEach((item) => {
      bindRow(item);
      if (isFolder(item)) injectFolderCheckbox(item);
      else injectCheckbox(item);
    });
    queueFolderSync();
    if (activeRow && !activeRow.isConnected) {
      // Tree re-rendered and our row ref is stale. Drop filter.
      clearFilter();
    } else if (activeRow) {
      activeIds = collectRowDiffIds(activeRow);
      applyFilter();
      placePill();
    }
  };
  const queueScan = () => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  };

  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('turbo:render', queueScan);
  window.addEventListener('soft-nav:end', queueScan);
  queueScan();
})();

// ==UserScript==
// @name         GitHub PR: File-tree viewed checkboxes + folder filter
// @namespace    personal.github.tweaks
// @version      1.0.1
// @description  In the Files Changed / Changes view, mirrors each file's native "Viewed" toggle into the file tree as a checkbox, and lets you click a folder in the tree to filter the diff list to just that folder's files. Click the same folder (or the "Clear filter" pill) to unfilter.
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
      width: 13px; height: 13px;
      margin: 0 6px 0 2px;
      flex-shrink: 0;
      border: 1.5px solid var(--fgColor-muted, #656d76);
      border-radius: 3px;
      background: transparent;
      cursor: pointer;
      vertical-align: middle;
      position: relative;
      box-sizing: border-box;
      transition: background 100ms ease, border-color 100ms ease;
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
    // The file row usually wraps an anchor like #diff-<sha>
    const a = item.matches('a[href*="#diff-"]')
      ? item
      : item.querySelector('a[href*="#diff-"]');
    if (!a) return null;
    const m = a.getAttribute('href').match(/#(diff-[a-f0-9]+)/);
    return m ? m[1] : null;
  };

  const findFileContainer = (diffId) => {
    // The diff anchor target is the file container itself or its header.
    let el = document.getElementById(diffId);
    if (!el) el = document.querySelector(`[data-details-container-for-id="${diffId}"]`);
    if (!el) return null;
    // Walk up to the .file/.js-file wrapper (which is what gets hidden when filtered)
    return el.closest('.file, .js-file, copilot-diff-entry, [data-tagsearch-path]') || el;
  };

  const findNativeViewedCheckbox = (diffId) => {
    const container = findFileContainer(diffId);
    if (!container) return null;
    return container.querySelector(
      'input[name="viewed"], ' +
      'input.js-reviewed-checkbox, ' +
      'input[data-testid="viewed-checkbox"]'
    );
  };

  const allTreeItems = () => [...document.querySelectorAll('[role="treeitem"]')];

  // For a folder treeitem, collect descendant file diff IDs.
  // Tree is rendered as a flat list of treeitems; descendants are items at deeper aria-level
  // that follow until we hit an item at the folder's level or shallower.
  const collectFolderDescendantDiffIds = (folderItem) => {
    const items = allTreeItems();
    const idx = items.indexOf(folderItem);
    if (idx === -1) return [];
    const baseLevel = parseInt(folderItem.getAttribute('aria-level') || '1', 10);
    const ids = [];
    for (let i = idx + 1; i < items.length; i++) {
      const lvl = parseInt(items[i].getAttribute('aria-level') || '1', 10);
      if (lvl <= baseLevel) break;
      if (!isFolder(items[i])) {
        const id = getDiffIdFromTreeItem(items[i]);
        if (id) ids.push(id);
      }
    }
    return ids;
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

  const injectCheckbox = (item) => {
    if (item.querySelector('.ghpt-tree-checkbox')) return;
    const diffId = getDiffIdFromTreeItem(item);
    if (!diffId) return;
    const native = findNativeViewedCheckbox(diffId);
    if (!native) {
      // The file diff hasn't been rendered yet (GitHub lazy-loads progressive diffs).
      // We'll retry on the next observer tick.
      return;
    }

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'ghpt-tree-checkbox';
    cb.title = 'Mark this file as viewed';

    // Prevent the tree row's click handler (folder-filter or native expand) from firing.
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      // Drive GitHub's native checkbox via .click() so the form-submit-on-change fires
      // and the viewed state persists server-side.
      if (native.checked !== cb.checked) native.click();
    });

    const sync = () => {
      cb.checked = native.checked;
      item.setAttribute(VIEWED_ATTR, native.checked ? 'true' : 'false');
    };
    sync();

    // GitHub flips .checked on response; both attribute and `change` event tend to fire.
    new MutationObserver(sync).observe(native, {
      attributes: true,
      attributeFilter: ['checked', 'aria-checked', 'data-checked'],
    });
    native.addEventListener('change', sync);

    // Inject as the first child of the row's inner clickable region so it sits
    // before the file icon/name.
    const inner = item.querySelector(
      'a, ' +
      '[data-testid="file-tree-item-content"], ' +
      '.PRIVATE_TreeView-item-content, ' +
      '.ActionList-content'
    ) || item;
    inner.insertBefore(cb, inner.firstChild);
    log('mirrored viewed for', diffId);
  };

  // ---- folder filter -----------------------------------------------------

  let activeFolder = null;
  let activeIds = null;
  let pillEl = null;

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
      '.js-diff-progressive-container, ' +
      '#files, ' +
      '[data-testid="diff-file-list"]'
    );
    if (host && pill.parentNode !== host) host.insertBefore(pill, host.firstChild);
  };

  const applyFilter = () => {
    const ids = activeIds ? new Set(activeIds) : null;
    // .file and .js-file are the classic markers. copilot-diff-entry is the newer one.
    const files = document.querySelectorAll('.file, .js-file, copilot-diff-entry, [data-details-container-for-id^="diff-"]');
    files.forEach((f) => {
      const id = f.id || f.getAttribute('data-details-container-for-id') || '';
      const diffId = id.startsWith('diff-') ? id : (f.querySelector('[id^="diff-"]')?.id || '');
      if (!ids) { f.classList.remove(HIDDEN_CLASS); return; }
      f.classList.toggle(HIDDEN_CLASS, !ids.has(diffId));
    });
  };

  const setFilter = (folderItem) => {
    if (activeFolder === folderItem) { clearFilter(); return; }
    if (activeFolder) activeFolder.classList.remove(FILTER_CLASS);
    activeFolder = folderItem;
    activeIds = collectFolderDescendantDiffIds(folderItem);
    folderItem.classList.add(FILTER_CLASS);
    placePill();
    pillEl.querySelector('.ghpt-filter-pill-text').textContent =
      `Filtered to ${folderPathLabel(folderItem)} (${activeIds.length} file${activeIds.length === 1 ? '' : 's'})`;
    applyFilter();
    log('filter on', folderPathLabel(folderItem), activeIds);
  };

  function clearFilter() {
    if (activeFolder) activeFolder.classList.remove(FILTER_CLASS);
    activeFolder = null;
    activeIds = null;
    pillEl?.remove();
    pillEl = null;
    applyFilter();
    log('filter cleared');
  }

  // ---- tree row click binding -------------------------------------------

  const bindFolder = (item) => {
    if (item.getAttribute(BOUND_ATTR) === '1') return;
    item.setAttribute(BOUND_ATTR, '1');

    item.addEventListener('click', (e) => {
      if (!isFolder(item)) return;
      const t = e.target;
      // Let our own checkbox handle itself
      if (t.closest('.ghpt-tree-checkbox')) return;
      // Let the chevron toggle expand/collapse natively
      if (t.closest('.octicon-chevron-right, .octicon-chevron-down, [data-testid*="chevron"], [aria-label="Expand"], [aria-label="Collapse"]')) return;
      e.preventDefault();
      e.stopPropagation();
      setFilter(item);
    }, true); // capture so we run before React's row handler
  };

  // ---- scan / observer ---------------------------------------------------

  let scanQueued = false;
  const scan = () => {
    scanQueued = false;
    const items = allTreeItems();
    if (!items.length) { warn('no treeitems found'); return; }
    items.forEach((item) => {
      if (isFolder(item)) bindFolder(item);
      else injectCheckbox(item);
    });
    if (activeFolder && !activeFolder.isConnected) {
      // Tree re-rendered and our folder ref is stale. Drop filter.
      clearFilter();
    } else if (activeFolder) {
      activeIds = collectFolderDescendantDiffIds(activeFolder);
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

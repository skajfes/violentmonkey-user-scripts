// ==UserScript==
// @name         GitHub PR: File-tree viewed checkboxes + folder filter
// @namespace    personal.github.tweaks
// @version      1.0.2
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

  const injectCheckbox = (item) => {
    if (item.querySelector(':scope > .PRIVATE_TreeView-item-container .ghpt-tree-checkbox')) return;
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
    };
    sync();

    // New view: state lives in aria-label. Classic view: in checked / aria-checked.
    new MutationObserver(sync).observe(toggle, {
      attributes: true,
      attributeFilter: ['aria-label', 'aria-pressed', 'checked', 'aria-checked', 'data-checked'],
    });
    toggle.addEventListener('change', sync);
    toggle.addEventListener('click', () => requestAnimationFrame(sync));

    // The new Primer treeitem uses CSS grid. Place the checkbox in the leadingVisual
    // slot so it sits between the chevron and the file name without breaking layout.
    const container = item.querySelector(':scope > .PRIVATE_TreeView-item-container') || item;
    let leading = container.querySelector(':scope > .PRIVATE_TreeView-item-leadingVisual, :scope > [data-component="leadingVisual"]');
    if (!leading) {
      leading = document.createElement('div');
      leading.className = 'PRIVATE_TreeView-item-leadingVisual';
      leading.style.cssText = 'grid-area: leadingVisual; display: flex; align-items: center;';
      container.appendChild(leading);
    }
    leading.insertBefore(cb, leading.firstChild);
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
      if (!ids) { el.classList.remove(HIDDEN_CLASS); return; }
      el.classList.toggle(HIDDEN_CLASS, !ids.has(el.id));
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
      if (t.closest('.PRIVATE_TreeView-item-toggle, .octicon-chevron-right, .octicon-chevron-down, [data-testid*="chevron"], [aria-label="Expand"], [aria-label="Collapse"]')) return;
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

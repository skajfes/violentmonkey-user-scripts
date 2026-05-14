// ==UserScript==
// @name         Azure DevOps PR: Stacked diff syntax highlighting
// @namespace    personal.ado.tweaks
// @version      1.0.2
// @description  Adds client-side syntax highlighting (via highlight.js) to the stacked folder-diff view, which ADO renders as plain HTML without any tokenization.
// @match        https://dev.azure.com/*
// @match        https://*.visualstudio.com/*
// @run-at       document-idle
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js
// @downloadURL  https://raw.githubusercontent.com/skajfes/violentmonkey-user-scripts/main/ado-stacked-syntax.user.js
// @updateURL    https://raw.githubusercontent.com/skajfes/violentmonkey-user-scripts/main/ado-stacked-syntax.user.js
// @homepageURL  https://github.com/skajfes/violentmonkey-user-scripts
// ==/UserScript==

(() => {
  if (typeof hljs === 'undefined') {
    console.warn('[ado-syntax] highlight.js not loaded');
    return;
  }

  const PROCESSED = 'data-ado-hl';
  const LANG_ATTR = 'data-ado-lang';
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log('[ado-syntax]', ...a); };

  const extToLang = {
    cs: 'csharp',
    razor: 'csharp',     // highlight.js has no razor grammar; csharp handles @code/@if blocks
    cshtml: 'csharp',
    xml: 'xml', resx: 'xml', csproj: 'xml', xaml: 'xml', config: 'xml',
    html: 'xml', svg: 'xml', xhtml: 'xml',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    json: 'json',
    css: 'css', scss: 'scss',
    yml: 'yaml', yaml: 'yaml',
    md: 'markdown',
    py: 'python',
    sh: 'bash', bash: 'bash',
    sql: 'sql',
  };

  // VS Code Light+ palette (default) with Dark+ fallback for prefers-color-scheme: dark
  const style = document.createElement('style');
  style.textContent = `
    .repos-line-content .hljs-keyword,
    .repos-line-content .hljs-tag,
    .repos-line-content .hljs-name,
    .repos-line-content .hljs-literal,
    .repos-line-content .hljs-selector-tag { color: #0000ff; }

    .repos-line-content .hljs-built_in,
    .repos-line-content .hljs-type,
    .repos-line-content .hljs-class > .hljs-title,
    .repos-line-content .hljs-title.class_ { color: #267f99; }

    .repos-line-content .hljs-title,
    .repos-line-content .hljs-title.function_ { color: #795e26; }

    .repos-line-content .hljs-string,
    .repos-line-content .hljs-meta-string { color: #a31515; }

    .repos-line-content .hljs-number { color: #098658; }

    .repos-line-content .hljs-comment,
    .repos-line-content .hljs-quote { color: #008000; font-style: italic; }

    .repos-line-content .hljs-variable,
    .repos-line-content .hljs-attr,
    .repos-line-content .hljs-params,
    .repos-line-content .hljs-property,
    .repos-line-content .hljs-template-variable { color: #001080; }

    .repos-line-content .hljs-meta,
    .repos-line-content .hljs-meta-keyword,
    .repos-line-content .hljs-doctag { color: #af00db; }

    .repos-line-content .hljs-regexp,
    .repos-line-content .hljs-symbol,
    .repos-line-content .hljs-link { color: #811f3f; }

    .repos-line-content .hljs-operator,
    .repos-line-content .hljs-punctuation { color: inherit; }

    @media (prefers-color-scheme: dark) {
      .repos-line-content .hljs-keyword,
      .repos-line-content .hljs-tag,
      .repos-line-content .hljs-name,
      .repos-line-content .hljs-literal,
      .repos-line-content .hljs-selector-tag { color: #569cd6; }

      .repos-line-content .hljs-built_in,
      .repos-line-content .hljs-type,
      .repos-line-content .hljs-class > .hljs-title,
      .repos-line-content .hljs-title.class_ { color: #4ec9b0; }

      .repos-line-content .hljs-title,
      .repos-line-content .hljs-title.function_ { color: #dcdcaa; }

      .repos-line-content .hljs-string,
      .repos-line-content .hljs-meta-string { color: #ce9178; }

      .repos-line-content .hljs-number { color: #b5cea8; }

      .repos-line-content .hljs-comment,
      .repos-line-content .hljs-quote { color: #6a9955; font-style: italic; }

      .repos-line-content .hljs-variable,
      .repos-line-content .hljs-attr,
      .repos-line-content .hljs-params,
      .repos-line-content .hljs-property,
      .repos-line-content .hljs-template-variable { color: #9cdcfe; }

      .repos-line-content .hljs-meta,
      .repos-line-content .hljs-meta-keyword,
      .repos-line-content .hljs-doctag { color: #c586c0; }

      .repos-line-content .hljs-regexp,
      .repos-line-content .hljs-symbol,
      .repos-line-content .hljs-link { color: #d16969; }
    }
  `;
  (document.head || document.documentElement).appendChild(style);

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
    return best;
  };

  const detectLang = (header) => {
    const path = getPath(header);
    if (!path) return null;
    const ext = path.split('.').pop().toLowerCase();
    const lang = extToLang[ext];
    if (!lang) return null;
    return hljs.getLanguage(lang) ? lang : null;
  };

  const highlightLine = (span, lang) => {
    if (span.hasAttribute(PROCESSED)) return;
    span.setAttribute(PROCESSED, '1');

    // Remove screen-reader-only spans (e.g. "Plus"/"Minus" line prefixes) before
    // highlighting so they don't leak into the code stream. We'll put them back.
    const srNodes = [...span.querySelectorAll('.screen-reader-only')];
    srNodes.forEach(n => n.remove());

    const codeText = span.textContent;
    if (!codeText || !codeText.trim()) {
      srNodes.forEach(n => span.insertBefore(n, span.firstChild));
      return;
    }

    try {
      const result = hljs.highlight(codeText, { language: lang, ignoreIllegals: true });
      span.innerHTML = result.value;
      for (let i = srNodes.length - 1; i >= 0; i--) {
        span.insertBefore(srNodes[i], span.firstChild);
      }
    } catch (e) {
      log('highlight error', e, { codeText });
    }
  };

  const processHeader = (header) => {
    let lang = header.getAttribute(LANG_ATTR);
    if (!lang) {
      const detected = detectLang(header);
      lang = detected || 'none';
      header.setAttribute(LANG_ATTR, lang);
      log('lang for', getPath(header), '=>', lang);
    }
    if (lang === 'none') return;
    header.querySelectorAll('.repos-line-content').forEach(line => highlightLine(line, lang));
  };

  // Skip anything inside a Monaco editor — those surfaces are React-owned and
  // mutating their DOM breaks reconciliation (e.g. comment threads on diffs).
  const inMonaco = (el) => !!el.closest('.monaco-editor');

  let queued = false;
  const queueScan = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      document.querySelectorAll('.repos-summary-header').forEach(header => {
        if (inMonaco(header)) return;
        processHeader(header);
      });
    });
  };

  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
  queueScan();
})();

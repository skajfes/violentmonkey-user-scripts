// ==UserScript==
// @name         Azure DevOps PR: font + Razor highlighting
// @namespace    personal.ado.tweaks
// @version      1.0.2
// @description  JetBrains Mono font in Monaco, plus Razor/Blazor syntax highlighting for .razor/.cshtml files in the PR diff viewer.
// @match        https://dev.azure.com/*
// @match        https://*.visualstudio.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/skajfes/violentmonkey-user-scripts/main/ado-razor-highlight.user.js
// @updateURL    https://raw.githubusercontent.com/skajfes/violentmonkey-user-scripts/main/ado-razor-highlight.user.js
// @homepageURL  https://github.com/skajfes/violentmonkey-user-scripts
// ==/UserScript==

(() => {
  const FONT = `'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace`;
  const SIZE = 14;
  const LINE_HEIGHT = 24;

  // Non-Monaco code blocks (PR descriptions, comments), plus a font-family
  // fallback for Monaco itself. The API-based applyFont() is preferred (it lets
  // Monaco re-measure), but if our bootstrap misses an editor (created before
  // the hook attached), the CSS keeps at least the typeface consistent.
  const style = document.createElement('style');
  style.textContent = `
    code, pre, .code, .monospaced-text {
      font-family: ${FONT} !important;
      font-size: ${SIZE}px !important;
      line-height: ${LINE_HEIGHT}px !important;
    }
    .monaco-editor, .monaco-editor .view-lines, .monaco-editor .view-line,
    .monaco-editor .monaco-mouse-cursor-text, .monaco-editor textarea {
      font-family: ${FONT} !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  const inject = () => {
    const s = document.createElement('script');
    s.textContent = `(${bootstrap.toString()})(${JSON.stringify({ FONT, SIZE, LINE_HEIGHT })});`;
    document.documentElement.appendChild(s);
    s.remove();
  };

  function bootstrap(opts) {
    const { FONT, SIZE, LINE_HEIGHT } = opts;
    const LANG = 'ado-razor';
    const isRazorUri = (uri) => /\.(razor|cshtml)(\?|#|$)/i.test(uri || '');

    const applyFont = (ed) => {
      if (!ed || !ed.updateOptions) return;
      try {
        ed.updateOptions({
          fontFamily: FONT, fontSize: SIZE, lineHeight: LINE_HEIGHT, fontLigatures: true,
        });
      } catch (_) {}
      try { applyFont(ed.getOriginalEditor?.()); } catch (_) {}
      try { applyFont(ed.getModifiedEditor?.()); } catch (_) {}
    };

    const forceRazor = (model) => {
      if (!model) return;
      const cur = model.getLanguageId ? model.getLanguageId() : model.getModeId?.();
      if (cur === LANG) return;
      try { monaco.editor.setModelLanguage(model, LANG); } catch (_) {}
    };

    const registerRazor = () => {
      if (monaco.languages.getLanguages().some(l => l.id === LANG)) return;
      monaco.languages.register({ id: LANG });

      monaco.languages.setMonarchTokensProvider(LANG, {
        defaultToken: '',
        tokenPostfix: '.cs',
        keywords: [
          'abstract','as','async','await','base','bool','break','byte','case','catch','char','class',
          'const','continue','decimal','default','delegate','do','double','else','enum','event','explicit',
          'extern','false','finally','fixed','float','for','foreach','goto','if','implicit','in','int',
          'interface','internal','is','lock','long','namespace','new','null','object','operator','out',
          'override','params','private','protected','public','readonly','record','ref','return','sbyte',
          'sealed','short','sizeof','stackalloc','static','string','struct','switch','this','throw','true',
          'try','typeof','uint','ulong','unchecked','unsafe','ushort','using','var','virtual','void',
          'volatile','while','yield','get','set','init','where','partial','nameof','dynamic'
        ],
        tokenizer: {
          root: [
            [/@\*/, 'comment', '@razorComment'],
            [/@(code|functions)\b/, { token: 'keyword', next: '@blockOpen' }],
            [/@\{/, { token: 'keyword', next: '@csharp', bracket: '@open' }],
            [/@(if|else|foreach|for|while|switch|using|do|try|catch|finally|lock)\b/, 'keyword'],
            [/@(page|layout|inherits|model|implements|attribute|inject|namespace|typeparam|addTagHelper|removeTagHelper|tagHelperPrefix)\b/, 'keyword'],
            [/@\(/, { token: 'keyword', next: '@parenExpr', bracket: '@open' }],
            [/@[a-zA-Z_][\w\.]*/, 'variable.predefined'],
            [/<!--/, 'comment', '@htmlComment'],
            [/<\/?[a-zA-Z][\w:-]*/, 'tag'],
            [/[<>]/, 'delimiter'],
            [/"[^"]*"/, 'string'],
            [/'[^']*'/, 'string'],
          ],
          blockOpen: [
            [/\s+/, ''],
            [/\{/, { token: 'delimiter', next: '@csharp', bracket: '@open' }],
            [/./, { token: '@rematch', next: '@pop' }],
          ],
          csharp: [
            [/\}/, { token: 'delimiter', next: '@pop', bracket: '@close' }],
            [/\{/, { token: 'delimiter', next: '@csharp', bracket: '@open' }],
            [/\/\/.*$/, 'comment'],
            [/\/\*/, 'comment', '@blockComment'],
            [/@"/, 'string', '@verbatimString'],
            [/\$"/, 'string', '@interpolatedString'],
            [/"([^"\\]|\\.)*"/, 'string'],
            [/'([^'\\]|\\.)'/, 'string'],
            [/\b\d+\.?\d*([eE][+-]?\d+)?[fFdDmM]?\b/, 'number'],
            [/\b0x[0-9a-fA-F]+[uUlL]*\b/, 'number.hex'],
            [/\b(true|false|null)\b/, 'constant'],
            [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
            [/[+\-*/%=<>!&|^~?:]+/, 'operator'],
            [/[;,.]/, 'delimiter'],
          ],
          parenExpr: [
            [/\)/, { token: 'keyword', next: '@pop', bracket: '@close' }],
            [/\(/, { token: 'delimiter', next: '@parenExpr', bracket: '@open' }],
            [/"([^"\\]|\\.)*"/, 'string'],
            [/\b\d+\b/, 'number'],
            [/\b(true|false|null)\b/, 'constant'],
            [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
            [/[+\-*/%=<>!&|^~?:]+/, 'operator'],
            [/[;,.]/, 'delimiter'],
            [/./, ''],
          ],
          verbatimString: [
            [/[^"]+/, 'string'],
            [/""/, 'string.escape'],
            [/"/, 'string', '@pop'],
          ],
          interpolatedString: [
            [/\{\{|\}\}/, 'string.escape'],
            [/\{/, { token: 'delimiter', next: '@interpolationExpr', bracket: '@open' }],
            [/"/, 'string', '@pop'],
            [/[^"\{\}]+/, 'string'],
          ],
          interpolationExpr: [
            [/\}/, { token: 'delimiter', next: '@pop', bracket: '@close' }],
            [/"([^"\\]|\\.)*"/, 'string'],
            [/\b\d+\b/, 'number'],
            [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
            [/./, ''],
          ],
          blockComment: [
            [/\*\//, 'comment', '@pop'],
            [/./, 'comment'],
          ],
          razorComment: [
            [/\*@/, 'comment', '@pop'],
            [/./, 'comment'],
          ],
          htmlComment: [
            [/-->/, 'comment', '@pop'],
            [/./, 'comment'],
          ],
        },
      });
    };

    const OUR_THEME = 'ado-tweaks-theme';

    const applyTheme = () => {
      const cls = document.querySelector('.monaco-editor')?.className || '';
      const dark = cls.includes('vs-dark') || cls.includes('hc-black');
      const base = cls.includes('hc-black') ? 'hc-black' : (dark ? 'vs-dark' : 'vs');

      const rules = dark ? [
        { token: 'keyword',             foreground: '569cd6' },
        { token: 'type',                foreground: '4ec9b0' },
        { token: 'string',              foreground: 'ce9178' },
        { token: 'string.escape',       foreground: 'd7ba7d' },
        { token: 'number',              foreground: 'b5cea8' },
        { token: 'number.hex',          foreground: 'b5cea8' },
        { token: 'comment',             foreground: '6a9955', fontStyle: 'italic' },
        { token: 'constant',            foreground: '4fc1ff' },
        { token: 'operator',            foreground: 'd4d4d4' },
        { token: 'delimiter',           foreground: 'd4d4d4' },
        { token: 'identifier',          foreground: '9cdcfe' },
        { token: 'tag',                 foreground: '569cd6' },
        { token: 'variable.predefined', foreground: 'dcdcaa' },
      ] : [
        { token: 'keyword',             foreground: '0000ff' },
        { token: 'type',                foreground: '267f99' },
        { token: 'string',              foreground: 'a31515' },
        { token: 'string.escape',       foreground: 'ee0000' },
        { token: 'number',              foreground: '098658' },
        { token: 'number.hex',          foreground: '098658' },
        { token: 'comment',             foreground: '008000', fontStyle: 'italic' },
        { token: 'constant',            foreground: '0070c1' },
        { token: 'operator',            foreground: '000000' },
        { token: 'delimiter',           foreground: '000000' },
        { token: 'identifier',          foreground: '001080' },
        { token: 'tag',                 foreground: '800000' },
        { token: 'variable.predefined', foreground: '795e26' },
      ];

      try {
        monaco.editor.defineTheme(OUR_THEME, { base, inherit: true, rules, colors: {} });
        applyingOurTheme = true;
        try { monaco.editor.setTheme(OUR_THEME); } finally { applyingOurTheme = false; }
      } catch (_) {}
    };

    // Track whether we're the ones calling setTheme so the wrapper below
    // doesn't recurse when it re-applies our theme after an external override.
    let applyingOurTheme = false;

    const tagExistingModels = () => {
      for (const m of monaco.editor.getModels()) {
        if (isRazorUri(m.uri.toString())) forceRazor(m);
      }
    };

    const hookFutures = () => {
      if (monaco.editor.__adoTweaksHooked) return;
      monaco.editor.__adoTweaksHooked = true;

      const origCreateModel = monaco.editor.createModel;
      monaco.editor.createModel = function (value, language, uri) {
        if (isRazorUri(uri?.toString?.())) language = LANG;
        return origCreateModel.call(this, value, language, uri);
      };

      // Wrap setTheme so ADO can't silently revert our theme on navigation.
      const origSetTheme = monaco.editor.setTheme;
      monaco.editor.setTheme = function (name) {
        const ret = origSetTheme.call(this, name);
        if (!applyingOurTheme && name !== OUR_THEME) {
          try { applyTheme(); } catch (_) {}
        }
        return ret;
      };

      monaco.editor.onDidCreateModel?.((m) => {
        if (isRazorUri(m.uri?.toString())) forceRazor(m);
      });

      monaco.editor.onDidChangeModelLanguage?.((e) => {
        if (isRazorUri(e.model?.uri?.toString()) && e.newLanguage !== LANG) {
          forceRazor(e.model);
        }
      });

      monaco.editor.onDidCreateEditor?.(applyFont);
    };

    const run = () => {
      if (!window.monaco?.languages || !monaco.editor?.getModels) return false;
      registerRazor();
      hookFutures();
      tagExistingModels();
      applyTheme();
      return true;
    };

    // SPA navigation: ADO swaps views without a full page load, often
    // re-creating editors and resetting the global theme. Re-run setup so our
    // theme + language tagging persist across PR → file → diff transitions.
    const hookNavigation = () => {
      const onNav = () => setTimeout(run, 50);
      for (const k of ['pushState', 'replaceState']) {
        const orig = history[k];
        history[k] = function (...a) { const r = orig.apply(this, a); onNav(); return r; };
      }
      window.addEventListener('popstate', onNav);
    };
    hookNavigation();

    if (run()) return;
    const iv = setInterval(() => { if (run()) clearInterval(iv); }, 100);
    setTimeout(() => clearInterval(iv), 60_000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject, { once: true });
  } else {
    inject();
  }
})();

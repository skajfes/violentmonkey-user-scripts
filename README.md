# Azure DevOps PR Userscripts

Personal Violentmonkey userscripts that make Azure DevOps pull request reviews less painful.
Tested on ADO Services (cloud), Firefox + Chrome, JetBrains Mono Nerd Font installed locally.

## Scripts

### `ado-razor-highlight.user.js`
Enables `.razor` and `.cshtml` syntax highlighting in the **single-file** Monaco diff viewer,
and bumps the code font to JetBrains Mono Nerd Font at 14px/24px line height.

- Registers a custom Monarch tokenizer under the language id `ado-razor` (separate from
  ADO's pre-registered `razor` to avoid being overridden by their lazy loader).
- Handles `@code { }`, `@functions { }`, `@{ }`, `@if / @foreach / @while`, inline `@Model.Foo`,
  `@(expr)`, `@page` / `@inherits` / `@inject` etc.
- Applies a VS Code Dark+ / Light+ theme override so our tokens actually get colors
  (ADO's theme doesn't have rules for Monarch tokens because they highlight C# via TextMate).

### `ado-reviewed-checkbox.user.js`
Adds a **Reviewed** pill to each file's header in the stacked folder-diff view, mirroring
the native file-tree checkbox and auto-collapsing the file when reviewed.

- Reconstructs each file's full path from the tree's `aria-level` hierarchy
  (tree rows only render filenames, not paths; folders are skipped via `aria-expanded`).
- Strips status glyphs (`+`/`-`/`*`) that ADO appends to new/changed/deleted filenames.
- One-way binding: checking the pill calls the native tree checkbox, which flips
  `aria-checked`, which our MutationObserver picks up and clicks ADO's native
  `.bolt-card-expand-button` to collapse/expand. Clicking the native chevron manually
  does *not* touch reviewed state (deliberately).

### `ado-stacked-syntax.user.js`
Adds client-side syntax highlighting to the **stacked** folder-diff view, which ADO
renders as plain HTML without any tokenization.

- Pulls `highlight.js` via `// @require` (common bundle, ~50KB, cached by VM).
- Detects language per file from the extension (`cs` → `csharp`, `razor` → `csharp`,
  `resx` → `xml`, etc.).
- Observes the DOM for new `.repos-line-content` spans (ADO lazily renders rows as
  they scroll into view) and highlights each exactly once.
- Preserves ADO's `.screen-reader-only` "Plus"/"Minus" spans so accessibility and the
  visible `+`/`-` glyphs stay intact.
- Default palette is VS Code Light+, with a `prefers-color-scheme: dark` override.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) in your browser.
2. Open each `.user.js` file — VM should prompt to install on a standard file:// URL,
   or drag the file into the VM dashboard.
3. Visit an ADO PR to verify. First run may take a second while `@require` downloads
   highlight.js; subsequent loads are cached.

Font prerequisite for `ado-razor-highlight`:
```fish
mkdir -p ~/.local/share/fonts/JetBrainsMonoNF
cd /tmp
curl -LO https://github.com/ryanoasis/nerd-fonts/releases/latest/download/JetBrainsMono.zip
unzip -o JetBrainsMono.zip -d ~/.local/share/fonts/JetBrainsMonoNF
fc-cache -fv
```

## Auto-update from git

Each script's header has `@version 1.0.0`. To get VM to auto-pull changes from this repo:

1. Push the repo to GitHub (or Codeberg / GitLab / Gitea).
2. Add these two headers to each `.user.js` (replace `<you>` and `<repo>`):
   ```
   // @updateURL    https://raw.githubusercontent.com/<you>/<repo>/main/ado-razor-highlight.user.js
   // @downloadURL  https://raw.githubusercontent.com/<you>/<repo>/main/ado-razor-highlight.user.js
   ```
3. Bump `@version` on every meaningful edit (VM compares semver to decide if an update
   should be pulled).
4. VM dashboard → ⚙ → enable automatic updates. Or force: Dashboard → script → Check
   for updates.

Workflow: edit script in your editor → commit → push → VM pulls within a day (or on demand).
Do *not* edit the script in VM's web editor if you want repo to stay the source of truth —
there's no bidirectional sync.

## Debugging

Each script has a `DEBUG` constant near the top (`const DEBUG = false;`). Flip to `true`
and reload the PR page to get per-step log output in the DevTools console. Scripts log
prefixes:

- `[ado-reviewed]` — path detection, tree-row matching, injection skips
- `[ado-syntax]` — language detection per file, highlight errors

The Razor-highlight script has no debug flag but exposes `ado-razor` as a registered
Monaco language. Verify with:

```js
monaco.languages.getLanguages().some(l => l.id === 'ado-razor');  // should be true on a PR page
```

## Known quirks

- **`.razor` falls back to the `csharp` highlight.js grammar** in the stacked view.
  HTML markup inside `.razor` files gets tagged as plain text; C# inside `@code` etc.
  is highlighted correctly. A real Razor grammar is ~80 more lines and hasn't been worth
  the maintenance.
- **`monaco.editor.tokenize(text, 'ado-razor')` returns `['']`** even though the editor
  is correctly colored. ADO's Monaco version has a bug where that API doesn't reflect
  runtime-registered Monarch providers. Judge by the editor, not the API.
- **Stacked-view files not currently scrolled into the tree sidebar** don't get the
  Reviewed pill, because ADO virtualizes the tree and their checkboxes aren't in the DOM.
  Scroll the tree to materialize the rows and they'll get mirrored on the next tick.

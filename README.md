DisinfaX is an intelligent fact-checker integrated directly into your X (Twitter) feed. Accurately verify claims and reveal disinformation with blazing speed.
- **Ultra Cheap, Ultra Fast Fact-Checking:** typically ~US$0.03 & ~3s per claim.
- **Free, Instant Verdicts: Tweets & claims** previously fact-checked by other users reveal their verdict in the blink of an eye — and free of charge.
- **Seamless Integration:** Verdicts & their metadata are directly embedded inside tweets. Fact-checked claims are colour-coded: red if false, green if true, and intermediate shades for partial truth.
- **Reasoning:** Clear & detailed explanation of the verdict reached.
- **Confidence Level:** Estimated likelihood of a verdict's correctness.
- **Transparency:** Provided research sources that contributed to a verdict.
- **Multilingual Support:** Near-instant translations of reasoning descriptions & other metadata previously generated in foreign languages.

# FOR MOZILLA REVIEWERS:

# Building DisinfaX from source

These instructions reproduce the submitted `disinfax-1.0.1-firefox.zip` from this source
archive. A build script, `build.sh`, performs every step below.

## 1. Build environment requirements

| | |
|---|---|
| Operating system | Any OS supported by Node.js — macOS, Linux, or Windows. The reference build was made on macOS 26.5.2 (Apple Silicon). Nothing in the build is platform-specific: no native compilation, no code generation from platform APIs. |
| Node.js | **v25.9.0** (reference). Any Node ≥ 20 LTS works. |
| npm | **11.18.0** (ships with Node 25; any npm ≥ 10 works). |
| Network access | Required for `npm ci` only. |
| Disk | ~600 MB for `node_modules`. |

### Installing Node.js and npm

npm is bundled with Node.js — installing Node installs both.

- **Official installer (all platforms):** download the v25.x package from
  <https://nodejs.org/en/download> and run it.
- **macOS (Homebrew):** `brew install node@25`
- **Linux (nvm, recommended for matching the exact version):**
  ```sh
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  nvm install 25.9.0
  nvm use 25.9.0
  ```
- **Windows:** the official installer above, or `winget install OpenJS.NodeJS`

Verify:
```sh
node --version    # v25.9.0
npm --version     # 11.18.0
```

No other tooling is required. The bundler (WXT ^0.20.18, which wraps Vite and esbuild) and
every other dependency is installed by `npm ci` at the exact versions pinned in
`package-lock.json`.

## 2. Build

```sh
unzip disinfax-1.0.1-sources.zip
cd disinfax
bash build.sh
```

`build.sh` runs the two steps below and reports the output location. To run them by hand:

```sh
npm ci --ignore-scripts       # installs exact pinned versions from package-lock.json
npx wxt build -b firefox      # produces .output/firefox-mv2/
```

### Known quirk: WXT commands do not exit on their own

Both `wxt prepare` and `wxt build` finish their work, print `✔ Finished in <n>s`, and then
keep running — they leave an esbuild service alive. **The output is complete as soon as that
line appears.**

Two consequences when running the commands by hand:

- **Use `npm ci --ignore-scripts`.** This project's `postinstall` hook runs `wxt prepare`, so
  a plain `npm ci` hangs indefinitely *after* the install has actually completed. The hook
  only generates TypeScript types under `.wxt/` for editor tooling; `wxt build` does not
  need them and produces identical output without them.
- **Press Ctrl-C after `✔ Finished`** if `wxt build` does not return.

`build.sh` handles both automatically: it skips the hook and waits for the completion marker
before stopping the process.

## 3. Output

```
.output/firefox-mv2/
```

This directory is the contents of the submitted `disinfax-1.0.1-firefox.zip` — the zip is
that directory compressed, with nothing added or removed.

`background.js`, `content-scripts/relay.js` and `content-scripts/capture.js` reproduce
**byte-for-byte**.

### One expected variance: `assets/popup-*.css`

The generated popup stylesheet may differ from the submitted one by one or two unused
utility classes, which also changes its content-hash filename (and therefore the reference
to it in `popup.html`).

Cause: Tailwind CSS v4 discovers class names by scanning the project directory, and it
honours `.gitignore`, which is not included in this source archive. Depending on what else
is present on disk, it may emit an extra unused rule such as `.blur`. No source file
differs, and no JavaScript is affected. Diffing the two stylesheets shows only whole,
self-contained utility rules that nothing references.

## 4. What the build does

WXT compiles the TypeScript entry points into an unpacked MV2 extension:

| Source | Output |
|---|---|
| `entrypoints/background.ts` | `background.js` |
| `entrypoints/relay.content.ts` | `content-scripts/relay.js` |
| `entrypoints/capture.content.ts` | `content-scripts/capture.js` |
| `entrypoints/popup/` | `popup.html`, `chunks/popup-*.js`, `assets/popup-*.css` |
| `public/_locales/` | `_locales/` (copied verbatim) |
| `wxt.config.ts` | `manifest.json` (generated) |

Production builds strip all `console.*` calls via esbuild's `drop` option — see the
`esbuild` block in `wxt.config.ts`.

## 5. Notes on third-party code in the bundle

- **`@supabase/supabase-js`** performs `import("@opentelemetry/api").catch(() => null)`
  (`node_modules/@supabase/supabase-js/dist/index.mjs:80-83`) to pick up tracing if that
  optional package is present. It is **not** a dependency of this project, so the import
  always rejects and resolves to `null`; nothing is ever loaded. This is the source of the
  three "Unsafe call to import" linter warnings.
- The Supabase key in `utils/supabase.ts` is the **publishable (anon)** key. It is designed
  to ship in client code, grants no privileges on its own, and every table is gated by
  row-level security policies keyed on `auth.uid()`.

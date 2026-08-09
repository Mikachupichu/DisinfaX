import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: (env) => ({
    plugins: [tailwindcss()],
    // Production strips console, which is right for shipping but makes a production-only
    // bug undebuggable — and some bugs only appear there, because `wxt dev` re-injects
    // content scripts on every change and that behaves differently from a single clean
    // injection. `KEEP_LOGS=1 npm run build:firefox` gives a production build that still
    // logs. The default is unchanged, so a normal build cannot accidentally ship logs.
    esbuild: env.mode === 'production'
      ? { drop: process.env.KEEP_LOGS ? ['debugger'] : ['console', 'debugger'] }
      : {},
  }),
  // Only the Firefox build produces a SOURCES zip (wxt sets zipSources for firefox/opera), and
  // that zip is built from the repo root — not from the compiled output. WXT's default is
  // default-OPEN: it globs `**/*` and removes only what `excludeSources` names, so every file in
  // the repo ships unless someone remembers to add a pattern. That shipped `config.yaml` (live
  // DeepSeek/Anthropic/Mistral API keys), the whole `venv/` (22,967 files) and the entire nested
  // `DisinfaX/` Xcode project — 517 MB of source, none of which Mozilla needs.
  //
  // Inverted to default-CLOSED. wxt's filter is
  //   picomatch(path, include) || !picomatch(path, exclude)
  // so an `include` match wins over `exclude`: excluding `**/*` denies everything, and
  // `includeSources` becomes a true allowlist. A file added to the repo later is therefore
  // excluded by default rather than published by default — which is the only way this stays
  // correct without anyone maintaining it.
  //
  // The list below is exactly what compiles the extension; verified by rebuilding from the
  // extracted zip and byte-comparing against the normal build. Nothing here needs a `.env`:
  // every `import.meta.env` read in the source is a wxt build-time browser constant.
  zip: {
    excludeSources: ['**/*'],
    includeSources: [
      'entrypoints/**',
      'utils/**',
      'data/**',
      'assets/**',
      'public/**',
      'wxt.config.ts',
      'tsconfig.json',
      'package.json',
      'package-lock.json',
    ],
  },
  manifest: (env) => ({
    name: 'DisinfaX',
    description: "Identifies and highlights disinformation in tweets using fast and intelligent research.",
    version: '1.0.0',
    default_locale: 'en',
    // Static icons (chrome://extensions, the extensions menu, the Web Store
    // listing) cannot be themed at runtime, so they use the neutral gray logo
    // variant, which stays legible on light and dark browser UI alike.
    // Without these, WXT would fall back to its placeholder `icon/{size}.png`.
    icons: {
      16: 'icon/16-gray.png',
      32: 'icon/32-gray.png',
      48: 'icon/48-gray.png',
      96: 'icon/96-gray.png',
      128: 'icon/128-gray.png',
    },
    action: {
      // Starting point for the toolbar icon only. Once a context with a DOM
      // reports the browser's colour scheme, the background swaps this for the
      // black or white variant via chrome.action.setIcon — see
      // utils/toolbarIcon.ts.
      default_icon: {
        16: 'icon/16-gray.png',
        32: 'icon/32-gray.png',
        48: 'icon/48-gray.png',
        96: 'icon/96-gray.png',
        128: 'icon/128-gray.png',
      },
    },
    web_accessible_resources: [
      {
        resources: ['_locales/*/messages.json'],
        matches: ['<all_urls>']
      }
    ],
    permissions: [
      ...(env.browser !== 'safari' ? ['identity'] : []),
      // Safari drives OAuth (ASWebAuthenticationSession) and StoreKit purchases through
      // the containing app over runtime.sendNativeMessage, which is gated on this
      // permission. Safari-only: no other target uses native messaging, and declaring it
      // there would add a store-listing permission warning for nothing.
      ...(env.browser === 'safari' ? ['nativeMessaging'] : []),
      'storage',
      'alarms'
    ],
    // Scoped just to disinfax.app so tabs.onUpdated (used in background.ts to detect
    // the Stripe checkout tab redirecting back) can see that tab's URL, without the
    // broad 'tabs' permission's "read your browsing history" warning — Chrome only
    // populates changeInfo.url for tabs matching a granted host permission.
    host_permissions: ['*://*.disinfax.app/*'],
    browser_specific_settings: {
      gecko: {
        id: "disinfax@disinfax.app", // Must be unique (email format recommended)
      },
    },
  })
});

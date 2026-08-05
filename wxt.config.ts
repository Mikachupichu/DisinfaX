import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
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
      'identity',
      'storage',
      'alarms'
    ],
    // Scoped just to disinfax.app so tabs.onUpdated (used in background.ts to detect
    // the Stripe checkout tab redirecting back) can see that tab's URL, without the
    // broad 'tabs' permission's "read your browsing history" warning — Chrome only
    // populates changeInfo.url for tabs matching a granted host permission.
    host_permissions: ['*://*.disinfax.app/*'],
  }
});

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
    web_accessible_resources: [
      {
        resources: ['_locales/*/messages.json'],
        matches: ['<all_urls>']
      }
    ],
    permissions: [
      'identity',
      'storage',
      'tabs',
      'alarms'
    ],
  }
});

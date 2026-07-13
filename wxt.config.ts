import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'DisinfaX',
    description: "Detects and highlights disinformation in tweets using AI analysis.",
    version: '1.0.0',
    default_locale: 'en'
  }
});

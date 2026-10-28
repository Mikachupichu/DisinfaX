import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './style.css';
import { reportColorScheme } from '../../utils/toolbarIcon';
import { initPopupTheme } from './theme';

// The background service worker has no DOM and so cannot read the browser's
// dark/light preference itself. Report it from here so it can theme the toolbar
// icon. See utils/toolbarIcon.ts.
reportColorScheme();

// Before the first render, so the panel never opens in the wrong appearance and
// flips. See entrypoints/popup/theme.ts.
initPopupTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

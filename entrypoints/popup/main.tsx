import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './style.css';
import { reportColorScheme } from '../../utils/toolbarIcon';

// The background service worker has no DOM and so cannot read the browser's
// dark/light preference itself. Report it from here so it can theme the toolbar
// icon. See utils/toolbarIcon.ts.
reportColorScheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

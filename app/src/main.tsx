// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { init } from '@plausible-analytics/tracker';
import toast from 'react-hot-toast';
import App from './App';
import { t } from '@/i18n';
import { adoptCodeFromUrl } from './mcp/codeStore';
import './styles/theme.css';
import './styles/globals.css';

// Variable toast messages (not just literals the dev plugin rewrites) go through the catalog.
for (const method of ['success', 'error', 'loading'] as const) {
  const original = toast[method];
  toast[method] = ((message, options) => original(typeof message === 'string' ? t(message) : message, options)) as typeof original;
}

init({ domain: 'starquix.netlify.app' });

// `starquix-mcp pair` opens the app with ?mcp=<code>; park it before React mounts.
adoptCodeFromUrl();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

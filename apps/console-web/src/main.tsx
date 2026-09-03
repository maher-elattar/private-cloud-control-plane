/**
 * Browser entry point.
 *
 * Mounts the console into `#root`. There is no service worker or SSR hydration step — this is a
 * client-rendered SPA served behind the control API.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root container');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

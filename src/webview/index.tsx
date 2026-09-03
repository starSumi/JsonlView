import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

const root = document.getElementById('root');
if (root) {
  performance.mark('jsonlview:webview-start');
  createRoot(root).render(<App />);
  requestAnimationFrame(() => {
    performance.mark('jsonlview:first-frame');
    performance.measure('jsonlview:first-frame', 'jsonlview:webview-start', 'jsonlview:first-frame');
    const measure = performance.getEntriesByName('jsonlview:first-frame').at(-1);
    if (measure) document.body.dataset.webviewFirstFrameMs = measure.duration.toFixed(1);
  });
}

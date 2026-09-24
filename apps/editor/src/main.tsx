import React from 'react';
import ReactDOM from 'react-dom/client';
import * as ReactNs from 'react';
import * as ReactDomNs from 'react-dom';
import * as ReactDomClientNs from 'react-dom/client';
import * as JsxRuntimeNs from 'react/jsx-runtime';
import * as JsxDevRuntimeNs from 'react/jsx-dev-runtime';
import * as RemotionNs from 'remotion';
import * as OverlayNs from '@mangoai/remotion-overlay';
import App from './App';
import './styles.css';

// AI-generated overlay code is bundled by the runner and imports these packages from here, so it
// runs against the same React and Remotion instances as the Player that renders it.
window.__MANGO_SHARED__ = {
  react: ReactNs,
  'react-dom': ReactDomNs,
  'react-dom/client': ReactDomClientNs,
  'react/jsx-runtime': JsxRuntimeNs,
  'react/jsx-dev-runtime': JsxDevRuntimeNs,
  remotion: RemotionNs,
  '@mangoai/remotion-overlay': OverlayNs,
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

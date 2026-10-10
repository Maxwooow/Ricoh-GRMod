import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import './styles.css';
import { App } from './app';
import { installWindowBehaviour } from './fit';
import { init } from './store';

// index.html replaces the page with a notice when the browser is too old.
if (!(window as unknown as { __GRMOD_OLD_BROWSER__?: boolean }).__GRMOD_OLD_BROWSER__) {
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
  installWindowBehaviour();
  void init();
}

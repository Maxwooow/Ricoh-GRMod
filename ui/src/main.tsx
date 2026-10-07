import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import './styles.css';
import { App } from './app';
import { installWindowBehaviour } from './fit';
import { init } from './store';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
installWindowBehaviour();
void init();

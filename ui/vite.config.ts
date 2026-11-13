import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
// the phone app's own version (Android versionName, iOS MARKETING_VERSION are kept equal to it)
const mobileVersion = (JSON.parse(readFileSync(new URL('../mobile/package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    // The Android app (mode "android", built into ../mobile/www) has no shell to give it /host.js.
    // It is drawn edge to edge: the page pads itself by the system bars (styles.css, .app.mobile).
    {
      name: 'grmod-android-html',
      transformIndexHtml: (html: string) => (mode === 'android'
        ? html.replace(/\s*<script src="\/host\.js"><\/script>/, '').replace('user-scalable=no"', 'user-scalable=no, viewport-fit=cover"')
        : html),
    },
  ],
  define: { __GRMOD_VERSION__: JSON.stringify(version), __GRMOD_MOBILE_VERSION__: JSON.stringify(mobileVersion) },
  // Old enough for the browsers of macOS 10.13-10.15 (Chrome/Edge up to 116, Firefox ESR 115,
  // Safari 14+): a classic worker (module workers need Safari 15) and syntax lowered to ES2020.
  worker: { format: 'iife' },
  build: {
    target: ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari14'], sourcemap: false, chunkSizeWarningLimit: 2000,
    ...(mode === 'android' ? { outDir: '../mobile/www', emptyOutDir: true } : {}),
  },
}));

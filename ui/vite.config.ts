import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A source checkout ships the catalogue/icons without redistributing third-party
// LUTs. Detect installed inputs at build time so unavailable entries offer import
// instead of failing with a missing-file error. This never changes the catalogue.
function installedFilms() {
    const root = new URL('./public/film-library/', import.meta.url);
    const catalog = JSON.parse(readFileSync(new URL('catalog.json', root), 'utf8'));
    const installed = Object.fromEntries(['gr3x','gr4'].map(family => [family, catalog.stocks.filter((s: {id:string;cube?:string}) =>
      s.cube && existsSync(fileURLToPath(new URL(s.cube,root))) && existsSync(fileURLToPath(new URL(`fits/${s.id}-${family}.json`,root))))
      .map((s: {id:string}) => s.id)]));
    return installed;
}

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {__GRMOD_INSTALLED_FILMS__:JSON.stringify(installedFilms())},
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
});

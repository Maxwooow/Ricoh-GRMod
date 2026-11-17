import { defineConfig } from 'vitest/config';
import { programOverlays } from './overlays.mjs';

// programOverlays: a later release's program is its base program's files with the release's own on top (src/fw/release.ts).
export default defineConfig({ plugins: [programOverlays()], test: { include: ['test/**/*.test.{ts,mjs}'], testTimeout: 600000, pool: 'forks' } });

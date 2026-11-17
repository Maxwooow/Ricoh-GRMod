import { defineConfig } from 'vitest/config';
import { programOverlays } from '../core/overlays.mjs';

// The UI's own tests (state, updates, texts): plain Node, the platform behind host.ts and engine.ts is mocked.
// programOverlays: as in every pipeline that loads the engine (core/overlays.mjs).
export default defineConfig({ plugins: [programOverlays()], test: { include: ['test/**/*.test.{ts,mjs}'], testTimeout: 60000, pool: 'forks' } });

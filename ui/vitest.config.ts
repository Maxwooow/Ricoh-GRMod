import { defineConfig } from 'vitest/config';

// The UI's own tests (state, updates, texts): plain Node, the platform behind host.ts and engine.ts is mocked.
export default defineConfig({ test: { include: ['test/**/*.test.{ts,mjs}'], testTimeout: 60000, pool: 'forks' } });

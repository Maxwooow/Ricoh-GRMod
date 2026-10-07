import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 600000, pool: 'forks' } });

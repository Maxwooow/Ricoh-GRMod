import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
});

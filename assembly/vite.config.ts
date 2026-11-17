import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vite.dev/config/
export default defineConfig({
  base: './',
  envDir: '..',
  // Fixed names throughout, the demo snapshot's file included: every deploy
  // overwrites the last one's files in SiteAssets instead of leaving them there.
  build: { outDir: '../dist/assembly', emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'assets/assembly.js', chunkFileNames: 'assets/[name].js', assetFileNames: info => info.name?.endsWith('.css') ? 'assets/assembly.css' : 'assets/[name]-[hash][extname]' } } },
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});

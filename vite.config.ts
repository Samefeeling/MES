import { defineConfig } from 'vite';

// Single-page app. `base: './'` produces relative asset URLs so the built
// bundle can be dropped into SharePoint SiteAssets, served by IIS/Kestrel,
// or hosted on Azure Static Web Apps without path rewrites.
export default defineConfig({
  base: './',
  build: {
    target: 'es2021',
    outDir: 'dist',
    sourcemap: true,
  },
});

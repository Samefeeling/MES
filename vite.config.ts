import { defineConfig } from 'vite';

// Single-page app. `base: './'` produces relative asset URLs so the built
// bundle can be dropped into SharePoint SiteAssets, served by IIS/Kestrel,
// or hosted on Azure Static Web Apps without path rewrites.
//
// `entryFileNames` / `assetFileNames` produce hash-free filenames so the
// SPFx wrapper's static `require('./assets/index.js')` paths stay valid
// across rebuilds (see docs/DEPLOYMENT.md § B).
export default defineConfig({
  base: './',
  build: {
    target: 'es2021',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (info) => {
          if (info.name && /\.css$/.test(info.name)) return 'assets/index.css';
          return 'assets/[name][extname]';
        },
      },
    },
  },
});

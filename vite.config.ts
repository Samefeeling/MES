import { defineConfig, type Plugin } from 'vite';

// A per-build id (millis, base36). Baked into the bundle as __BUILD_ID__ and
// written to assets/version.json. The running app polls version.json and, when
// it differs from its own baked id, refreshes its asset cache and reloads to
// pick up the new code (see src/ui/auto-update.ts) — so an iPad self-updates
// after `npm run deploy` without a manual cache clear (which was wiping the
// SharePoint auth session).
const BUILD_ID = Date.now().toString(36);

function pmdBuildVersion(): Plugin {
  return {
    name: 'pmd-build-version',
    config() {
      return { define: { __BUILD_ID__: JSON.stringify(BUILD_ID) } };
    },
    generateBundle() {
      // Emitted next to index.js so the app can fetch it relative to
      // import.meta.url regardless of how the host page is served.
      this.emitFile({
        type: 'asset',
        fileName: 'assets/version.json',
        source: JSON.stringify({ build: BUILD_ID }),
      });
    },
  };
}

// Single-page app. `base: './'` produces relative asset URLs so the built
// bundle can be dropped into SharePoint SiteAssets, served by IIS/Kestrel,
// or hosted on Azure Static Web Apps without path rewrites.
//
// `entryFileNames` / `assetFileNames` produce hash-free filenames so the
// SPFx wrapper's static `require('./assets/index.js')` paths stay valid
// across rebuilds (see docs/DEPLOYMENT.md § B).
export default defineConfig({
  base: './',
  plugins: [pmdBuildVersion()],
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

import { defineConfig, type Plugin } from 'vite';

// A per-build id (millis, base36). Baked into the bundle as __BUILD_ID__ AND
// written to assets/version.json + stamped onto the index.html asset URLs.
// The running app polls version.json and, when it differs from its own baked
// id, force-reloads to pick up the new code (see src/ui/auto-update.ts). This
// is what makes an iPad update itself after `npm run deploy` without anyone
// clearing the browser cache (which was wiping the SharePoint auth session).
const BUILD_ID = Date.now().toString(36);

// Fixed filenames (assets/index.js, assets/index.css) mean the browser caches
// them forever under a stable URL, so a plain reload keeps the OLD code. We
// append ?v=<BUILD_ID> to the asset URLs in index.html so a freshly-fetched
// index.html points at a new URL → the browser re-downloads the JS/CSS.
function pmdBuildVersion(): Plugin {
  return {
    name: 'pmd-build-version',
    config() {
      return { define: { __BUILD_ID__: JSON.stringify(BUILD_ID) } };
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(
          /(src|href)="(\.\/assets\/index\.(?:js|css))"/g,
          (_m, attr: string, url: string) => `${attr}="${url}?v=${BUILD_ID}"`,
        );
      },
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

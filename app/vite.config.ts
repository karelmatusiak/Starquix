// vite.config.ts
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'url';
import { basename, dirname, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { sqSourcePlugin } from './src/vite-plugin';
import { i18nPlugin } from './scripts/i18n-plugin.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const snapshotVersion = JSON.parse(
  readFileSync(resolve(__dirname, 'public/astro-snapshot.json'), 'utf-8'),
).version;

if (typeof snapshotVersion !== 'string' || !snapshotVersion) {
  throw new Error('app/public/astro-snapshot.json has no valid version');
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    define: {
      'import.meta.env.VITE_SNAPSHOT_VERSION': JSON.stringify(snapshotVersion),
      // starquix-mcp is not on npm yet: a dev server points the AI Settings → MCP
      // snippets at this checkout's relay build (cd mcp && npm run build).
      // Production builds leave it empty → `npx -y starquix-mcp`.
      'import.meta.env.VITE_SQ_MCP_BIN': JSON.stringify(
        mode === 'development' && existsSync(resolve(__dirname, '../mcp/dist/cli.js')) ? resolve(__dirname, '../mcp/dist/cli.js') : '',
      ),
    },
    // Worktrees may symlink app/node_modules to this checkout's; a sibling dev
    // server then rewrites the shared dep cache under a running server
    // (504 'Outdated Optimize Dep' → 'Failed to fetch dynamically imported
    // module' in tabs that cached the old ?v=). Key the cache by checkout.
    cacheDir: resolve(__dirname, 'node_modules/.vite', basename(resolve(__dirname, '..'))),
    plugins: [i18nPlugin(), react(), tailwindcss(), sqSourcePlugin()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    server: {
      port: parseInt(env.VITE_PORT || '3000', 10),
      strictPort: true,
      // The spawned Astro child (a random localhost port) loads the in-page
      // editor as a module from THIS server. Vite 7 refuses cross-origin module
      // requests by default, so the child would get a CORS failure and the page
      // would silently have no editor.
      //
      // Scoped to localhost with any port — that is exactly the set of origins
      // the local runtime spawns, and it is a dev server either way.
      cors: { origin: /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/ },
    },
    optimizeDeps: {
      include: ['jszip', 'react-simple-code-editor'],
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
        },
        output: {
          manualChunks: {
            // Core React — cached across deploys, rarely changes
            'vendor-react': ['react', 'react-dom', 'react-router-dom', 'scheduler'],
            // Editor state — Yjs + Dexie, loaded early but separate chunk
            'vendor-state': ['yjs', 'dexie'],
            // Heavy libs only needed for specific features — loaded on demand
            'vendor-export': ['jszip'],
            'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          },
        },
      },
    },
  };
});

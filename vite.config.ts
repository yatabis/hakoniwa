import { defineConfig } from 'vite';

function normalizeBase(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/') {
    return '/';
  }

  let base = trimmed;
  if (!base.startsWith('/')) {
    base = `/${base}`;
  }
  if (!base.endsWith('/')) {
    base = `${base}/`;
  }

  return base;
}

function resolveBasePath(): string {
  const explicit = process.env.VITE_BASE_PATH;
  if (explicit) {
    return normalizeBase(explicit);
  }

  if (!process.env.GITHUB_ACTIONS) {
    return '/';
  }

  const repository = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
  if (!repository || repository.endsWith('.github.io')) {
    return '/';
  }

  return `/${repository}/`;
}

export default defineConfig({
  base: resolveBasePath(),
  server: {
    host: '127.0.0.1',
    port: 4173
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', 'three/examples/jsm/controls/OrbitControls.js']
        }
      }
    }
  }
});

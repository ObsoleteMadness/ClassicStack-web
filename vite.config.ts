import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const iconsDir = path.join(root, 'icons');

/** Serve and copy ./icons → /icons for system Finder glyphs. */
function iconsStaticPlugin(): Plugin {
  return {
    name: 'classicstack-icons-static',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/icons/')) return next();
        const rel = decodeURIComponent(req.url.slice('/icons/'.length).split('?')[0] ?? '');
        if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
          res.statusCode = 400;
          res.end('bad path');
          return;
        }
        const file = path.join(iconsDir, rel);
        if (!file.startsWith(iconsDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const outDir = path.join(root, 'dist', 'icons');
      fs.mkdirSync(outDir, { recursive: true });
      for (const name of fs.readdirSync(iconsDir)) {
        const src = path.join(iconsDir, name);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(outDir, name));
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [iconsStaticPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});

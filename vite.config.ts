import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { isWelcomePackSourceFile } from './src/fs/welcome-pack';

const root = fileURLToPath(new URL('.', import.meta.url));
const iconsDir = path.join(root, 'icons');
const welcomeDir = path.join(root, 'public', 'welcome');

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

/** List bundled welcome-pack files and serve /welcome/manifest.json. */
function welcomePackPlugin(): Plugin {
  const listFiles = (): { path: string; bytes: number }[] => {
    const walk = (dir: string, prefix: string): { path: string; bytes: number }[] => {
      if (!fs.existsSync(dir)) return [];
      const out: { path: string; bytes: number }[] = [];
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const st = fs.statSync(full);
        if (st.isDirectory()) out.push(...walk(full, rel));
        else if (st.isFile() && isWelcomePackSourceFile(rel)) out.push({ path: rel, bytes: st.size });
      }
      return out;
    };
    return walk(welcomeDir, '');
  };

  const manifestJson = (): string => JSON.stringify({ files: listFiles() });

  return {
    name: 'classicstack-welcome-pack',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url !== '/welcome/manifest.json') return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(manifestJson());
      });
    },
    closeBundle() {
      const outDir = path.join(root, 'dist', 'welcome');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestJson());
    },
  };
}

export default defineConfig({
  plugins: [iconsStaticPlugin(), welcomePackPlugin()],
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

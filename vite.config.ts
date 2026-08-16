import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { isWelcomePackSourceFile } from './src/fs/welcome-pack';

const root = fileURLToPath(new URL('.', import.meta.url));
const iconsDir = path.join(root, 'icons');
const welcomeDir = path.join(root, 'public', 'welcome');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

/** Short SHA of main (CI / main / origin/main), else HEAD. Empty if git is unavailable. */
function gitCommitShort(): string {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi && /^[0-9a-f]{7,40}$/i.test(fromCi)) return fromCi.slice(0, 7);
  for (const ref of ['main', 'origin/main', 'HEAD']) {
    try {
      const sha = execSync(`git rev-parse ${ref}`, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 7);
    } catch {
      // try the next ref
    }
  }
  return '';
}

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
  plugins: [
    iconsStaticPlugin(),
    welcomePackPlugin(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'pwa-192.png', 'pwa-512.png'],
      manifest: {
        id: '/',
        name: 'ClassicStack',
        short_name: 'ClassicStack',
        description: 'Browser AppleTalk / AFP stack over Web Serial and TashTalk.',
        lang: 'en',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#1a1d21',
        theme_color: '#1a1d21',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,json,bin,dsk,sit,txt,md}'],
        globIgnores: ['**/CNAME'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(gitCommitShort()),
  },
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

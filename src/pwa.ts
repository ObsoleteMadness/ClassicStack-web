/** Register the production service worker and prompt when a new version is waiting. */

import { registerSW } from 'virtual:pwa-register';
import { UpdateBanner } from './ui/update-banner';
import { log } from './util/logger';

const UPDATE_CHECK_MS = 30 * 60 * 1000;

/** Install the PWA worker (no-op in Vite dev) and show a reload notice on updates. */
export function registerPwa(): void {
  const banner = new UpdateBanner();
  document.body.appendChild(banner);

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      log.info('A newer ClassicStack build is ready — reload to apply', 'app');
      banner.show(() => {
        void updateSW(true);
      });
    },
    onOfflineReady() {
      log.info('ClassicStack is available offline', 'app');
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = (): void => {
        void registration.update().catch((err: unknown) => {
          log.trace(`Service worker update check failed: ${String(err)}`, 'app');
        });
      };
      window.setInterval(check, UPDATE_CHECK_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
    onRegisterError(err) {
      log.warn(`Service worker registration failed: ${String(err)}`, 'app');
    },
  });
}

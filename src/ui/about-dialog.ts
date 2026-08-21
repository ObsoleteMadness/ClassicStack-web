/** App About box: license, credits for referenced source. */

import { log } from '../util/logger';

const REPO = 'https://github.com/obsoletemadness/classicstack-web';
const TASH_TALK = 'https://github.com/lampmerchant/tashtalk';
const TASH_ROUTER = 'https://github.com/lampmerchant/tashrouter';
const TASHTARI = 'https://github.com/lampmerchant';
const NETBOOT = 'https://github.com/elliotnunn/NetBoot';
const ELLIOT = 'https://github.com/elliotnunn';
const XADMASTER = 'https://github.com/MacPaw/XADMaster';
const DAG = 'https://github.com/DagAgren';
const DIRK = 'https://www.dstoecker.eu/xadmaster.html';
const STUFFIT_RS = 'https://github.com/benletchford/stuffit-rs';
const WIESMANN = 'https://github.com/wiesmann';
const QUICKDRAW_VIEWER = 'https://github.com/wiesmann/QuickDrawViewer';
const HARALD_KUHR = 'https://github.com/haraldk';
const TWELVE_MONKEYS = 'https://github.com/haraldk/TwelveMonkeys';
const TWELVE_MONKEYS_PICT =
  'https://github.com/haraldk/TwelveMonkeys/tree/master/imageio/imageio-pict';
const ICONS8 = 'https://icons8.com/';
const GPL = 'https://www.gnu.org/licenses/gpl-3.0.html';

function extLink(href: string, label: string): string {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function appVersionId(): string {
  const ver = __APP_VERSION__;
  const sha = __GIT_COMMIT__;
  if (!sha) return ver;
  return `${ver} (${extLink(`${REPO}/commit/${sha}`, sha)})`;
}

/** Modal About box opened from the ClassicStack menu. */
export class AboutDialog extends HTMLElement {
  connectedCallback(): void {
    this.classList.add('about-dialog');
    this.hidden = true;
    this.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.hidden) this.close();
    });
  }

  open(): void {
    this.hidden = false;
    this.render();
    this.querySelector<HTMLButtonElement>('.btn.primary')?.focus();
    log.info('Opened About ClassicStack', 'app');
  }

  close(): void {
    this.hidden = true;
    this.innerHTML = '';
  }

  private render(): void {
    this.innerHTML = `
      <div class="netboot-dialog__backdrop" data-act="close"></div>
      <div class="netboot-dialog__card about-dialog__card" role="dialog" aria-labelledby="about-title" aria-modal="true">
        <header class="netboot-dialog__header">
          <h2 id="about-title">About ClassicStack Web</h2>
          <button type="button" class="btn" data-act="close" aria-label="Close">✕</button>
        </header>
        <div class="about-dialog__body">
          <p class="about-dialog__name">ClassicStack</p>
          <p class="about-dialog__ver">Version ${appVersionId()}</p>
          <p>A browser AppleTalk / AFP stack over Web Serial → TashTalk → LocalTalk.</p>
          <p>${extLink(REPO, 'GitHub')}</p>
          <h3>License</h3>
          <p>
            ClassicStack Webis free software under the
            ${extLink(GPL, 'GNU General Public License v3.0')}.
          </p>

          <h3>Credits</h3>
          <p>ClassicStack Web is indebted to the following source code and authors:</p>
          <ul>
            <li>
              ${extLink(TASHTARI, 'Tashtari')} for
              ${extLink(TASH_TALK, 'TashTalk')}
              (host framing also follows
              ${extLink(TASH_ROUTER, 'TashRouter')}; GPLv3)
            </li>
            <li>
              ${extLink(ELLIOT, 'Elliot Nunn')} for
              ${extLink(NETBOOT, 'NetBoot')}
              (ChainLoader / AppleTalk Boot Protocol; MIT)
            </li>
            <li>
              ${extLink(XADMASTER, 'XADMaster')} /
              The Unarchiver —
              ${extLink(DAG, 'Dag Ågren')},
              ${extLink(DIRK, 'Dirk Stöcker')},
              and the xadmaster library — StuffIt archive formats
              (also via ${extLink(STUFFIT_RS, 'stuffit-rs')})
            </li>
            <li>
              ${extLink(WIESMANN, 'Matthias Wiesmann')} for
              ${extLink(QUICKDRAW_VIEWER, 'QuickDrawViewer')}
              (PICT / QuickDraw opcode layout and PackBits; Apache 2.0)
            </li>
            <li>
              ${extLink(HARALD_KUHR, 'Harald Kuhr')} for
              ${extLink(TWELVE_MONKEYS, 'TwelveMonkeys')}
              ${extLink(TWELVE_MONKEYS_PICT, 'imageio-pict')}
              (PICT bitmap packing; BSD-3-Clause)
            </li>
            <li>
              Icons by ${extLink(ICONS8, 'Icons8')}
            </li>
          </ul>
        </div>
        <footer class="netboot-dialog__footer">
          <button type="button" class="btn primary" data-act="close">OK</button>
        </footer>
      </div>
    `;
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (t?.dataset.act === 'close') this.close();
  }
}

customElements.define('about-dialog', AboutDialog);

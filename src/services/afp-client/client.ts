/** High-level AFP client: session login, then one open volume. */

import { AspSession } from '../asp-client';
import type { AtpClient } from '../atp-client';
import * as asp from '../../protocol/asp';
import * as C from '../../protocol/afp/constants';
import * as cmd from './commands';
import { desEncryptBlock } from '../../hash/des';
import { encodeMacRoman } from '../../protocol/macroman';
import { log } from '../../util/logger';

export type AfpCredentials =
  | { kind: 'guest' }
  | { kind: 'password'; username: string; password: string };

export interface AfpServerInfo {
  serverName: string;
  versions: string[];
  uams: string[];
}

export interface AfpServerNotice {
  kind: 'message' | 'shutdown' | 'closed';
  title: string;
  text: string;
  minutes?: number;
}

function passwordKey(password: string, shiftLeft: boolean): Uint8Array {
  const key = new Uint8Array(8);
  key.set(encodeMacRoman(password).subarray(0, 8));
  if (shiftLeft) {
    for (let i = 0; i < 8; i++) key[i] = (key[i]! << 1) & 0xff;
  }
  return key;
}

export class AfpClient {
  sess: AspSession;
  volId = 0;
  volumeName = '';
  serverName = '';
  versions: string[] = [];
  uams: string[] = [];
  volumes: { flags: number; name: string }[] = [];
  private version = C.AFPVersion21;
  private openVolIds = new Map<string, number>();
  loggedIn = false;
  supportsSrvrMsg = false;
  private noticeHandler: ((n: AfpServerNotice) => void) | null = null;
  private pendingNotices: AfpServerNotice[] = [];
  private sawShutdown = false;

  private constructor(sess: AspSession) {
    this.sess = sess;
    this.bindSessionEvents();
  }

  set onNotice(fn: ((n: AfpServerNotice) => void) | null) {
    this.noticeHandler = fn;
    if (fn && this.pendingNotices.length) {
      const q = this.pendingNotices;
      this.pendingNotices = [];
      for (const n of q) fn(n);
    }
  }

  get onNotice(): ((n: AfpServerNotice) => void) | null {
    return this.noticeHandler;
  }

  private emitNotice(n: AfpServerNotice): void {
    if (this.noticeHandler) this.noticeHandler(n);
    else this.pendingNotices.push(n);
  }

  private bindSessionEvents(): void {
    this.sess.onAttention = (code) => {
      void this.handleAttention(code);
    };
    this.sess.onServerClose = () => {
      this.loggedIn = false;
      this.volId = 0;
      this.emitNotice({
        kind: 'closed',
        title: this.serverName || 'AFP server',
        text: this.sawShutdown ? '' : 'The AFP server closed this session.',
      });
    };
  }

  private async handleAttention(code: number): Promise<void> {
    log.info(`ASP attention 0x${(code & 0xffff).toString(16)}`, 'afp');
    let text = '';
    if (code & asp.AttnMsg) {
      try {
        const r = await this.sess.command(cmd.getSrvrMsg(C.SrvrMsgTypeServer));
        if (r.result === C.NoErr) text = cmd.parseGetSrvrMsg(r.data).text;
      } catch (err) {
        log.warn(`FPGetSrvrMsg failed: ${err instanceof Error ? err.message : String(err)}`, 'afp');
      }
    }
    const title = this.serverName || 'AFP server';
    if (code & (asp.AttnServerGoingDown | asp.AttnCrash)) {
      this.sawShutdown = true;
      const minutes = code & asp.AttnTimeMask;
      const when =
        minutes > 0
          ? `The server will disconnect in ${minutes} minute${minutes === 1 ? '' : 's'}.`
          : 'The server is disconnecting now.';
      this.emitNotice({
        kind: 'shutdown',
        title,
        text: [when, text].filter(Boolean).join('\n\n'),
        minutes,
      });
      return;
    }
    if (text) this.emitNotice({ kind: 'message', title, text });
  }

  static async probe(
    atp: AtpClient,
    network: number,
    node: number,
    socket: number,
  ): Promise<AfpServerInfo> {
    const sess = new AspSession(atp, network, node, socket);
    const status = await sess.getStatus();
    const info = cmd.parseServerInfo(status);
    log.info(
      `FPGetSrvrInfo “${info.serverName || '(unnamed)'}” versions=[${info.versions.join(', ')}] UAMs=[${info.uams.join(', ')}]`,
      'afp',
    );
    return info;
  }

  static async openSession(
    atp: AtpClient,
    network: number,
    node: number,
    socket: number,
  ): Promise<AfpClient> {
    const sess = new AspSession(atp, network, node, socket);
    const status = await sess.getStatus();
    const info = cmd.parseServerInfo(status);
    log.info(
      `FPGetSrvrInfo “${info.serverName || '(unnamed)'}” versions=[${info.versions.join(', ')}] UAMs=[${info.uams.join(', ')}]`,
      'afp',
    );
    await sess.open();
    log.info(`ASP session open to “${info.serverName || 'AFP server'}”`, 'afp');
    const client = new AfpClient(sess);
    client.serverName = info.serverName;
    client.versions = info.versions;
    client.uams = info.uams;
    client.version = cmd.pickAfpVersion(info.versions);
    client.supportsSrvrMsg = (info.flags & C.SrvrInfoSupportsSrvrMsg) !== 0;
    return client;
  }

  /**
   * Guest login + first (or named) volume. Kept for simple callers.
   * Real Mac servers that require a password will throw.
   */
  static async connect(
    atp: AtpClient,
    network: number,
    node: number,
    socket: number,
    volume?: string,
  ): Promise<AfpClient> {
    const client = await AfpClient.openSession(atp, network, node, socket);
    await client.login({ kind: 'guest' });
    const volName = volume ?? client.volumes[0]?.name;
    if (!volName) throw new Error('no volumes');
    await client.openVolume(volName);
    return client;
  }

  async login(creds: AfpCredentials): Promise<void> {
    if (creds.kind === 'guest') {
      const uam = cmd.pickGuestUam(this.uams);
      log.info(`FPLogin guest (${this.version}, ${uam})`, 'afp');
      const login = await this.sess.command(cmd.loginGuest(this.version, uam));
      this.assertLoginOk(login.result, 'FPLogin');
    } else {
      await this.loginPassword(creds.username, creds.password);
    }
    this.loggedIn = true;
    await this.refreshVolumes();
  }

  private async loginPassword(username: string, password: string): Promise<void> {
    const advertisedClear = this.uams.some(
      (u) => u.toLowerCase() === C.UAMCleartxtPasswrd.toLowerCase() || /cleartxt/i.test(u),
    );
    const twoWay = cmd.matchUam(this.uams, /2[- ]way.*randnum/i);
    const randnum = cmd.matchUam(this.uams, /randnum/i);

    // OmniTalk LoginNegotiated: password login uses the advertised cleartext UAM
    // verbatim (System 7 silently ignores a version/UAM it did not advertise).
    if (advertisedClear || (!twoWay && !randnum)) {
      const uam = cmd.pickCleartextUam(this.uams);
      log.info(`FPLogin user “${username}” via ${uam} (${this.version})`, 'afp');
      const login = await this.sess.command(cmd.loginCleartext(username, password, this.version, uam));
      this.assertLoginOk(login.result, 'FPLogin');
      return;
    }
    if (randnum) {
      log.info(`FPLogin user “${username}” via ${randnum}`, 'afp');
      await this.loginRandnumUam(username, password, randnum, false);
      return;
    }
    if (twoWay) {
      log.info(`FPLogin user “${username}” via ${twoWay}`, 'afp');
      await this.loginRandnumUam(username, password, twoWay, true);
      return;
    }
    throw new Error(
      `No supported password UAM (server offers: ${this.uams.join(', ') || 'none'})`,
    );
  }

  private async loginRandnumUam(
    username: string,
    password: string,
    uam: string,
    twoWay: boolean,
  ): Promise<void> {
    const login = await this.sess.command(cmd.loginRandnum(username, this.version, uam));
    if (login.result !== C.ErrAuthContinue) {
      this.assertLoginOk(login.result, 'FPLogin');
      return;
    }
    const { id, nonce } = cmd.parseAuthContinue(login.data);
    log.info(`FPLogin AuthContinue id=${id} nonce=${nonce.length}b`, 'afp');
    const key = passwordKey(password, twoWay);
    const encrypted = desEncryptBlock(nonce, key);
    let auth = encrypted;
    if (twoWay) {
      const clientNonce = new Uint8Array(8);
      crypto.getRandomValues(clientNonce);
      auth = new Uint8Array(16);
      auth.set(encrypted, 0);
      auth.set(clientNonce, 8);
    }
    const cont = await this.sess.command(cmd.loginCont(id, auth));
    this.assertLoginOk(cont.result, 'FPLoginCont');
  }

  private assertLoginOk(result: number, what: string): void {
    if (result === C.NoErr) return;
    const name = C.afpResultName(result);
    log.error(`${what} failed: ${name} (${result})`, 'afp');
    throw new Error(`${what} ${name} (${result})`);
  }

  async refreshVolumes(): Promise<{ flags: number; name: string }[]> {
    const parms = await this.sess.command(cmd.getSrvrParms());
    if (parms.result !== C.NoErr) {
      throw new Error(`FPGetSrvrParms ${C.afpResultName(parms.result)} (${parms.result})`);
    }
    const parsed = cmd.parseSrvrParms(parms.data);
    this.volumes = parsed.volumes;
    if (this.volumes.length === 0) {
      log.warn(
        `FPGetSrvrParms empty (result=${parms.result} ${parms.data.length}b ${[...parms.data].map((x) => x.toString(16).padStart(2, '0')).join(' ')})`,
        'afp',
      );
    }
    log.info(
      `FPGetSrvrParms ${this.volumes.length} volume(s): ${this.volumes.map((v) => v.name).join(', ') || '(none)'}`,
      'afp',
    );
    return this.volumes;
  }

  async openVolume(name: string): Promise<number> {
    const already = this.openVolIds.get(name);
    if (already != null) {
      this.volId = already;
      this.volumeName = name;
      return already;
    }
    log.info(`FPOpenVol “${name}”`, 'afp');
    const ov = await this.sess.command(cmd.openVol(name));
    if (ov.result !== C.NoErr) {
      throw new Error(`FPOpenVol ${C.afpResultName(ov.result)} (${ov.result})`);
    }
    const { volId } = cmd.parseOpenVol(ov.data);
    this.openVolIds.set(name, volId);
    this.volId = volId;
    this.volumeName = name;
    log.info(`Opened volume “${name}” (id ${volId})`, 'afp');
    if (this.supportsSrvrMsg) {
      try {
        const r = await this.sess.command(cmd.getSrvrMsg(C.SrvrMsgTypeLogin));
        if (r.result === C.NoErr) {
          const greeting = cmd.parseGetSrvrMsg(r.data).text.trim();
          if (greeting) {
            this.emitNotice({
              kind: 'message',
              title: this.serverName || 'AFP server',
              text: greeting,
            });
          }
        }
      } catch {
        /* optional greeting */
      }
    }
    return volId;
  }

  /** Volume id for an already-opened volume name. */
  volumeId(name: string): number {
    return this.openVolIds.get(name) ?? 0;
  }

  private vid(volId?: number): number {
    return volId && volId > 0 ? volId : this.volId;
  }

  async list(dirId = C.CNIDRoot, path = '', volId?: number): Promise<cmd.DirEntry[]> {
    const vol = this.vid(volId);
    if (!vol) return [];
    const all: cmd.DirEntry[] = [];
    let start = 1;
    for (;;) {
      const r = await this.sess.command(
        cmd.enumerate(
          vol,
          dirId,
          cmd.DEFAULT_FILE_BITMAP,
          cmd.DEFAULT_DIR_BITMAP,
          20,
          start,
          4000,
          path,
        ),
        { bitmap: 0xff },
      );
      if (r.result === C.ErrObjectNotFnd) break;
      if (r.result !== C.NoErr) throw new Error(`FPEnumerate ${r.result}`);
      const batch = cmd.parseEnumerate(r.data, cmd.DEFAULT_FILE_BITMAP, cmd.DEFAULT_DIR_BITMAP);
      if (batch.length === 0) break;
      all.push(...batch);
      start += batch.length;
      if (batch.length < 20) break;
    }
    return all;
  }

  async mkdir(name: string, dirId = C.CNIDRoot, volId?: number): Promise<void> {
    const r = await this.sess.command(cmd.createDir(this.vid(volId), dirId, name));
    if (r.result !== C.NoErr) throw new Error(`FPCreateDir ${r.result}`);
  }

  async remove(path: string, dirId = C.CNIDRoot, volId?: number): Promise<void> {
    const r = await this.sess.command(cmd.deletePath(this.vid(volId), dirId, path));
    if (r.result !== C.NoErr) throw new Error(`FPDelete ${r.result}`);
  }

  async rename(path: string, newName: string, dirId = C.CNIDRoot, volId?: number): Promise<void> {
    const r = await this.sess.command(cmd.rename(this.vid(volId), dirId, path, newName));
    if (r.result !== C.NoErr) throw new Error(`FPRename ${r.result}`);
  }

  async moveAndRename(
    srcDir: number,
    srcName: string,
    dstDir: number,
    newName: string,
    volId?: number,
  ): Promise<void> {
    const r = await this.sess.command(cmd.moveAndRename(this.vid(volId), srcDir, srcName, dstDir, newName));
    if (r.result !== C.NoErr) {
      throw new Error(`FPMoveAndRename ${C.afpResultName(r.result)} (${r.result})`);
    }
  }

  async readFile(path: string, dirId = C.CNIDRoot, resource = false, volId?: number): Promise<Uint8Array> {
    const flag = resource ? C.ForkFlagResource : C.ForkFlagData;
    const open = await this.sess.command(
      cmd.openFork(this.vid(volId), dirId, C.FileBitmapDataForkLen | C.FileBitmapRsrcForkLen, C.AccessRead, flag, path),
    );
    if (open.result !== C.NoErr) throw new Error(`FPOpenFork ${open.result}`);
    const { forkRef } = cmd.parseOpenFork(open.data);
    const chunks: Uint8Array[] = [];
    let offset = 0;
    try {
      for (;;) {
        const rr = await this.sess.command(cmd.readFork(forkRef, offset, 4096), { bitmap: 0xff });
        if (rr.result === C.ErrEOFErr) {
          if (rr.data.length) chunks.push(rr.data);
          break;
        }
        if (rr.result !== C.NoErr) throw new Error(`FPRead ${rr.result}`);
        if (rr.data.length === 0) break;
        chunks.push(rr.data);
        offset += rr.data.length;
        if (rr.data.length < 4096) break;
      }
    } finally {
      await this.sess.command(cmd.closeFork(forkRef));
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    dirId = C.CNIDRoot,
    resource = false,
    volId?: number,
  ): Promise<void> {
    const vol = this.vid(volId);
    const cr = await this.sess.command(cmd.createFile(vol, dirId, path, 0));
    if (cr.result !== C.NoErr && cr.result !== C.ErrObjectExists) {
      throw new Error(`FPCreateFile ${cr.result}`);
    }
    const flag = resource ? C.ForkFlagResource : C.ForkFlagData;
    const open = await this.sess.command(
      cmd.openFork(vol, dirId, 0, C.AccessRead | C.AccessWrite, flag, path),
    );
    if (open.result !== C.NoErr) throw new Error(`FPOpenFork ${open.result}`);
    const { forkRef } = cmd.parseOpenFork(open.data);
    try {
      // ASP Write quantum; keep under ATP multi-packet budget (OmniTalk QuantumSize).
      const chunkSize = 4096;
      let offset = 0;
      while (offset < data.length) {
        const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
        const wr = await this.sess.write(cmd.writeFork(forkRef, offset, chunk.length), chunk);
        if (wr.result !== C.NoErr) throw new Error(`FPWrite ${wr.result}`);
        const last = cmd.parseWriteReply(wr.data);
        offset = last > offset ? last : offset + chunk.length;
      }
    } finally {
      await this.sess.command(cmd.closeFork(forkRef));
    }
  }

  async setFinderInfo(path: string, finderInfo: Uint8Array, dirId = C.CNIDRoot, volId?: number): Promise<void> {
    const r = await this.sess.command(
      cmd.setFileDirParms(this.vid(volId), dirId, C.FDBitmapFinderInfo, path, finderInfo),
    );
    if (r.result !== C.NoErr) throw new Error(`FPSetFileDirParms ${r.result}`);
  }

  async close(): Promise<void> {
    if (this.loggedIn) {
      await this.sess.command(cmd.logout()).catch(() => undefined);
      this.loggedIn = false;
    }
    this.volId = 0;
    this.volumeName = '';
    this.volumes = [];
    this.openVolIds.clear();
    await this.sess.close();
  }
}

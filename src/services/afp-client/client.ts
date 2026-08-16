/** High-level AFP client: session login, then one open volume. */

import { AspSession } from '../asp-client';
import type { AtpClient } from '../atp-client';
import * as asp from '../../protocol/asp';
import * as C from '../../protocol/afp/constants';
import * as cmd from './commands';
import { desEncryptBlock } from '../../hash/des';
import { encodeMacRoman, decodeMacRoman } from '../../protocol/macroman';
import { be16, be32 } from '../../protocol/binary';
import { log } from '../../util/logger';
import { AsyncSemaphore } from '../../util/async-semaphore';

/** Keep OpenFork sessions (and other long AFP tasks) from flooding a classic server. */
const MAX_PARALLEL_TASKS = 3;

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
  private inFlight = 0;
  private readonly tasks = new AsyncSemaphore(MAX_PARALLEL_TASKS);

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

  private fpDetail(block: Uint8Array): string {
    const op = block[0] ?? 0;
    try {
      if (op === C.CmdEnumerate && block.length >= 16) {
        return ` vol=${be16(block, 2)} did=${be32(block, 4)} start=${be16(block, 14)} n=${be16(block, 12)}`;
      }
      if (op === C.CmdOpenFork && block.length >= 13) {
        return ` ${block[1]! & 0x80 ? 'rsrc' : 'data'} did=${be32(block, 4)}`;
      }
      if ((op === C.CmdRead || op === C.CmdWrite) && block.length >= 12) {
        return ` fork=${be16(block, 2)} off=${be32(block, 4)} n=${be32(block, 8)}`;
      }
      if (op === C.CmdOpenVol && block.length >= 5) {
        const n = block[4]!;
        return ` “${decodeMacRoman(block.subarray(5, 5 + n))}”`;
      }
      if (op === C.CmdCloseFork && block.length >= 4) {
        return ` fork=${be16(block, 2)}`;
      }
      if (op === C.CmdGetFileDirParms && block.length >= 12) {
        return ` did=${be32(block, 4)}`;
      }
    } catch {
      /* keep name only */
    }
    return '';
  }

  private async fp(
    block: Uint8Array,
    opts?: { bitmap?: number; timeoutMs?: number },
  ): Promise<{ result: number; data: Uint8Array }> {
    const name = C.afpCmdName(block[0] ?? 0);
    const detail = this.fpDetail(block);
    this.inFlight++;
    const t0 = performance.now();
    log.trace(`→ ${name}${detail} ${block.length}b inFlight=${this.inFlight}`, 'afp');
    try {
      const r = await this.sess.command(block, opts);
      log.trace(
        `← ${name}${detail} ${C.afpResultName(r.result)} ${r.data.length}b ${Math.round(performance.now() - t0)}ms`,
        'afp',
      );
      return r;
    } catch (err) {
      log.trace(
        `← ${name}${detail} error ${err instanceof Error ? err.message : String(err)} ${Math.round(performance.now() - t0)}ms`,
        'afp',
      );
      throw err;
    } finally {
      this.inFlight--;
    }
  }

  private async fpWrite(
    cmdBlock: Uint8Array,
    writeData: Uint8Array,
  ): Promise<{ result: number; data: Uint8Array }> {
    const name = C.afpCmdName(cmdBlock[0] ?? 0);
    const detail = this.fpDetail(cmdBlock);
    this.inFlight++;
    const t0 = performance.now();
    log.trace(
      `→ ${name}${detail} hdr=${cmdBlock.length}b data=${writeData.length}b inFlight=${this.inFlight}`,
      'afp',
    );
    try {
      const r = await this.sess.write(cmdBlock, writeData);
      log.trace(
        `← ${name}${detail} ${C.afpResultName(r.result)} ${r.data.length}b ${Math.round(performance.now() - t0)}ms`,
        'afp',
      );
      return r;
    } catch (err) {
      log.trace(
        `← ${name}${detail} error ${err instanceof Error ? err.message : String(err)} ${Math.round(performance.now() - t0)}ms`,
        'afp',
      );
      throw err;
    } finally {
      this.inFlight--;
    }
  }

  private async handleAttention(code: number): Promise<void> {
    log.info(`ASP attention 0x${(code & 0xffff).toString(16)}`, 'afp');
    let text = '';
    if (code & asp.AttnMsg) {
      try {
        const r = await this.fp(cmd.getSrvrMsg(C.SrvrMsgTypeServer));
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
      const login = await this.fp(cmd.loginGuest(this.version, uam));
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

    // ClassicStack LoginNegotiated: password login uses the advertised cleartext UAM
    // verbatim (System 7 silently ignores a version/UAM it did not advertise).
    if (advertisedClear || (!twoWay && !randnum)) {
      const uam = cmd.pickCleartextUam(this.uams);
      log.info(`FPLogin user “${username}” via ${uam} (${this.version})`, 'afp');
      const login = await this.fp(cmd.loginCleartext(username, password, this.version, uam));
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
    const login = await this.fp(cmd.loginRandnum(username, this.version, uam));
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
    const cont = await this.fp(cmd.loginCont(id, auth));
    this.assertLoginOk(cont.result, 'FPLoginCont');
  }

  private assertLoginOk(result: number, what: string): void {
    if (result === C.NoErr) return;
    const name = C.afpResultName(result);
    log.error(`${what} failed: ${name} (${result})`, 'afp');
    throw new Error(`${what} ${name} (${result})`);
  }

  async refreshVolumes(): Promise<{ flags: number; name: string }[]> {
    const parms = await this.fp(cmd.getSrvrParms());
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
    const ov = await this.fp(cmd.openVol(name));
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
        const r = await this.fp(cmd.getSrvrMsg(C.SrvrMsgTypeLogin));
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

  async list(
    dirId = C.CNIDRoot,
    path = '',
    volId?: number,
    onBatch?: (batch: cmd.DirEntry[]) => void | Promise<void>,
  ): Promise<cmd.DirEntry[]> {
    return this.tasks.run(() => this.listUnlocked(dirId, path, volId, onBatch));
  }

  private async listUnlocked(
    dirId: number,
    path: string,
    volId?: number,
    onBatch?: (batch: cmd.DirEntry[]) => void | Promise<void>,
  ): Promise<cmd.DirEntry[]> {
    const vol = this.vid(volId);
    if (!vol) return [];
    return cmd.collectEnumeratePages(async (start) => {
      const r = await this.fp(
        cmd.enumerate(
          vol,
          dirId,
          cmd.DEFAULT_FILE_BITMAP,
          cmd.DEFAULT_DIR_BITMAP,
          cmd.ENUMERATE_REQ_COUNT,
          start,
          4000,
          path,
        ),
        { bitmap: 0xff },
      );
      if (r.result === C.ErrObjectNotFnd) return null;
      if (r.result !== C.NoErr) throw new Error(`FPEnumerate ${r.result}`);
      return cmd.parseEnumerate(r.data, cmd.DEFAULT_FILE_BITMAP, cmd.DEFAULT_DIR_BITMAP);
    }, onBatch);
  }

  async stat(dirId: number, path: string, volId?: number): Promise<cmd.DirEntry | undefined> {
    return this.tasks.run(() => this.statUnlocked(dirId, path, volId));
  }

  private async statUnlocked(dirId: number, path: string, volId?: number): Promise<cmd.DirEntry | undefined> {
    const vol = this.vid(volId);
    if (!vol) return undefined;
    const r = await this.fp(
      cmd.getFileDirParms(vol, dirId, cmd.DEFAULT_FILE_BITMAP, cmd.DEFAULT_DIR_BITMAP, path),
    );
    if (r.result === C.ErrObjectNotFnd) return undefined;
    if (r.result !== C.NoErr) {
      throw new Error(`FPGetFileDirParms ${C.afpResultName(r.result)} (${r.result})`);
    }
    const entry = cmd.parseGetFileDirParms(r.data, cmd.DEFAULT_FILE_BITMAP, cmd.DEFAULT_DIR_BITMAP);
    if (entry && !entry.name) entry.name = path.replace(/^\/+|\/+$/g, '') || path;
    return entry;
  }

  /**
   * Open a fork, run `fn`, then FPCloseFork. Close always runs after a successful
   * OpenFork (even when `fn` throws) so classic servers do not leak fork slots.
   */
  private async withOpenFork<T>(
    openCmd: Uint8Array,
    fn: (forkRef: number) => Promise<T>,
  ): Promise<T> {
    const open = await this.fp(openCmd);
    if (open.result !== C.NoErr) throw new Error(`FPOpenFork ${open.result}`);
    const { forkRef } = cmd.parseOpenFork(open.data);
    try {
      return await fn(forkRef);
    } finally {
      try {
        const closed = await this.fp(cmd.closeFork(forkRef));
        if (closed.result !== C.NoErr) {
          log.trace(`FPCloseFork ${forkRef} ${C.afpResultName(closed.result)}`, 'afp');
        }
      } catch (err) {
        log.trace(
          `FPCloseFork ${forkRef} error ${err instanceof Error ? err.message : String(err)}`,
          'afp',
        );
      }
    }
  }

  /**
   * Open a fork and run ranged FPReads (header / map / selected resources).
   */
  async withForkReader<T>(
    path: string,
    dirId: number,
    resource: boolean,
    fn: (read: (offset: number, count: number) => Promise<Uint8Array>) => Promise<T>,
    volId?: number,
  ): Promise<T> {
    return this.tasks.run(() => this.withForkReaderUnlocked(path, dirId, resource, fn, volId));
  }

  private async withForkReaderUnlocked<T>(
    path: string,
    dirId: number,
    resource: boolean,
    fn: (read: (offset: number, count: number) => Promise<Uint8Array>) => Promise<T>,
    volId?: number,
  ): Promise<T> {
    const flag = resource ? C.ForkFlagResource : C.ForkFlagData;
    return this.withOpenFork(
      cmd.openFork(this.vid(volId), dirId, 0, C.AccessRead, flag, path),
      async (forkRef) => {
        const read = async (offset: number, count: number): Promise<Uint8Array> => {
          const bitmap = count <= 578 ? 0x01 : 0xff;
          const rr = await this.fp(cmd.readFork(forkRef, offset, count), { bitmap });
          if (rr.result === C.ErrEOFErr) return rr.data;
          if (rr.result !== C.NoErr) throw new Error(`FPRead ${rr.result}`);
          return rr.data;
        };
        return await fn(read);
      },
    );
  }

  async mkdir(name: string, dirId = C.CNIDRoot, volId?: number): Promise<void> {
    const r = await this.fp(cmd.createDir(this.vid(volId), dirId, name));
    if (r.result !== C.NoErr) throw new Error(`FPCreateDir ${r.result}`);
  }

  async remove(path: string, dirId = C.CNIDRoot, volId?: number): Promise<void> {
    const r = await this.fp(cmd.deletePath(this.vid(volId), dirId, path));
    if (r.result !== C.NoErr) throw new Error(`FPDelete ${r.result}`);
  }

  async rename(path: string, newName: string, dirId = C.CNIDRoot, volId?: number): Promise<void> {
    const r = await this.fp(cmd.rename(this.vid(volId), dirId, path, newName));
    if (r.result !== C.NoErr) throw new Error(`FPRename ${r.result}`);
  }

  async moveAndRename(
    srcDir: number,
    srcName: string,
    dstDir: number,
    newName: string,
    volId?: number,
  ): Promise<void> {
    const r = await this.fp(cmd.moveAndRename(this.vid(volId), srcDir, srcName, dstDir, newName));
    if (r.result !== C.NoErr) {
      throw new Error(`FPMoveAndRename ${C.afpResultName(r.result)} (${r.result})`);
    }
  }

  async readFile(
    path: string,
    dirId = C.CNIDRoot,
    resource = false,
    volId?: number,
    onBytes?: (n: number) => void,
  ): Promise<Uint8Array> {
    return this.tasks.run(() => this.readFileUnlocked(path, dirId, resource, volId, onBytes));
  }

  private async readFileUnlocked(
    path: string,
    dirId: number,
    resource: boolean,
    volId?: number,
    onBytes?: (n: number) => void,
  ): Promise<Uint8Array> {
    const flag = resource ? C.ForkFlagResource : C.ForkFlagData;
    // ClassicStack client/afp: ask only for the length bit of the fork being
    // opened. System 7.5 PFS returns kFPBitmapErr if a data-fork open also
    // requests the resource-fork length bit (and vice versa).
    const lenBit = resource ? C.FileBitmapRsrcForkLen : C.FileBitmapDataForkLen;
    return this.withOpenFork(
      cmd.openFork(
        this.vid(volId),
        dirId,
        lenBit,
        C.AccessRead,
        flag,
        path,
      ),
      async (forkRef) => {
        const chunks: Uint8Array[] = [];
        let offset = 0;
        for (;;) {
          const rr = await this.fp(cmd.readFork(forkRef, offset, 4096), { bitmap: 0xff });
          if (rr.result === C.ErrEOFErr) {
            if (rr.data.length) {
              chunks.push(rr.data);
              onBytes?.(rr.data.length);
            }
            break;
          }
          if (rr.result !== C.NoErr) throw new Error(`FPRead ${rr.result}`);
          if (rr.data.length === 0) break;
          chunks.push(rr.data);
          onBytes?.(rr.data.length);
          offset += rr.data.length;
          if (rr.data.length < 4096) break;
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.length;
        }
        return out;
      },
    );
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    dirId = C.CNIDRoot,
    resource = false,
    volId?: number,
    onBytes?: (n: number) => void,
  ): Promise<void> {
    return this.tasks.run(() => this.writeFileUnlocked(path, data, dirId, resource, volId, onBytes));
  }

  private async writeFileUnlocked(
    path: string,
    data: Uint8Array,
    dirId: number,
    resource: boolean,
    volId?: number,
    onBytes?: (n: number) => void,
  ): Promise<void> {
    const vol = this.vid(volId);
    const cr = await this.fp(cmd.createFile(vol, dirId, path, 0));
    if (cr.result !== C.NoErr && cr.result !== C.ErrObjectExists) {
      throw new Error(`FPCreateFile ${cr.result}`);
    }
    const flag = resource ? C.ForkFlagResource : C.ForkFlagData;
    await this.withOpenFork(
      cmd.openFork(vol, dirId, 0, C.AccessRead | C.AccessWrite, flag, path),
      async (forkRef) => {
        // ASP Write quantum; keep under ATP multi-packet budget (ClassicStack QuantumSize).
        const chunkSize = 4096;
        let offset = 0;
        while (offset < data.length) {
          const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
          const wr = await this.fpWrite(cmd.writeFork(forkRef, offset, chunk.length), chunk);
          if (wr.result !== C.NoErr) throw new Error(`FPWrite ${wr.result}`);
          const last = cmd.parseWriteReply(wr.data);
          const next = last > offset ? last : offset + chunk.length;
          onBytes?.(next - offset);
          offset = next;
        }
      },
    );
  }

  async setFinderInfo(
    path: string,
    finderInfo: Uint8Array,
    dirId = C.CNIDRoot,
    volId?: number,
    dates?: { createDate?: number; modDate?: number },
  ): Promise<void> {
    let bitmap = C.FDBitmapFinderInfo;
    if (dates?.createDate) bitmap |= C.FDBitmapCreateDate;
    if (dates?.modDate) bitmap |= C.FDBitmapModDate;
    const r = await this.fp(cmd.setFileDirParms(this.vid(volId), dirId, bitmap, path, finderInfo, dates));
    if (r.result !== C.NoErr) throw new Error(`FPSetFileDirParms ${r.result}`);
  }

  async close(): Promise<void> {
    if (this.loggedIn) {
      await this.fp(cmd.logout()).catch(() => undefined);
      this.loggedIn = false;
    }
    this.volId = 0;
    this.volumeName = '';
    this.volumes = [];
    this.openVolIds.clear();
    await this.sess.close();
  }
}

/** AFP server over ASP/ATP — one volume backed by VirtualFS. */

import * as asp from '../../protocol/asp';
import * as C from '../../protocol/afp/constants';
import { appendBe16, appendBe32, be16, be32, writeBe16, writeBe32 } from '../../protocol/binary';
import { encodeMacRoman, decodeMacRoman } from '../../protocol/macroman';
import { AtpServer, type AtpIncoming, type AtpResponse } from '../atp-server';
import type { LocalTalkStack } from '../../net/stack';
import type { VirtualFS, VNode } from '../../fs/virtual-fs';
import { log } from '../../util/logger';
import * as atp from '../../protocol/atp';

function afpCmdName(cmd: number): string {
  return C.afpCmdName(cmd);
}

function afpResultName(result: number): string {
  const s = result | 0;
  if (s === C.NoErr) return 'NoErr';
  if (s === C.ErrObjectNotFnd) return 'ObjectNotFound';
  if (s === C.ErrParamErr) return 'ParamErr';
  if (s === C.ErrCallNotSuppt) return 'CallNotSupported';
  if (s === C.ErrAccessDenied) return 'AccessDenied';
  if (s === C.ErrEOFErr) return 'EOFErr';
  if (s === C.ErrBitmapErr) return 'BitmapErr';
  return String(s);
}

interface Session {
  id: number;
  wss: number;
  sss: number;
  peerNet: number;
  peerNode: number;
  loggedIn: boolean;
  userName: string;
  volId: number;
  forks: Map<number, { nodeId: number; resource: boolean; offset: number; name: string }>;
  nextFork: number;
  dtRef: number;
  atp: AtpServer;
  serverMsg: string;
  lastRx: number;
  closed: boolean;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface AfpSessionInfo {
  id: number;
  network: number;
  node: number;
  loggedIn: boolean;
  userName: string;
  lastSeen: number;
}

export interface AfpOpenFileInfo {
  sessionId: number;
  userName: string;
  forkRef: number;
  name: string;
  resource: boolean;
}

const MESSAGE_FETCH_GRACE_MS = 1500;

/** In-flight ASP two-phase write (OmniTalk pendingWrite). */
interface PendingWrite {
  reply: (userData: number, data: Uint8Array) => Promise<void>;
  sess: Session;
  cmdBlk: Uint8Array;
  hdrLen: number;
  want: number;
  seq: number;
  data: Uint8Array;
  attempts: number;
  timer: ReturnType<typeof setInterval> | null;
}

export class AfpServer {
  private stack: LocalTalkStack;
  private fs: VirtualFS;
  private sls = asp.DefaultSLS;
  private sessionTable = new Map<number, Session>();
  private nextSession = 1;
  private nextSss = 200;
  private volumeName: string;
  private serverName: string;
  private pendingWrites = new Map<number, PendingWrite>();
  private nextWriteTid = 1;

  constructor(stack: LocalTalkStack, fs: VirtualFS, opts?: { volumeName?: string; serverName?: string }) {
    this.stack = stack;
    this.fs = fs;
    this.volumeName = opts?.volumeName ?? 'Browser Share';
    this.serverName = opts?.serverName ?? 'ClassicStack';
    new AtpServer(stack, this.sls, (req) => this.onSls(req));
  }

  socket(): number {
    return this.sls;
  }

  listSessions(): AfpSessionInfo[] {
    return [...this.sessionTable.values()]
      .filter((s) => !s.closed)
      .sort((a, b) => a.id - b.id)
      .map((s) => ({
        id: s.id,
        network: s.peerNet,
        node: s.peerNode,
        loggedIn: s.loggedIn,
        userName: s.userName,
        lastSeen: s.lastRx,
      }));
  }

  listOpenFiles(): AfpOpenFileInfo[] {
    const out: AfpOpenFileInfo[] = [];
    for (const s of this.sessionTable.values()) {
      if (s.closed) continue;
      for (const [forkRef, fork] of s.forks) {
        out.push({
          sessionId: s.id,
          userName: s.userName,
          forkRef,
          name: fork.name,
          resource: fork.resource,
        });
      }
    }
    out.sort((a, b) => a.sessionId - b.sessionId || a.forkRef - b.forkRef);
    return out;
  }

  /** Push a server message (id 0 = every live session). Macintosh clients fetch via FPGetSrvrMsg. */
  async sendMessage(sessionId: number, text: string): Promise<void> {
    const targets = this.targetSessions(sessionId);
    for (const sess of targets) {
      sess.serverMsg = text;
      await this.sendAttention(sess, asp.AttnMsg);
    }
  }

  /**
   * Disconnect with optional warning text (AppleShare two-phase attention).
   * minutes 0 = disconnect after the fetch grace.
   */
  async disconnectSession(sessionId: number, text: string, minutes: number): Promise<void> {
    const targets = this.targetSessions(sessionId);
    const mins = Math.max(0, minutes | 0);
    let code = asp.AttnServerGoingDown | asp.AttnNoReconnect | asp.attnTime(mins);
    if (text) code |= asp.AttnMsg;
    for (const sess of targets) {
      if (text) sess.serverMsg = text;
      await this.sendAttention(sess, code);
      this.scheduleDisconnect(sess, !!text, mins * 60_000);
    }
  }

  private targetSessions(sessionId: number): Session[] {
    if (sessionId !== 0) {
      const sess = this.sessionTable.get(sessionId);
      if (!sess || sess.closed) throw new Error('AFP: no such session');
      return [sess];
    }
    return [...this.sessionTable.values()].filter((s) => !s.closed);
  }

  private scheduleDisconnect(sess: Session, hasMsg: boolean, waitMs: number): void {
    if (sess.disconnectTimer) clearTimeout(sess.disconnectTimer);
    const finish = () => {
      void this.finishDisconnect(sess, hasMsg, waitMs > 0);
    };
    if (waitMs > 0) {
      sess.disconnectTimer = setTimeout(finish, waitMs);
    } else {
      finish();
    }
  }

  private async finishDisconnect(sess: Session, hasMsg: boolean, sendFinal: boolean): Promise<void> {
    sess.disconnectTimer = null;
    if (sess.closed) return;
    if (sendFinal) {
      let code = asp.AttnServerGoingDown | asp.AttnNoReconnect;
      if (hasMsg) code |= asp.AttnMsg;
      await this.sendAttention(sess, code);
    }
    if (hasMsg) {
      await new Promise((r) => setTimeout(r, MESSAGE_FETCH_GRACE_MS));
      if (sess.closed) return;
    }
    await this.sendCloseSession(sess);
    this.teardownSession(sess);
  }

  private teardownSession(sess: Session): void {
    if (sess.closed) return;
    sess.closed = true;
    if (sess.disconnectTimer) {
      clearTimeout(sess.disconnectTimer);
      sess.disconnectTimer = null;
    }
    this.sessionTable.delete(sess.id);
    log.info(`AFP session ${sess.id} closed (${sess.peerNet}.${sess.peerNode})`, 'afp');
  }

  private allocTid(): number {
    let tid = this.nextWriteTid++ & 0xffff;
    if (tid === 0) tid = this.nextWriteTid++ & 0xffff;
    while (this.pendingWrites.has(tid)) {
      tid = this.nextWriteTid++ & 0xffff;
      if (tid === 0) tid = this.nextWriteTid++ & 0xffff;
    }
    return tid;
  }

  private async sendAttention(sess: Session, code: number): Promise<void> {
    if (sess.closed || !code) return;
    const pkt = atp.encodePacket(
      {
        control: atp.TREQ,
        bitmap: 0x01,
        transId: this.allocTid(),
        userData: asp.packAttention(sess.id, code),
      },
      new Uint8Array(),
    );
    await sess.atp.sendTo(sess.peerNet, sess.peerNode, sess.wss, pkt);
  }

  private async sendCloseSession(sess: Session): Promise<void> {
    if (sess.closed) return;
    const pkt = atp.encodePacket(
      {
        control: atp.TREQ,
        bitmap: 0x01,
        transId: this.allocTid(),
        userData: asp.packClose(sess.id),
      },
      new Uint8Array(),
    );
    await sess.atp.sendTo(sess.peerNet, sess.peerNode, sess.wss, pkt);
  }

  private async onSls(req: AtpIncoming): Promise<void> {
    const { spFunc, b1, word } = asp.unpackUserData(req.header.userData);
    if (spFunc === asp.SPFuncGetStatus) {
      await req.reply(0, this.serverInfoBlock());
      return;
    }
    if (spFunc === asp.SPFuncOpenSess) {
      if (word !== asp.Version) {
        await req.reply(asp.packOpenReply(0, 0, asp.SPErrorBadVersNum), new Uint8Array());
        return;
      }
      const sid = this.nextSession++ & 0xff;
      if (sid === 0) this.nextSession = 1;
      const sss = this.nextSss++ & 0xff;
      if (sss < 200) this.nextSss = 200;
      let sess!: Session;
      const atpServer = new AtpServer(this.stack, sss, (r) => this.onSession(sess, r));
      sess = {
        id: sid,
        wss: b1,
        sss,
        peerNet: req.dg.srcNetwork,
        peerNode: req.dg.srcNode,
        loggedIn: false,
        userName: '',
        volId: 0,
        forks: new Map(),
        nextFork: 1,
        dtRef: 0,
        atp: atpServer,
        serverMsg: '',
        lastRx: Date.now(),
        closed: false,
        disconnectTimer: null,
      };
      atpServer.setResponseHandler((resp) => this.onWriteDataResponse(resp));
      this.sessionTable.set(sid, sess);
      await req.reply(asp.packOpenReply(sss, sid, 0), new Uint8Array());
      return;
    }
  }

  private async onSession(sess: Session, req: AtpIncoming): Promise<void> {
    sess.lastRx = Date.now();
    const { spFunc, b1, word } = asp.unpackUserData(req.header.userData);
    if (b1 !== sess.id && spFunc !== asp.SPFuncTickle) {
      // still process tickles / close
    }
    if (spFunc === asp.SPFuncTickle) {
      await req.reply(0, new Uint8Array());
      return;
    }
    if (spFunc === asp.SPFuncCloseSess) {
      this.teardownSession(sess);
      await req.reply(0, new Uint8Array());
      return;
    }
    if (spFunc === asp.SPFuncWrite) {
      await this.handleAspWrite(sess, req, word);
      return;
    }
    if (spFunc === asp.SPFuncCommand) {
      const block = req.data;
      if (block.length < 1) {
        await req.reply(C.ErrParamErr >>> 0, new Uint8Array());
        return;
      }
      const [body, result] = await this.dispatch(sess, block, false);
      await req.reply(result >>> 0, body);
      return;
    }
    void word;
  }

  /**
   * ASP two-phase write (OmniTalk handleWrite):
   * phase 1 — client sends FPWrite/FPAddIcon header only
   * phase 2 — we TReq WriteContinue to WSS; client TResp's the data
   * phase 3 — we reply to the original aspWrite with the AFP result
   */
  private async handleAspWrite(sess: Session, req: AtpIncoming, seq: number): Promise<void> {
    const block = req.data;
    if (block.length > asp.ATPMaxData) {
      await req.reply(asp.SPErrorSizeErr >>> 0, new Uint8Array());
      return;
    }
    let { want, hdrLen } = writeDataCount(block);
    if (want <= 0) {
      const [body, result] = await this.dispatch(sess, block, true);
      await req.reply(result >>> 0, body);
      return;
    }
    if (want > asp.QuantumSize) want = asp.QuantumSize;

    const tid = this.allocTid();
    const pw: PendingWrite = {
      reply: req.reply,
      sess,
      cmdBlk: block.slice(),
      hdrLen,
      want,
      seq,
      data: new Uint8Array(),
      attempts: 0,
      timer: null,
    };
    this.pendingWrites.set(tid, pw);
    await this.sendWriteContinue(sess, seq, tid, want);
    pw.timer = setInterval(() => {
      void this.retryWriteContinue(tid);
    }, 2000);
  }

  private async sendWriteContinue(sess: Session, seq: number, tid: number, want: number): Promise<void> {
    const nPackets = Math.min(Math.max(Math.ceil(want / atp.MaxATPData), 1), atp.MaxResponsePackets);
    const bitmap = (1 << nPackets) - 1;
    // TREQ|XO with TRel timeout indicator 0 (30s) in low bits.
    const pkt = atp.encodePacket(
      {
        control: atp.TREQ | atp.XO,
        bitmap,
        transId: tid,
        userData: asp.packWriteContinue(sess.id, seq),
      },
      asp.writeContinuePayload(want),
    );
    await sess.atp.sendTo(sess.peerNet, sess.peerNode, sess.wss, pkt);
  }

  private async retryWriteContinue(tid: number): Promise<void> {
    const pw = this.pendingWrites.get(tid);
    if (!pw) return;
    pw.attempts++;
    if (pw.attempts >= 8) {
      this.clearPendingWrite(tid);
      await pw.reply(asp.SPErrorParamErr >>> 0, new Uint8Array());
      return;
    }
    await this.sendWriteContinue(pw.sess, pw.seq, tid, pw.want);
  }

  private clearPendingWrite(tid: number): void {
    const pw = this.pendingWrites.get(tid);
    if (!pw) return;
    if (pw.timer) clearInterval(pw.timer);
    this.pendingWrites.delete(tid);
  }

  private async onWriteDataResponse(resp: AtpResponse): Promise<void> {
    const tid = resp.header.transId;
    const pw = this.pendingWrites.get(tid);
    if (!pw) return;

    const merged = new Uint8Array(pw.data.length + resp.data.length);
    merged.set(pw.data);
    merged.set(resp.data, pw.data.length);
    pw.data = merged.length > pw.want ? merged.subarray(0, pw.want) : merged;

    if (!resp.eom && pw.data.length < pw.want) return;

    this.clearPendingWrite(tid);
    // Release the XO WriteContinue transaction.
    const trel = atp.encodePacket({ control: atp.TREL, bitmap: 0, transId: tid, userData: 0 });
    await pw.sess.atp.sendTo(pw.sess.peerNet, pw.sess.peerNode, pw.sess.wss, trel);

    const block = appendWriteData(pw.cmdBlk, pw.hdrLen, pw.data);
    const [body, result] = await this.dispatch(pw.sess, block, true);
    await pw.reply(result >>> 0, body);
  }

  private async dispatch(sess: Session, block: Uint8Array, isWrite: boolean): Promise<[Uint8Array, number]> {
    const cmd = block[0]!;
    const detail = this.traceDetail(cmd, block);
    try {
      let reply: [Uint8Array, number];
      switch (cmd) {
        case C.CmdLogin:
          reply = this.login(sess, block);
          break;
        case C.CmdLogout:
          sess.loggedIn = false;
          reply = [new Uint8Array(), C.NoErr];
          break;
        case C.CmdGetSrvrParms:
          reply = this.getSrvrParms();
          break;
        case C.CmdGetSrvrMsg:
          reply = this.getSrvrMsg(sess, block);
          break;
        case C.CmdOpenVol:
          reply = this.openVol(sess, block);
          break;
        case C.CmdCloseVol:
          sess.volId = 0;
          reply = [new Uint8Array(), C.NoErr];
          break;
        case C.CmdEnumerate:
          reply = await this.enumerate(block);
          break;
        case C.CmdCreateDir:
          reply = await this.createDir(block);
          break;
        case C.CmdCreateFile:
          reply = await this.createFile(block);
          break;
        case C.CmdDelete:
          reply = await this.deletePath(block);
          break;
        case C.CmdRename:
          reply = await this.rename(block);
          break;
        case C.CmdOpenFork:
          reply = await this.openFork(sess, block);
          break;
        case C.CmdRead:
          reply = await this.readFork(sess, block);
          break;
        case C.CmdWrite:
          reply = await this.writeFork(sess, block, isWrite);
          break;
        case C.CmdCloseFork:
          reply = this.closeFork(sess, block);
          break;
        case C.CmdSetForkParms:
          reply = await this.setForkParms(sess, block);
          break;
        case C.CmdGetForkParms:
          reply = await this.getForkParms(sess, block);
          break;
        case C.CmdFlush:
        case C.CmdFlushFork:
          reply = [new Uint8Array(), C.NoErr];
          break;
        case C.CmdSetFileDirParms:
        case C.CmdSetFileParms:
        case C.CmdSetDirParms:
          reply = await this.setParms(block);
          break;
        case C.CmdGetFileDirParms:
          reply = await this.getParms(block);
          break;
        case C.CmdGetVolParms:
          reply = this.getVolParms(sess, block);
          break;
        case C.CmdOpenDT:
          sess.dtRef = 1;
          {
            const out = new Uint8Array(2);
            writeBe16(out, 0, 1);
            reply = [out, C.NoErr];
          }
          break;
        case C.CmdCloseDT:
          sess.dtRef = 0;
          reply = [new Uint8Array(), C.NoErr];
          break;
        case C.CmdAddIcon:
          reply = await this.addIcon(block, isWrite);
          break;
        case C.CmdGetIcon:
          reply = await this.getIcon(block);
          break;
        case C.CmdGetIconInfo:
          reply = await this.getIconInfo(block);
          break;
        case C.CmdAddAPPL:
        case C.CmdRemoveAPPL:
        case C.CmdGetAPPL:
          reply = [new Uint8Array(), C.ErrObjectNotFnd];
          break;
        default:
          reply = [new Uint8Array(), C.ErrCallNotSuppt];
          break;
      }
      const [body, result] = reply;
      log.info(
        `${afpCmdName(cmd)}${detail} → ${afpResultName(result)} (${body.length}b)`,
        'afp',
      );
      return reply;
    } catch (e) {
      log.error(`${afpCmdName(cmd)}${detail} threw: ${e instanceof Error ? e.message : String(e)}`, 'afp');
      console.error('AFP dispatch', cmd, e);
      return [new Uint8Array(), C.ErrParamErr];
    }
  }

  private traceDetail(cmd: number, block: Uint8Array): string {
    try {
      if (cmd === C.CmdOpenVol && block.length >= 5) {
        const nameLen = block[4]!;
        const name = decodeMacRoman(block.subarray(5, 5 + nameLen));
        return ` "${name}" bm=0x${be16(block, 2).toString(16)}`;
      }
      if (cmd === C.CmdCreateFile && block.length >= 9) {
        return ` did=${be32(block, 4)} name=${JSON.stringify(this.readPathName(block, 8))}`;
      }
      if (cmd === C.CmdOpenFork && block.length >= 13) {
        return ` did=${be32(block, 4)} name=${JSON.stringify(this.readPathName(block, 12))} bm=0x${be16(block, 8).toString(16)}`;
      }
      if (cmd === C.CmdWrite && block.length >= 12) {
        return ` ref=${be16(block, 2)} off=${be32(block, 4)} count=${be32(block, 8)} data=${Math.max(0, block.length - 12)}b`;
      }
      if (cmd === C.CmdGetFileDirParms && block.length >= 12) {
        return ` vol=${be16(block, 2)} did=${be32(block, 4)} fbm=0x${be16(block, 8).toString(16)} dbm=0x${be16(block, 10).toString(16)}`;
      }
      if (cmd === C.CmdGetVolParms && block.length >= 6) {
        return ` vol=${be16(block, 2)} bm=0x${be16(block, 4).toString(16)}`;
      }
      if (cmd === C.CmdEnumerate && block.length >= 16) {
        return ` did=${be32(block, 4)} idx=${be16(block, 14)}`;
      }
    } catch {
      /* ignore */
    }
    return '';
  }

  private login(sess: Session, block: Uint8Array): [Uint8Array, number] {
    // FPLogin: cmd + AFPVersion pstring + UAM pstring + optional userName pstring
    sess.userName = parseLoginUserName(block);
    sess.loggedIn = true;
    return [new Uint8Array(), C.NoErr];
  }

  private getSrvrMsg(sess: Session, block: Uint8Array): [Uint8Array, number] {
    const msgType = block.length >= 4 ? be16(block, 2) : 0;
    let text = '';
    if (msgType === C.SrvrMsgTypeLogin) text = '';
    else if (msgType === C.SrvrMsgTypeServer) text = sess.serverMsg;
    let bytes = encodeMacRoman(text);
    if (bytes.length > C.MaxSrvrMsgLen) bytes = bytes.subarray(0, C.MaxSrvrMsgLen);
    const out: number[] = [];
    appendBe16(out, msgType);
    appendBe16(out, C.SrvrMsgBitmapText);
    out.push(bytes.length, ...bytes);
    return [new Uint8Array(out), C.NoErr];
  }

  private getSrvrParms(): [Uint8Array, number] {
    const name = encodeMacRoman(this.volumeName);
    const out: number[] = [];
    appendBe32(out, C.macTime());
    out.push(1); // vol count
    out.push(0); // flags
    out.push(name.length, ...name);
    return [new Uint8Array(out), C.NoErr];
  }

  private openVol(sess: Session, block: Uint8Array): [Uint8Array, number] {
    const reqBitmap = be16(block, 2);
    sess.volId = 1;
    // Always include VolumeID so the client has a usable handle (OmniTalk).
    const bitmap = reqBitmap | C.VolBitmapID;
    return [this.packVolReply(bitmap), C.NoErr];
  }

  /** FPGetVolParms — Finder's first post-mount call; missing → mount stalls. */
  private getVolParms(sess: Session, block: Uint8Array): [Uint8Array, number] {
    if (block.length < 6) return [new Uint8Array(), C.ErrParamErr];
    const volId = be16(block, 2);
    const reqBitmap = be16(block, 4);
    if (volId !== sess.volId || sess.volId === 0) return [new Uint8Array(), C.ErrParamErr];
    // Echo exactly the requested bitmap (do not force VolumeID — unlike OpenVol).
    return [this.packVolReply(reqBitmap), C.NoErr];
  }

  private packVolReply(bitmap: number): Uint8Array {
    const out: number[] = [];
    appendBe16(out, bitmap);
    if (bitmap & C.VolBitmapAttributes) appendBe16(out, 0);
    if (bitmap & C.VolBitmapSignature) appendBe16(out, 2); // Fixed Directory ID
    if (bitmap & C.VolBitmapCreateDate) appendBe32(out, C.macTime());
    if (bitmap & C.VolBitmapModDate) appendBe32(out, C.macTime());
    if (bitmap & (1 << 4)) appendBe32(out, C.NoBackupDate);
    if (bitmap & C.VolBitmapID) appendBe16(out, 1);
    if (bitmap & C.VolBitmapBytesFree) appendBe32(out, 64 * 1024 * 1024);
    if (bitmap & C.VolBitmapBytesTotal) appendBe32(out, 128 * 1024 * 1024);
    if (bitmap & C.VolBitmapName) {
      const name = encodeMacRoman(this.volumeName);
      const fixedAfterPtr = 2; // name field is a 2-byte offset into params
      // Offset is from start of params (after reply bitmap). Compute fixed size.
      let fixed = 0;
      if (bitmap & C.VolBitmapAttributes) fixed += 2;
      if (bitmap & C.VolBitmapSignature) fixed += 2;
      if (bitmap & C.VolBitmapCreateDate) fixed += 4;
      if (bitmap & C.VolBitmapModDate) fixed += 4;
      if (bitmap & (1 << 4)) fixed += 4;
      if (bitmap & C.VolBitmapID) fixed += 2;
      if (bitmap & C.VolBitmapBytesFree) fixed += 4;
      if (bitmap & C.VolBitmapBytesTotal) fixed += 4;
      fixed += fixedAfterPtr;
      appendBe16(out, fixed);
      out.push(name.length, ...name);
    }
    return new Uint8Array(out);
  }

  private async enumerate(block: Uint8Array): Promise<[Uint8Array, number]> {
    // cmd pad volID(2) dirID(4) fileBitmap(2) dirBitmap(2) reqCount(2) startIndex(2) maxReply(2) …
    const dirId = be32(block, 4);
    const fileBitmap = be16(block, 8);
    const dirBitmap = be16(block, 10);
    const reqCount = be16(block, 12);
    const startIndex = be16(block, 14);
    const kids = await this.fs.children(dirId || C.CNIDRoot);
    const slice = kids.slice(Math.max(0, startIndex - 1), Math.max(0, startIndex - 1) + reqCount);
    if (slice.length === 0) return [new Uint8Array(), C.ErrObjectNotFnd];

    const records: Uint8Array[] = [];
    for (const n of slice) {
      const bm = n.isDir ? dirBitmap : fileBitmap;
      const offspring = n.isDir ? (await this.fs.children(n.id)).length : 0;
      records.push(this.buildEnumRecord(n, bm, n.name, offspring));
    }
    const body: number[] = [];
    appendBe16(body, fileBitmap);
    appendBe16(body, dirBitmap);
    appendBe16(body, records.length);
    const recBytes = concat(...records);
    const out = new Uint8Array(body.length + recBytes.length);
    out.set(new Uint8Array(body));
    out.set(recBytes, body.length);
    return [out, C.NoErr];
  }

  /**
   * OmniTalk enumEntry: [len:1][type:1][params…] padded to even length.
   * Params start at entry offset 2 — name offsets are relative to params[0], NOT
   * including a pad byte between type and params.
   */
  private buildEnumRecord(n: VNode, bitmap: number, displayName: string, offspring = 0): Uint8Array {
    const params = this.packParms(n, bitmap, displayName, offspring);
    const type = n.isDir ? 0x80 : 0x00;
    let len = 2 + params.length;
    if (len % 2) len++;
    const out = new Uint8Array(len);
    out[0] = len;
    out[1] = type;
    out.set(params, 2);
    return out;
  }

  /**
   * Pack file/dir params in ascending bitmap-bit order (OmniTalk parms.go).
   * Long/Short name fields are 2-byte offsets into a trailing Pascal-string area;
   * offsets are measured from the start of this parameter block.
   */
  private packParms(n: VNode, bitmap: number, displayName: string, offspring = 0): Uint8Array {
    const longName = encodeMacRoman(displayName.slice(0, 31));
    const shortName = encodeMacRoman(shortenMacName(displayName));

    const fixedSize = this.parmsFixedSize(n.isDir, bitmap);
    const fixed: number[] = [];
    const variable: number[] = [];

    const appendName = (bytes: Uint8Array) => {
      appendBe16(fixed, fixedSize + variable.length);
      variable.push(bytes.length, ...bytes);
    };

    if (bitmap & C.FDBitmapAttributes) appendBe16(fixed, 0);
    if (bitmap & C.FDBitmapParentDID) appendBe32(fixed, n.parentId);
    if (bitmap & C.FDBitmapCreateDate) appendBe32(fixed, n.createDate);
    if (bitmap & C.FDBitmapModDate) appendBe32(fixed, n.modDate);
    if (bitmap & C.FDBitmapBackupDate) appendBe32(fixed, C.NoBackupDate);
    if (bitmap & C.FDBitmapFinderInfo) fixed.push(...n.finderInfo.subarray(0, 32));
    if (bitmap & C.FDBitmapLongName) appendName(longName);
    if (bitmap & C.FDBitmapShortName) appendName(shortName);
    if (!n.isDir) {
      if (bitmap & C.FileBitmapFileNum) appendBe32(fixed, n.id);
      if (bitmap & C.FileBitmapDataForkLen) appendBe32(fixed, n.data.length);
      if (bitmap & C.FileBitmapRsrcForkLen) appendBe32(fixed, n.resource.length);
    } else {
      if (bitmap & C.DirBitmapDirID) appendBe32(fixed, n.id);
      if (bitmap & C.DirBitmapOffspring) appendBe16(fixed, offspring);
      if (bitmap & C.DirBitmapOwnerID) appendBe32(fixed, 0);
      if (bitmap & C.DirBitmapGroupID) appendBe32(fixed, 0);
      if (bitmap & C.DirBitmapAccessRights) appendBe32(fixed, C.DirAccessRights);
    }

    if (fixed.length !== fixedSize) {
      // Defensive: keep wire self-consistent even if bit sizing drifts.
      while (fixed.length < fixedSize) fixed.push(0);
    }
    return new Uint8Array([...fixed, ...variable]);
  }

  private parmsFixedSize(isDir: boolean, bitmap: number): number {
    let size = 0;
    if (bitmap & C.FDBitmapAttributes) size += 2;
    if (bitmap & C.FDBitmapParentDID) size += 4;
    if (bitmap & C.FDBitmapCreateDate) size += 4;
    if (bitmap & C.FDBitmapModDate) size += 4;
    if (bitmap & C.FDBitmapBackupDate) size += 4;
    if (bitmap & C.FDBitmapFinderInfo) size += 32;
    if (bitmap & C.FDBitmapLongName) size += 2;
    if (bitmap & C.FDBitmapShortName) size += 2;
    if (!isDir) {
      if (bitmap & C.FileBitmapFileNum) size += 4;
      if (bitmap & C.FileBitmapDataForkLen) size += 4;
      if (bitmap & C.FileBitmapRsrcForkLen) size += 4;
    } else {
      if (bitmap & C.DirBitmapDirID) size += 4;
      if (bitmap & C.DirBitmapOffspring) size += 2;
      if (bitmap & C.DirBitmapOwnerID) size += 4;
      if (bitmap & C.DirBitmapGroupID) size += 4;
      if (bitmap & C.DirBitmapAccessRights) size += 4;
    }
    return size;
  }

  /** Catalog display name: root uses the share/volume name (Finder window title). */
  private displayNameFor(n: VNode): string {
    if (n.id === C.CNIDRoot || n.parentId === 1) return this.volumeName;
    return n.name;
  }

  private async createDir(block: Uint8Array): Promise<[Uint8Array, number]> {
    const dirId = be32(block, 4);
    const name = this.readPathName(block, 8);
    const n = await this.fs.mkdir(dirId || C.CNIDRoot, name);
    const out = new Uint8Array(4);
    writeBe32(out, 0, n.id);
    return [out, C.NoErr];
  }

  private async createFile(block: Uint8Array): Promise<[Uint8Array, number]> {
    const dirId = be32(block, 4);
    const name = this.readPathName(block, 8);
    await this.fs.createFile(dirId || C.CNIDRoot, name, new Uint8Array());
    return [new Uint8Array(), C.NoErr];
  }

  private async deletePath(block: Uint8Array): Promise<[Uint8Array, number]> {
    const dirId = be32(block, 4);
    const name = this.readPathName(block, 8);
    const n = await this.fs.lookup(dirId || C.CNIDRoot, name);
    if (!n) return [new Uint8Array(), C.ErrObjectNotFnd];
    await this.fs.remove(n.id);
    return [new Uint8Array(), C.NoErr];
  }

  private async rename(block: Uint8Array): Promise<[Uint8Array, number]> {
    const dirId = be32(block, 4);
    // path then new name — simplified: find first path, then second
    let o = 8;
    if (block[o] === C.PathTypeLongNames) o++;
    const oldName = this.readPathAt(block, o);
    o = oldName.next;
    if (o % 2) o++;
    if (block[o] === C.PathTypeLongNames) o++;
    const newName = this.readPathAt(block, o);
    const n = await this.fs.lookup(dirId || C.CNIDRoot, oldName.name);
    if (!n) return [new Uint8Array(), C.ErrObjectNotFnd];
    await this.fs.rename(n.id, newName.name);
    return [new Uint8Array(), C.NoErr];
  }

  private async openFork(sess: Session, block: Uint8Array): Promise<[Uint8Array, number]> {
    // cmd(1) flag(1) volID(2) dirID(4) bitmap(2) accessMode(2) pathType(1) pathname…
    if (block.length < 13) return [new Uint8Array(), C.ErrParamErr];
    const forkFlag = block[1]!;
    const dirId = be32(block, 4);
    const bitmap = be16(block, 8);
    const name = this.readPathName(block, 12);
    const n = await this.fs.lookup(dirId || C.CNIDRoot, name);
    if (!n || n.isDir) {
      log.info(`FPOpenFork lookup miss did=${dirId || C.CNIDRoot} name=${JSON.stringify(name)}`, 'afp');
      return [new Uint8Array(), C.ErrObjectNotFnd];
    }
    const ref = sess.nextFork++ & 0xffff;
    if (ref === 0) sess.nextFork = 1;
    sess.forks.set(ref, {
      nodeId: n.id,
      resource: (forkFlag & C.ForkFlagResource) !== 0,
      offset: 0,
      name: n.name,
    });
    const params = this.packParms(n, bitmap, n.name);
    const out = new Uint8Array(4 + params.length);
    writeBe16(out, 0, bitmap);
    writeBe16(out, 2, ref);
    out.set(params, 4);
    return [out, C.NoErr];
  }

  private async readFork(sess: Session, block: Uint8Array): Promise<[Uint8Array, number]> {
    const ref = be16(block, 2);
    const offset = be32(block, 4);
    const count = be32(block, 8);
    const fork = sess.forks.get(ref);
    if (!fork) return [new Uint8Array(), C.ErrParamErr];
    const n = await this.fs.get(fork.nodeId);
    if (!n) return [new Uint8Array(), C.ErrObjectNotFnd];
    const src = fork.resource ? n.resource : n.data;
    if (offset >= src.length) return [new Uint8Array(), C.ErrEOFErr];
    const end = Math.min(offset + count, src.length);
    const slice = src.subarray(offset, end);
    const result = end >= src.length && slice.length < count ? C.ErrEOFErr : C.NoErr;
    return [slice.slice(), result];
  }

  private async writeFork(sess: Session, block: Uint8Array, _isWrite: boolean): Promise<[Uint8Array, number]> {
    // cmd(1) flag(1) forkRef(2) offset(4) reqCount(4) data…  (OmniTalk afpWrite)
    // Reply: lastWritten(4) — fork offset one past the last byte written.
    if (block.length < 12) return [new Uint8Array(), C.ErrParamErr];
    const fromEnd = (block[1]! & 0x80) !== 0;
    const ref = be16(block, 2);
    let offset = be32(block, 4);
    const reqCount = be32(block, 8);
    const fork = sess.forks.get(ref);
    if (!fork) return [new Uint8Array(), C.ErrParamErr];
    const n = await this.fs.get(fork.nodeId);
    if (!n) return [new Uint8Array(), C.ErrObjectNotFnd];
    let data = block.length > 12 ? block.subarray(12) : new Uint8Array();
    if (data.length > reqCount) data = data.subarray(0, reqCount);
    const cur = fork.resource ? n.resource : n.data;
    if (fromEnd) offset = cur.length + offset;
    const need = offset + data.length;
    const next = new Uint8Array(Math.max(cur.length, need));
    next.set(cur);
    next.set(data, offset);
    if (fork.resource) n.resource = next;
    else n.data = next;
    n.modDate = C.macTime();
    await this.fs.put(n);
    const out = new Uint8Array(4);
    writeBe32(out, 0, offset + data.length); // lastWritten
    return [out, C.NoErr];
  }

  private closeFork(sess: Session, block: Uint8Array): [Uint8Array, number] {
    const ref = be16(block, 2);
    sess.forks.delete(ref);
    return [new Uint8Array(), C.NoErr];
  }

  /** FPSetForkParms: cmd pad forkRef(2) bitmap(2) forkLen(4). Reply empty. */
  private async setForkParms(sess: Session, block: Uint8Array): Promise<[Uint8Array, number]> {
    if (block.length < 10) return [new Uint8Array(), C.ErrParamErr];
    const ref = be16(block, 2);
    const bitmap = be16(block, 4);
    const forkLen = be32(block, 6);
    const fork = sess.forks.get(ref);
    if (!fork) return [new Uint8Array(), C.ErrParamErr];
    if (!(bitmap & (C.FileBitmapDataForkLen | C.FileBitmapRsrcForkLen))) {
      return [new Uint8Array(), C.ErrBitmapErr];
    }
    const n = await this.fs.get(fork.nodeId);
    if (!n) return [new Uint8Array(), C.ErrObjectNotFnd];
    // Truncate the fork that was opened; bitmap only names which length field is set.
    const cur = fork.resource ? n.resource : n.data;
    const next = new Uint8Array(forkLen);
    next.set(cur.subarray(0, Math.min(cur.length, forkLen)));
    if (fork.resource) n.resource = next;
    else n.data = next;
    n.modDate = C.macTime();
    await this.fs.put(n);
    log.info(`FPSetForkParms ref=${ref} len=${forkLen} ${fork.resource ? 'rsrc' : 'data'}`, 'afp');
    return [new Uint8Array(), C.NoErr];
  }

  /** FPGetForkParms: cmd pad forkRef(2) bitmap(2). Reply: bitmap(2) <file params>. */
  private async getForkParms(sess: Session, block: Uint8Array): Promise<[Uint8Array, number]> {
    if (block.length < 6) return [new Uint8Array(), C.ErrParamErr];
    const ref = be16(block, 2);
    const bitmap = be16(block, 4);
    const fork = sess.forks.get(ref);
    if (!fork) return [new Uint8Array(), C.ErrParamErr];
    const n = await this.fs.get(fork.nodeId);
    if (!n) return [new Uint8Array(), C.ErrObjectNotFnd];
    const params = this.packParms(n, bitmap, n.name);
    const out = new Uint8Array(2 + params.length);
    writeBe16(out, 0, bitmap);
    out.set(params, 2);
    return [out, C.NoErr];
  }

  private async setParms(block: Uint8Array): Promise<[Uint8Array, number]> {
    // cmd pad volID(2) dirID(4) bitmap(2) pathType(1) pathname [pad even] <params in bit order>
    // OmniTalk afpSetFileDirParms / setParamsFinderInfo — FinderInfo is NOT always first.
    if (block.length < 11) return [new Uint8Array(), C.ErrParamErr];
    const dirId = be32(block, 4);
    const bitmap = be16(block, 8);
    const pathType = block[10]!;
    const nameOff = pathType >= 1 && pathType <= 3 ? 11 : 10;
    const path = this.readPathAt(block, nameOff);
    let o = path.next;
    if (o % 2) o++; // word-align params to even offset from start of command block

    let n: VNode | undefined;
    if (path.name) {
      n = await this.fs.lookup(dirId || C.CNIDRoot, path.name);
    } else {
      // Empty path → the dirID object itself (often a folder stamp during mount).
      n = await this.fs.get(dirId || C.CNIDRoot);
    }
    if (!n) return [new Uint8Array(), C.ErrObjectNotFnd];

    // Skip fixed fields that precede FinderInfo (bit 5) in ascending bit order.
    if (bitmap & C.FDBitmapAttributes) o += 2;
    if (bitmap & C.FDBitmapParentDID) o += 4;
    if (bitmap & C.FDBitmapCreateDate) {
      if (o + 4 <= block.length) n.createDate = be32(block, o);
      o += 4;
    }
    if (bitmap & C.FDBitmapModDate) {
      if (o + 4 <= block.length) n.modDate = be32(block, o);
      o += 4;
    }
    if (bitmap & C.FDBitmapBackupDate) o += 4;
    if (bitmap & C.FDBitmapFinderInfo) {
      if (o + 32 > block.length) return [new Uint8Array(), C.ErrParamErr];
      n.finderInfo = block.subarray(o, o + 32).slice();
      const tc = decodeMacRoman(n.finderInfo.subarray(0, 8));
      log.info(
        `FPSet*Parms did=${dirId} name=${JSON.stringify(path.name)} type/creator=${JSON.stringify(tc)} bm=0x${bitmap.toString(16)}`,
        'afp',
      );
    }
    n.modDate = C.macTime();
    await this.fs.put(n);
    return [new Uint8Array(), C.NoErr];
  }

  private async getParms(block: Uint8Array): Promise<[Uint8Array, number]> {
    // Request: cmd pad volID(2) dirID(4) fileBitmap(2) dirBitmap(2) pathType(1) pathname…
    // Reply (OmniTalk FPGetFileDirParmsRes): fileBitmap(2) dirBitmap(2) type(1) pad(1) params
    const dirId = be32(block, 4);
    const fileBitmap = be16(block, 8);
    const dirBitmap = be16(block, 10);
    const name = this.readPathName(block, 12);

    let n: VNode | undefined;
    // Parent-of-root (DID 1): Finder names the volume; only the share root is valid.
    if (dirId === 1) {
      const want = name.trim() || this.volumeName;
      if (want.toLowerCase() === this.volumeName.toLowerCase() || name === '') {
        n = await this.fs.get(C.CNIDRoot);
      }
    } else if (name) {
      n = await this.fs.lookup(dirId || C.CNIDRoot, name);
    } else {
      n = await this.fs.get(dirId || C.CNIDRoot);
    }
    if (!n) return [new Uint8Array(), C.ErrObjectNotFnd];

    const bm = n.isDir ? dirBitmap : fileBitmap;
    const offspring = n.isDir ? (await this.fs.children(n.id)).length : 0;
    const params = this.packParms(n, bm, this.displayNameFor(n), offspring);
    const out = new Uint8Array(6 + params.length);
    writeBe16(out, 0, fileBitmap);
    writeBe16(out, 2, dirBitmap);
    out[4] = n.isDir ? 0x80 : 0;
    out[5] = 0;
    out.set(params, 6);
    return [out, C.NoErr];
  }

  private async addIcon(block: Uint8Array, isWrite: boolean): Promise<[Uint8Array, number]> {
    // cmd(1) pad(1) DTRef(2) creator(4) type(4) iconType(1) pad(1) tag(4) size(4) + data
    if (block.length < 20) return [new Uint8Array(), C.ErrParamErr];
    const creator = decodeMacRoman(block.subarray(4, 8));
    const type = decodeMacRoman(block.subarray(8, 12));
    const iconType = block[12]!;
    const tag = be32(block, 14);
    const size = be32(block, 18);
    let data = new Uint8Array();
    if (isWrite && block.length > 22) {
      data = block.subarray(22, 22 + size).slice();
    }
    const key = `icon:${creator}:${type}:${iconType}:${tag}`;
    await this.fs.desktopSet(key, data.length ? data : new Uint8Array(size));
    return [new Uint8Array(), C.NoErr];
  }

  private async getIcon(block: Uint8Array): Promise<[Uint8Array, number]> {
    if (block.length < 16) return [new Uint8Array(), C.ErrParamErr];
    const creator = decodeMacRoman(block.subarray(4, 8));
    const type = decodeMacRoman(block.subarray(8, 12));
    const iconType = block[12]!;
    const length = be16(block, 14);
    const key = `icon:${creator}:${type}:${iconType}:`;
    // try exact tag 0 first — scan keys is hard; store canonical without tag lookup
    const data = (await this.fs.desktopGet(`${key}0`)) ?? (await this.fs.desktopGet(key + '0'));
    if (!data) return [new Uint8Array(), C.ErrObjectNotFnd];
    return [data.subarray(0, length || data.length), C.NoErr];
  }

  private async getIconInfo(block: Uint8Array): Promise<[Uint8Array, number]> {
    void block;
    const out = new Uint8Array(4);
    writeBe32(out, 0, 0); // tag
    return [out, C.NoErr];
  }

  private readPathName(block: Uint8Array, start: number): string {
    // OmniTalk: pathType(1) at `start`, then a Pascal string (length byte + bytes).
    if (start >= block.length) return '';
    const pathType = block[start]!;
    // pathType 1/2/3 are short/long/UTF8; anything else treat `start` as the Pascal length.
    const o = pathType >= 1 && pathType <= 3 ? start + 1 : start;
    return this.readPascalName(block, o);
  }

  /** Pascal pathname at `o`: length byte then that many MacRoman bytes (OmniTalk pascalPathAt). */
  private readPascalName(block: Uint8Array, o: number): string {
    if (o >= block.length) return '';
    const n = block[o]!;
    if (o + 1 + n > block.length) return '';
    if (n === 0) return '';
    return this.normalizeWirePathName(block.subarray(o + 1, o + 1 + n));
  }

  /**
   * AFP long-name path bodies are often leading-NUL + elements joined by NUL
   * (OmniTalk afpWirePath). Strip edge NULs; for multi-level under a dirID that
   * already names the parent, use the leaf element.
   */
  private normalizeWirePathName(raw: Uint8Array): string {
    let start = 0;
    let end = raw.length;
    while (start < end && raw[start] === 0) start++;
    while (end > start && raw[end - 1] === 0) end--;
    if (start >= end) return '';
    let leafStart = start;
    for (let i = start; i < end; i++) {
      if (raw[i] === 0) leafStart = i + 1;
    }
    return decodeMacRoman(raw.subarray(leafStart, end));
  }

  private readPathAt(block: Uint8Array, o: number): { name: string; next: number } {
    if (o >= block.length) return { name: '', next: o };
    const n = block[o]!;
    if (o + 1 + n > block.length) return { name: '', next: o };
    const name = n === 0 ? '' : this.normalizeWirePathName(block.subarray(o + 1, o + 1 + n));
    return { name, next: o + 1 + n };
  }

  private serverInfoBlock(): Uint8Array {
    const serverName = encodeMacRoman(this.serverName);
    const machine = encodeMacRoman('ClassicStackWeb');
    const versions = [encodeMacRoman('AFPVersion 2.1'), encodeMacRoman('AFPVersion 2.0')];
    const uams = [encodeMacRoman('No User Authent'), encodeMacRoman('Cleartxt Passwrd')];

    const headerLen = 10;
    let base = headerLen + 1 + serverName.length;
    if (base % 2) base++;
    const machineOff = base;
    const versionsOff = machineOff + 1 + machine.length;
    let versionsLen = 1;
    for (const v of versions) versionsLen += 1 + v.length;
    const uamOff = versionsOff + versionsLen;
    let uamLen = 1;
    for (const u of uams) uamLen += 1 + u.length;
    const total = uamOff + uamLen;
    const out = new Uint8Array(total);
    writeBe16(out, 0, machineOff);
    writeBe16(out, 2, versionsOff);
    writeBe16(out, 4, uamOff);
    writeBe16(out, 6, 0);
    writeBe16(out, 8, C.SrvrInfoSupportsSrvrMsg);
    out[headerLen] = serverName.length;
    out.set(serverName, headerLen + 1);
    out[machineOff] = machine.length;
    out.set(machine, machineOff + 1);
    out[versionsOff] = versions.length;
    let o = versionsOff + 1;
    for (const v of versions) {
      out[o++] = v.length;
      out.set(v, o);
      o += v.length;
    }
    out[uamOff] = uams.length;
    o = uamOff + 1;
    for (const u of uams) {
      out[o++] = u.length;
      out.set(u, o);
      o += u.length;
    }
    return out;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Rough Mac Roman short name (≤12 chars); enough for AFP ShortName field. */
function shortenMacName(name: string): string {
  if (name.length <= 12) return name;
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 4) {
    const ext = name.slice(dot, dot + 4);
    return name.slice(0, Math.max(1, 12 - ext.length)) + ext;
  }
  return name.slice(0, 12);
}

/** Bytes to pull in ASP WriteContinue + fixed header length (OmniTalk writeDataCount). */
function writeDataCount(block: Uint8Array): { want: number; hdrLen: number } {
  if (block.length >= 12 && block[0] === C.CmdWrite) {
    const n = be32(block, 8) | 0;
    if (n < 0) return { want: 0, hdrLen: 0 };
    return { want: n, hdrLen: 12 };
  }
  if (block.length >= 20 && block[0] === C.CmdAddIcon) {
    return { want: be16(block, 18), hdrLen: 20 };
  }
  return { want: 0, hdrLen: 0 };
}

/** AFPVersion + UAM Pascal strings; leftover is typically the user name. */
function parseLoginUserName(block: Uint8Array): string {
  let o = 1;
  for (let i = 0; i < 2; i++) {
    if (o >= block.length) return '';
    const n = block[o]!;
    o += 1 + n;
  }
  if (o >= block.length) return '';
  const n = block[o]!;
  if (!n || o + 1 + n > block.length) return '';
  return decodeMacRoman(block.subarray(o + 1, o + 1 + n));
}

function appendWriteData(header: Uint8Array, headerLen: number, data: Uint8Array): Uint8Array {
  const h = header.length > headerLen ? header.subarray(0, headerLen) : header;
  const out = new Uint8Array(h.length + data.length);
  out.set(h);
  out.set(data, h.length);
  return out;
}

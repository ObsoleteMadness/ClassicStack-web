import { describe, it, expect } from 'vitest';
import * as C from '../../protocol/afp/constants';
import { be16, be32, writeBe16 } from '../../protocol/binary';
import { encodeMacRoman } from '../../protocol/macroman';
import {
  wirePath,
  openFork,
  createFile,
  writeFork,
  readFork,
  parseEnumerate,
  setFileDirParms,
  parseServerInfo,
  getSrvrMsg,
  parseGetSrvrMsg,
  loginGuest,
  loginCleartext,
  loginCont,
  pickAfpVersion,
  pickCleartextUam,
  getFileDirParms,
} from './commands';

describe('AFP client wirePath + Pascal framing', () => {
  it('empty path is a single NUL (this-dir)', () => {
    expect([...wirePath('')]).toEqual([0x00]);
    expect([...wirePath('/')]).toEqual([0x00]);
  });

  it('leaf path is leading NUL + MacRoman name', () => {
    expect([...wirePath('ReadMe')]).toEqual([0x00, ...encodeMacRoman('ReadMe')]);
  });

  it('CreateFile / OpenFork wrap pathType + Pascal length (OmniTalk PutPString)', () => {
    const cf = createFile(1, 2, 'Hello');
    // cmd flag vol(2) dir(4) pathType pascalLen ...
    expect(cf[0]).toBe(C.CmdCreateFile);
    expect(cf[8]).toBe(C.PathTypeLongNames);
    const body = wirePath('Hello');
    expect(cf[9]).toBe(body.length);
    expect([...cf.subarray(10, 10 + body.length)]).toEqual([...body]);

    const of = openFork(1, 2, 0, C.AccessRead, C.ForkFlagData, 'Hello');
    // path starts at offset 12
    expect(of[12]).toBe(C.PathTypeLongNames);
    expect(of[13]).toBe(body.length);
    expect([...of.subarray(14, 14 + body.length)]).toEqual([...body]);
  });
});

describe('AFP client FPWrite / FPRead headers', () => {
  it('writeFork is a 12-byte header including reqCount', () => {
    const h = writeFork(7, 100, 50);
    expect(h.length).toBe(12);
    expect(h[0]).toBe(C.CmdWrite);
    expect(be16(h, 2)).toBe(7);
    expect(be32(h, 4)).toBe(100);
    expect(be32(h, 8)).toBe(50);
  });

  it('readFork is a 14-byte fixed block (newline mask/char)', () => {
    const h = readFork(3, 0, 4096);
    expect(h.length).toBe(14);
    expect(h[12]).toBe(0);
    expect(h[13]).toBe(0);
  });
});

describe('AFP client parseEnumerate', () => {
  it('parses OmniTalk [len:1][type:1][params] entries', () => {
    const name = encodeMacRoman('Doc');
    // LongName-only params: offset(2)=2, then pstring
    const params = new Uint8Array([0, 2, name.length, ...name]);
    let entryLen = 2 + params.length;
    if (entryLen % 2) entryLen++;
    const entry = new Uint8Array(entryLen);
    entry[0] = entryLen;
    entry[1] = 0; // file
    entry.set(params, 2);

    const body = new Uint8Array(6 + entry.length);
    writeBe16(body, 0, C.FDBitmapLongName);
    writeBe16(body, 2, C.FDBitmapLongName);
    writeBe16(body, 4, 1);
    body.set(entry, 6);

    const entries = parseEnumerate(body, C.FDBitmapLongName, C.FDBitmapLongName);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.isDir).toBe(false);
    expect(entries[0]!.name).toBe('Doc');
  });
});

describe('AFP client setFileDirParms', () => {
  it('word-aligns params and packs FinderInfo only when that bit is set', () => {
    const fi = new Uint8Array(32);
    fi[0] = 0x54;
    fi[1] = 0x45;
    fi[2] = 0x58;
    fi[3] = 0x54; // TEXT
    const blk = setFileDirParms(1, 2, C.FDBitmapFinderInfo, 'x', fi);
    // cmd pad vol(2) dir(4) bitmap(2) → path at 10
    const pathBody = wirePath('x');
    let o = 10;
    expect(blk[o]).toBe(C.PathTypeLongNames);
    o += 1 + 1 + pathBody.length;
    if (o % 2) o++;
    expect([...blk.subarray(o, o + 4)]).toEqual([0x54, 0x45, 0x58, 0x54]);
  });

  it('packs preceding date fields before FinderInfo when those bits are set', () => {
    const fi = new Uint8Array(32);
    fi[0] = 0xaa;
    const bm = C.FDBitmapModDate | C.FDBitmapFinderInfo;
    const blk = setFileDirParms(1, 2, bm, 'y', fi, { modDate: 0x11223344 });
    const pathBody = wirePath('y');
    let o = 10;
    o += 1 + 1 + pathBody.length;
    if (o % 2) o++;
    expect(be32(blk, o)).toBe(0x11223344);
    expect(blk[o + 4]).toBe(0xaa);
  });
});

describe('AFP server messages', () => {
  it('parses FPGetSrvrInfo flags including SupportsSrvrMsg', () => {
    const name = encodeMacRoman('Test');
    const body = new Uint8Array(10 + 1 + name.length);
    writeBe16(body, 0, 0);
    writeBe16(body, 2, 0);
    writeBe16(body, 4, 0);
    writeBe16(body, 8, C.SrvrInfoSupportsSrvrMsg);
    body[10] = name.length;
    body.set(name, 11);
    const info = parseServerInfo(body);
    expect(info.serverName).toBe('Test');
    expect(info.flags).toBe(C.SrvrInfoSupportsSrvrMsg);
  });

  it('round-trips FPGetSrvrMsg request and reply', () => {
    const req = getSrvrMsg(C.SrvrMsgTypeServer);
    expect(req[0]).toBe(C.CmdGetSrvrMsg);
    expect(be16(req, 2)).toBe(C.SrvrMsgTypeServer);
    expect(be16(req, 4)).toBe(C.SrvrMsgBitmapText);

    const msg = encodeMacRoman('Hello Mac');
    const reply = new Uint8Array(5 + msg.length);
    writeBe16(reply, 0, C.SrvrMsgTypeServer);
    writeBe16(reply, 2, C.SrvrMsgBitmapText);
    reply[4] = msg.length;
    reply.set(msg, 5);
    expect(parseGetSrvrMsg(reply).text).toBe('Hello Mac');
  });
});

describe('AFP login packets', () => {
  it('loginGuest is version + No User Authent', () => {
    const b = loginGuest(C.AFPVersion21);
    expect(b[0]).toBe(C.CmdLogin);
    expect(b[1]).toBe(C.AFPVersion21.length);
  });

  it('loginCleartext even-aligns the 8-byte password', () => {
    const b = loginCleartext('a', 'secret', C.AFPVersion21);
    expect(b[0]).toBe(C.CmdLogin);
    expect(b.length % 2).toBe(0);
    expect([...b.subarray(b.length - 8)]).toEqual([...encodeMacRoman('secret'), 0, 0]);
  });

  it('uses the advertised version and Cleartxt passwrd spelling', () => {
    expect(pickAfpVersion(['AFPVersion 1.1', 'AFPVersion 2.0', 'AFPVersion 2.1'])).toBe(
      'AFPVersion 2.1',
    );
    expect(pickCleartextUam(['Cleartxt passwrd', 'Randnum exchange'])).toBe('Cleartxt passwrd');
    const version = encodeMacRoman('AFPVersion 2.1');
    const uam = encodeMacRoman('Cleartxt passwrd');
    const b = loginCleartext('user', 'pw', 'AFPVersion 2.1', 'Cleartxt passwrd');
    expect(b[0]).toBe(C.CmdLogin);
    expect(b[1]).toBe(version.length);
    expect([...b.subarray(2, 2 + version.length)]).toEqual([...version]);
    expect(b[2 + version.length]).toBe(uam.length);
    expect([...b.subarray(3 + version.length, 3 + version.length + uam.length)]).toEqual([...uam]);
  });

  it('loginCont is cmd+pad+id+auth', () => {
    const auth = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = loginCont(0x1122, auth);
    expect(b[0]).toBe(C.CmdLoginCont);
    expect(b[1]).toBe(0);
    expect(be16(b, 2)).toBe(0x1122);
    expect([...b.subarray(4)]).toEqual([...auth]);
  });

  it('GetFileDirParms is a named lookup, not an enumerate', () => {
    const b = getFileDirParms(1, 2, C.FileBitmapRsrcForkLen, 0, 'Icon\r');
    expect(b[0]).toBe(C.CmdGetFileDirParms);
    expect(be16(b, 2)).toBe(1);
    expect(be32(b, 4)).toBe(2);
    expect(b[12]).toBe(C.PathTypeLongNames);
  });
});

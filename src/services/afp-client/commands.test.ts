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
  collectEnumeratePages,
  ENUMERATE_REQ_COUNT,
  type DirEntry,
  parseSrvrParms,
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
  afpRequestDetail,
  parseOpenForkRequest,
  createDir,
  deletePath,
  logout,
  closeVol,
  closeFork,
  rename,
  moveAndRename,
  copyFile,
  openDT,
  parseOpenDT,
  closeDT,
  getIcon,
  getIconInfo,
  parseGetIconInfo,
  desktopIconsToFetch,
} from './commands';

describe('AFP client wirePath + Pascal framing', () => {
  it('empty path is a single NUL (this-dir)', () => {
    expect([...wirePath('')]).toEqual([0x00]);
    expect([...wirePath('/')]).toEqual([0x00]);
  });

  it('leaf path is leading NUL + MacRoman name', () => {
    expect([...wirePath('ReadMe')]).toEqual([0x00, ...encodeMacRoman('ReadMe')]);
  });

  it('CreateFile / OpenFork wrap pathType + Pascal length (ClassicStack PutPString)', () => {
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

  it('MoveAndRename uses null dest and NewName like a Mac Finder move', () => {
    const b = moveAndRename(1, 2, 'X', 13, '');
    expect(b[0]).toBe(C.CmdMoveAndRename);
    expect(be32(b, 4)).toBe(2);
    expect(be32(b, 8)).toBe(13);
    expect(b[12]).toBe(C.PathTypeLongNames);
    const src = wirePath('X');
    expect(b[13]).toBe(src.length);
    let o = 14 + src.length;
    if (o % 2) o++;
    expect(b[o]).toBe(C.PathTypeLongNames);
    expect(b[o + 1]).toBe(0);
    o += 2;
    if (o % 2) o++;
    expect(b[o]).toBe(C.PathTypeLongNames);
    expect(b[o + 1]).toBe(0);
    expect(b.length).toBe(o + 2);
  });

  it('MoveAndRename NewName is a CNode name, not a wire path', () => {
    const b = moveAndRename(1, 2, 'Old', 3, 'New');
    const src = wirePath('Old');
    let o = 14 + src.length;
    if (o % 2) o++;
    o += 2; // null dest
    if (o % 2) o++;
    expect(b[o]).toBe(C.PathTypeLongNames);
    expect(b[o + 1]).toBe(3);
    expect([...b.subarray(o + 2, o + 5)]).toEqual([...encodeMacRoman('New')]);
  });

  it('CopyFile is srcVol/srcDir/dstVol/dstDir + dest path type 0', () => {
    const b = copyFile(1, 2, 'orig.txt', 1, 2, 'copy.txt');
    expect(b[0]).toBe(C.CmdCopyFile);
    expect(be16(b, 2)).toBe(1);
    expect(be32(b, 4)).toBe(2);
    expect(be16(b, 8)).toBe(1);
    expect(be32(b, 10)).toBe(2);
    expect(b[14]).toBe(C.PathTypeLongNames);
    const src = wirePath('orig.txt');
    expect(b[15]).toBe(src.length);
    let o = 16 + src.length;
    if (o % 2) o++;
    expect(b[o]).toBe(0);
    expect(b[o + 1]).toBe(0);
    o += 2;
    expect(b[o]).toBe(C.PathTypeLongNames);
    expect(b[o + 1]).toBe(8);
    expect([...b.subarray(o + 2, o + 10)]).toEqual([...encodeMacRoman('copy.txt')]);
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

describe('AFP client parseSrvrParms', () => {
  function packSrvrParms(vols: { flags: number; name: string }[]): Uint8Array {
    const out: number[] = [0xde, 0xad, 0xbe, 0xef, vols.length];
    for (const v of vols) {
      const name = encodeMacRoman(v.name);
      out.push(v.flags, name.length, ...name);
    }
    return new Uint8Array(out);
  }

  it('packs flags + Pascal names with no padding (ClassicStack golden)', () => {
    // deadbeef | 2 vols | flags=1 "Macintosh HD" | flags=0 "Public"
    const hex = 'deadbeef02010c4d6163696e746f736820484400065075626c6963';
    const b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const parsed = parseSrvrParms(b);
    expect(parsed.volumes.map((v) => v.name)).toEqual(['Macintosh HD', 'Public']);
    expect(parsed.volumes[0]!.flags).toBe(1);
    expect(parsed.volumes[1]!.flags).toBe(0);
  });

  it('keeps the first character of a volume after an even-length name', () => {
    const parsed = parseSrvrParms(
      packSrvrParms([
        { flags: 0, name: 'Public' },
        { flags: 0, name: 'OpenRetroSCSI 7.5.3' },
      ]),
    );
    expect(parsed.volumes.map((v) => v.name)).toEqual(['Public', 'OpenRetroSCSI 7.5.3']);
  });

  it('parses a single odd-length volume name', () => {
    const parsed = parseSrvrParms(packSrvrParms([{ flags: 0, name: 'OpenRetroSCSI 7.5.3' }]));
    expect(parsed.volumes).toEqual([{ flags: 0, name: 'OpenRetroSCSI 7.5.3' }]);
  });
});

describe('AFP client parseEnumerate', () => {
  it('parses ClassicStack [len:1][type:1][params] entries', () => {
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

  it('reads AFP attribute bits from the file/dir parms bitmap', () => {
    const name = encodeMacRoman('Locked');
    const params = new Uint8Array(4 + 1 + name.length);
    writeBe16(params, 0, 0x0020);
    writeBe16(params, 2, 4);
    params[4] = name.length;
    params.set(name, 5);
    let entryLen = 2 + params.length;
    if (entryLen % 2) entryLen++;
    const entry = new Uint8Array(entryLen);
    entry[0] = entryLen;
    entry[1] = 0;
    entry.set(params, 2);
    const body = new Uint8Array(6 + entry.length);
    const bm = C.FDBitmapAttributes | C.FDBitmapLongName;
    writeBe16(body, 0, bm);
    writeBe16(body, 2, bm);
    writeBe16(body, 4, 1);
    body.set(entry, 6);
    const entries = parseEnumerate(body, bm, bm);
    expect(entries[0]!.name).toBe('Locked');
    expect(entries[0]!.attributes).toBe(0x0020);
  });
});

function dirEnt(name: string, cnid: number): DirEntry {
  return {
    isDir: false,
    name,
    cnid,
    parentId: 2,
    dataLen: 0,
    rsrcLen: 0,
    createDate: 0,
    modDate: 0,
    finderInfo: new Uint8Array(32),
  };
}

describe('collectEnumeratePages', () => {
  it('invokes onBatch after each page before the directory is complete', async () => {
    const pages = [
      Array.from({ length: ENUMERATE_REQ_COUNT }, (_, i) => dirEnt(`a${i}`, 100 + i)),
      Array.from({ length: ENUMERATE_REQ_COUNT }, (_, i) => dirEnt(`b${i}`, 200 + i)),
      [dirEnt('last', 300)],
    ];
    const seen: number[] = [];
    const starts: number[] = [];
    const all = await collectEnumeratePages(async (start) => {
      starts.push(start);
      return pages.shift() ?? null;
    }, (batch) => {
      seen.push(batch.length);
    });
    expect(starts).toEqual([1, 1 + ENUMERATE_REQ_COUNT, 1 + ENUMERATE_REQ_COUNT * 2]);
    expect(seen).toEqual([ENUMERATE_REQ_COUNT, ENUMERATE_REQ_COUNT, 1]);
    expect(all).toHaveLength(ENUMERATE_REQ_COUNT * 2 + 1);
    expect(all[all.length - 1]!.name).toBe('last');
  });

  it('stops on an empty or not-found page', async () => {
    const all = await collectEnumeratePages(async () => null);
    expect(all).toEqual([]);
  });

  it('skips further pages after abort and rejects AbortError', async () => {
    const ac = new AbortController();
    const full = Array.from({ length: ENUMERATE_REQ_COUNT }, (_, i) => dirEnt(`p${i}`, 10 + i));
    let reads = 0;
    const p = collectEnumeratePages(
      async () => {
        reads++;
        ac.abort();
        return full;
      },
      undefined,
      ENUMERATE_REQ_COUNT,
      ac.signal,
    );
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(1);
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

describe('AFP client request traces', () => {
  it('includes path and fork fields for every command this client sends', () => {
    expect(afpRequestDetail(createFile(1, 2, 'Hello'))).toContain('Hello');
    expect(afpRequestDetail(createDir(1, 2, 'Docs'))).toContain('Docs');
    expect(afpRequestDetail(deletePath(1, 2, 'Old'))).toContain('Old');
    expect(afpRequestDetail(rename(1, 2, 'A', 'B'))).toContain('A');
    expect(afpRequestDetail(moveAndRename(1, 2, 'X', 3, 'Y'))).toContain('X');
    expect(afpRequestDetail(openFork(1, 2, 0, C.AccessRead, C.ForkFlagData, 'Pack.sit'))).toContain(
      'Pack.sit',
    );
    expect(parseOpenForkRequest(openFork(1, 2, 0, C.AccessRead, C.ForkFlagResource, 'App'))).toEqual({
      path: 'App',
      resource: true,
    });
    expect(afpRequestDetail(readFork(7, 100, 50))).toMatch(/fork=7 off=100 n=50/);
    expect(afpRequestDetail(writeFork(7, 0, 4096))).toMatch(/fork=7 off=0 n=4096/);
    expect(afpRequestDetail(closeFork(7))).toContain('fork=7');
    expect(afpRequestDetail(closeVol(3))).toContain('vol=3');
    expect(afpRequestDetail(getFileDirParms(1, 2, 0, 0, 'Icon\r'))).toContain('Icon');
    expect(afpRequestDetail(setFileDirParms(1, 2, C.FDBitmapFinderInfo, 'ReadMe', new Uint8Array(32)))).toContain(
      'ReadMe',
    );
    expect(afpRequestDetail(getSrvrMsg(C.SrvrMsgTypeServer))).toContain('type=');
    expect(afpRequestDetail(openDT(3))).toContain('vol=3');
    expect(afpRequestDetail(getIcon(3, 'ttxt', 'APPL', C.IconTypeICN, 256))).toMatch(/ttxt/);
    expect(afpRequestDetail(getIconInfo(3, 'ttxt', 1))).toMatch(/idx=1/);
    expect(afpRequestDetail(loginGuest())).toMatch(/AFPVersion/);
    expect(afpRequestDetail(loginCleartext('pete', 'secret'))).toContain('pete');
    expect(afpRequestDetail(loginCleartext('pete', 'secret'))).not.toContain('secret');
    expect(afpRequestDetail(logout())).toBe('');
  });
});

describe('AFP desktop icon commands', () => {
  it('packs FPOpenDT / FPGetIcon / FPGetIconInfo like Inside Macintosh', () => {
    const odt = openDT(7);
    expect(odt[0]).toBe(C.CmdOpenDT);
    expect(odt.length).toBe(4);
    expect(be16(odt, 2)).toBe(7);
    expect(parseOpenDT(new Uint8Array([0, 7]))).toBe(7);

    const gi = getIcon(7, 'ttxt', 'APPL', C.IconTypeICN, 256);
    expect(gi[0]).toBe(51);
    expect(gi.length).toBe(16);
    expect(be16(gi, 2)).toBe(7);
    expect([...gi.subarray(4, 8)]).toEqual([...encodeMacRoman('ttxt')]);
    expect([...gi.subarray(8, 12)]).toEqual([...encodeMacRoman('APPL')]);
    expect(gi[12]).toBe(C.IconTypeICN);
    expect(be16(gi, 14)).toBe(256);

    const info = getIconInfo(7, 'ttxt', 1);
    expect(info[0]).toBe(52);
    expect(info.length).toBe(10);
    expect(be16(info, 8)).toBe(1);

    const close = closeDT(7);
    expect(close[0]).toBe(C.CmdCloseDT);
    expect(be16(close, 2)).toBe(7);
  });

  it('parses FPGetIconInfo and probes ICN# when the creator list is empty', () => {
    const reply = new Uint8Array(12);
    reply.set(encodeMacRoman('APPL'), 4);
    reply[8] = C.IconTypeICN;
    writeBe16(reply, 10, 256);
    expect(parseGetIconInfo(reply)).toEqual({
      tag: 0,
      type: 'APPL',
      iconType: C.IconTypeICN,
      size: 256,
    });
    expect(desktopIconsToFetch(null, 'APPL')).toEqual([
      { iconType: C.IconTypeIcl8, size: 1024 },
      { iconType: C.IconTypeICN, size: 256 },
      { iconType: C.IconTypeIcs, size: 64 },
    ]);
    expect(desktopIconsToFetch([parseGetIconInfo(reply)!], 'APPL')).toEqual([
      { iconType: C.IconTypeICN, size: 256 },
    ]);
  });
});

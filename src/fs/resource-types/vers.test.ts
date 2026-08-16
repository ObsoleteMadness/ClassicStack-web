import { describe, expect, it } from 'vitest';
import { encodeMacRoman } from '../../protocol/macroman';
import { ResourceFork, type ResourceEntry } from '../resource-fork';
import {
  ALPHA_STAGE,
  BETA_STAGE,
  copyrightFromVers,
  decodeVers,
  decodeVers1,
  DEVELOP_STAGE,
  FINAL_STAGE,
  formatNumVersion,
  versInfoForGetInfo,
} from './vers';

function pstring(s: string): Uint8Array {
  const body = encodeMacRoman(s);
  const out = new Uint8Array(1 + body.length);
  out[0] = body.length;
  out.set(body, 1);
  return out;
}

function packVers(opts: {
  major: number;
  minorBug: number;
  stage: number;
  nonRel: number;
  country?: number;
  short: string;
  long: string;
}): Uint8Array {
  const short = pstring(opts.short);
  const long = pstring(opts.long);
  const out = new Uint8Array(6 + short.length + long.length);
  out[0] = opts.major;
  out[1] = opts.minorBug;
  out[2] = opts.stage;
  out[3] = opts.nonRel;
  const country = opts.country ?? 0;
  out[4] = (country >> 8) & 0xff;
  out[5] = country & 0xff;
  out.set(short, 6);
  out.set(long, 6 + short.length);
  return out;
}

describe('vers resource', () => {
  it('decodes NumVersion, country, and Pascal strings', () => {
    const bytes = packVers({
      major: 0x04,
      minorBug: 0x02,
      stage: FINAL_STAGE,
      nonRel: 0,
      short: '4.0.2',
      long: 'StuffIt Expander 4.0.2\r© 1990-1996 Aladdin Systems, Inc.',
    });
    const rec = decodeVers(bytes);
    expect(rec).not.toBeNull();
    expect(rec!.numeric).toEqual({
      majorRev: 0x04,
      minorAndBugRev: 0x02,
      stage: FINAL_STAGE,
      nonRelRev: 0,
    });
    expect(rec!.countryCode).toBe(0);
    expect(rec!.shortVersion).toBe('4.0.2');
    expect(rec!.longVersion).toBe('StuffIt Expander 4.0.2\r© 1990-1996 Aladdin Systems, Inc.');
  });

  it('formats BCD versions and pre-release stages', () => {
    expect(formatNumVersion({ majorRev: 0x04, minorAndBugRev: 0x02, stage: FINAL_STAGE, nonRelRev: 0 })).toBe(
      '4.0.2',
    );
    expect(formatNumVersion({ majorRev: 0x12, minorAndBugRev: 0x00, stage: FINAL_STAGE, nonRelRev: 0 })).toBe(
      '12.0',
    );
    expect(formatNumVersion({ majorRev: 0x01, minorAndBugRev: 0x00, stage: BETA_STAGE, nonRelRev: 3 })).toBe(
      '1.0b3',
    );
    expect(formatNumVersion({ majorRev: 0x01, minorAndBugRev: 0x10, stage: ALPHA_STAGE, nonRelRev: 1 })).toBe(
      '1.1a1',
    );
    expect(formatNumVersion({ majorRev: 0x02, minorAndBugRev: 0x00, stage: DEVELOP_STAGE, nonRelRev: 1 })).toBe(
      '2.0d1',
    );
  });

  it('pulls copyright from the long version string', () => {
    const rec = decodeVers(
      packVers({
        major: 0x08,
        minorBug: 0x60,
        stage: FINAL_STAGE,
        nonRel: 0,
        short: '8.6',
        long: '8.6\r© Apple Computer, Inc. 1983-1999',
      }),
    )!;
    expect(copyrightFromVers(rec)).toBe('© Apple Computer, Inc. 1983-1999');
    expect(versInfoForGetInfo(rec)).toEqual({
      version: '8.6',
      copyright: '© Apple Computer, Inc. 1983-1999',
    });
  });

  it('treats a one-line long string with © as copyright', () => {
    const rec = decodeVers(
      packVers({
        major: 0x01,
        minorBug: 0x00,
        stage: FINAL_STAGE,
        nonRel: 0,
        short: '1.0',
        long: '1.0, © 1994 Apple Computer, Inc.',
      }),
    )!;
    expect(versInfoForGetInfo(rec).copyright).toBe('1.0, © 1994 Apple Computer, Inc.');
  });

  it('reads vers id 1 from a resource fork', () => {
    const payload = packVers({
      major: 0x01,
      minorBug: 0x00,
      stage: FINAL_STAGE,
      nonRel: 0,
      short: '1.0',
      long: '© 1994',
    });
    const entry: ResourceEntry = {
      name: null,
      type: 'vers',
      id: 1,
      length: payload.length,
      attributes: 0,
      dataOffset: 0,
      payload,
    };
    expect(decodeVers1(ResourceFork.fromEntries([entry]))?.shortVersion).toBe('1.0');
    expect(decodeVers1(ResourceFork.fromEntries([{ ...entry, id: 2 }]))).toBeNull();
  });

  it('rejects truncated resources', () => {
    expect(decodeVers(new Uint8Array(4))).toBeNull();
    const short = new Uint8Array([0x01, 0x00, FINAL_STAGE, 0, 0, 0, 20, 0x41]);
    expect(decodeVers(short)).toBeNull();
  });
});

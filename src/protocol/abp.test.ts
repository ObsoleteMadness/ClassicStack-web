import { describe, expect, it } from 'vitest';
import * as abp from './abp';

describe('abp', () => {
  it('BootPktRply fixture matches NetBoot.py layout', () => {
    const got = abp.marshalBootPktRply({
      osID: 0x1234,
      userData: 0xdeadbeef,
      blockSize: 512,
      imageID: 7,
      result: -1,
      imageSize: 0x00010203,
    });
    expect(got.length).toBe(abp.DDPMaxData);
    expect([...got.subarray(0, 18)]).toEqual([
      2, 1, 0x12, 0x34, 0xde, 0xad, 0xbe, 0xef, 0x02, 0x00, 0x00, 0x07, 0xff, 0xff, 0x00, 0x01, 0x02, 0x03,
    ]);
    expect([...got.subarray(18)].every((b) => b === 0)).toBe(true);
    const back = abp.unmarshalBootPktRply(got);
    expect(back.osID).toBe(0x1234);
    expect(back.userData).toBe(0xdeadbeef);
    expect(back.blockSize).toBe(512);
    expect(back.imageID).toBe(7);
    expect(back.result).toBe(-1);
    expect(back.imageSize).toBe(0x00010203);
  });

  it('UserRecordRequest round-trips', () => {
    const name = new TextEncoder().encode('Patrick');
    const wire = abp.marshalUserRecordRequest({
      machineID: 1,
      timestamp: 0xcafef00d,
      userName: name,
    });
    expect(wire.length).toBe(42);
    expect([...wire.subarray(0, 16)]).toEqual([
      1, 1, 0x00, 0x01, 0xca, 0xfe, 0xf0, 0x0d, 7, 80, 97, 116, 114, 105, 99, 107,
    ]);
    const out = abp.unmarshalUserRecordRequest(wire);
    expect(out.machineID).toBe(1);
    expect(out.timestamp).toBe(0xcafef00d);
    expect([...out.userName]).toEqual([...name]);
  });

  it('rejects unsupported protocol version', () => {
    const wire = abp.marshalUserRecordRequest({ machineID: 0, timestamp: 0, userName: new Uint8Array() });
    wire[1] = 2;
    expect(() => abp.unmarshalUserRecordRequest(wire)).toThrow(/version/);
  });

  it('BootImageRequest round-trips including empty bitmap', () => {
    const inReq = {
      imageID: 3,
      section: 0,
      flags: 0x80,
      replyDelay: 9,
      bitmap: new Uint8Array([0xff, 0x01]),
    };
    const out = abp.unmarshalBootImageRequest(abp.marshalBootImageRequest(inReq));
    expect(out.imageID).toBe(3);
    expect(out.flags).toBe(0x80);
    expect(out.replyDelay).toBe(9);
    expect([...out.bitmap]).toEqual([0xff, 0x01]);

    const empty = abp.unmarshalBootImageRequest(new Uint8Array([3, 1, 0, 3, 0, 0, 0, 9]));
    expect(empty.bitmap.length).toBe(0);
  });

  it('BootBlock is 0-based on the wire', () => {
    const data = new Uint8Array(abp.DiskSector).fill(0xab);
    const wire = abp.marshalBootBlock({ imageID: 0, blockNo: 4087, data });
    expect(wire.length).toBe(6 + abp.DiskSector);
    expect(wire[4]).toBe(0x0f);
    expect(wire[5]).toBe(0xf7);
    const out = abp.unmarshalBootBlock(wire);
    expect(out.blockNo).toBe(4087);
  });

  it('ChainReadRequest fixture from live capture', () => {
    const wire = new Uint8Array([
      0x80, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
    ]);
    const out = abp.unmarshalChainReadRequest(wire);
    expect(out).toEqual({ seq: 1, imageNum: 0, blockOffset: 0, blockCount: 2 });
    expect([...abp.marshalChainReadRequest({ seq: 1, imageNum: 0, blockOffset: 0, blockCount: 2 })]).toEqual([
      ...wire,
    ]);
  });

  it('ChainReadData / ChainWrite / Ack round-trip', () => {
    const rd = abp.marshalChainReadData({
      blkIndex: 31,
      seq: 42,
      data: new Uint8Array(abp.ChainBlockSize).fill(0x5a),
    });
    expect([...rd.subarray(0, 4)]).toEqual([129, 31, 0, 42]);

    const data = new Uint8Array(512).fill(0x77);
    const wr = abp.marshalChainWriteBlock({ blkIndex: 5, seq: 9, imageNum: 1, hunkStart: 64, data });
    expect([...wr.subarray(0, 12)]).toEqual([130, 5, 0, 9, 0, 0, 0, 1, 0, 0, 0, 64]);
    const wrBack = abp.unmarshalChainWriteBlock(wr);
    expect(wrBack.blkIndex).toBe(5);
    expect(wrBack.hunkStart).toBe(64);

    const ack = abp.marshalChainWriteAck({ seq: 9 });
    expect([...ack]).toEqual([131, 0, 0, 9]);
  });
});

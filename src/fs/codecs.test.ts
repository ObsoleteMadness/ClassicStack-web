import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_CODEC_SIT,
  registerArchiveCodec,
  registeredArchiveCodecs,
  sniffArchiveCodec,
} from './codecs';
import { expandIncoming, isExpandableArchive } from './expand-incoming';
import type { ExpandedNode } from './expand-incoming';

describe('codec registry', () => {
  it('registers bundled archive codecs so the same id can replace them', () => {
    const ids = registeredArchiveCodecs().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([ARCHIVE_CODEC_SIT, 'binhex', 'macbinary', 'zip', 'applesingle']));
  });

  it('lets a later archive codec replace an earlier one with the same id', () => {
    const first: ExpandedNode[] = [{ kind: 'file', name: 'a', data: new Uint8Array(), resource: new Uint8Array(), finderInfo: new Uint8Array(32) }];
    const second: ExpandedNode[] = [{ kind: 'file', name: 'b', data: new Uint8Array(), resource: new Uint8Array(), finderInfo: new Uint8Array(32) }];
    registerArchiveCodec({
      id: 'test-sit',
      sniff: ({ name }) => name === 'codec-registry-replace.sitx',
      expand: () => first,
    });
    registerArchiveCodec({
      id: 'test-sit',
      sniff: ({ name }) => name === 'codec-registry-replace.sitx',
      expand: () => second,
    });
    expect(registeredArchiveCodecs().filter((c) => c.id === 'test-sit')).toHaveLength(1);
    expect(sniffArchiveCodec({ name: 'codec-registry-replace.sitx' })?.expand('codec-registry-replace.sitx', new Uint8Array())).toBe(second);
  });

  it('lets a replacement codec claim a name the bundled expanders would ignore', () => {
    registerArchiveCodec({
      id: 'vendor-sea',
      sniff: ({ name }) => name.endsWith('.sea'),
      expand: () => [
        { kind: 'file', name: 'Read Me', data: new Uint8Array([1]), resource: new Uint8Array(), finderInfo: new Uint8Array(32) },
      ],
    });
    expect(isExpandableArchive('Install.sea')).toBe(true);
    const out = expandIncoming('Install.sea', new Uint8Array([0]));
    expect(out?.[0]?.kind === 'file' && out[0].name).toBe('Read Me');
  });
});

import { describe, expect, it } from 'vitest';
import { encodeMacRoman } from '../protocol/macroman';
import { writeBe16 } from '../protocol/binary';
import { ResourceFork, type ResourceEntry } from './resource-fork';
import { makeFinderInfo } from './mac-file';
import {
  AFP_ATTR_DELETE_INHIBIT,
  AFP_ATTR_RENAME_INHIBIT,
  AFP_ATTR_WRITE_INHIBIT,
  FINDER_IS_STATIONERY,
  FINDER_NAME_LOCKED,
  decodeFcmt,
  finderCommentFromFork,
  finderCommentId,
  finderFlagLabels,
  finderGetInfoDetails,
  finderLabel,
} from './finder-info';

function pstring(s: string): Uint8Array {
  const body = encodeMacRoman(s);
  const out = new Uint8Array(1 + body.length);
  out[0] = body.length;
  out.set(body, 1);
  return out;
}

describe('finder Get Info details', () => {
  it('reports stationery, name locked, and label from fdFlags', () => {
    const fi = makeFinderInfo('TEXT', 'ttxt', FINDER_IS_STATIONERY | FINDER_NAME_LOCKED | (2 << 1));
    const d = finderGetInfoDetails(fi);
    expect(d.stationery).toBe(true);
    expect(d.nameLocked).toBe(true);
    expect(d.label).toEqual({ index: 2, name: 'Hot', color: '#e23c3c' });
    expect(finderFlagLabels(d)).toEqual(['Stationery', 'Name locked']);
    expect(finderLabel(makeFinderInfo('TEXT', 'ttxt'))).toBeNull();
  });

  it('maps AFP write inhibit to Locked and rename/delete inhibit to Read only', () => {
    const fi = makeFinderInfo('TEXT', 'ttxt');
    expect(finderGetInfoDetails(fi, { attributes: AFP_ATTR_WRITE_INHIBIT }).locked).toBe(true);
    expect(
      finderFlagLabels(
        finderGetInfoDetails(fi, { attributes: AFP_ATTR_RENAME_INHIBIT | AFP_ATTR_DELETE_INHIBIT }),
      ),
    ).toEqual(['Read only']);
  });

  it('treats TeachText ttro as read only', () => {
    const fi = makeFinderInfo('ttro', 'ttxt');
    expect(finderFlagLabels(finderGetInfoDetails(fi, { type: 'ttro' }))).toEqual(['Read only']);
  });

  it('reads the FXInfo comment id and FCMT Pascal string', () => {
    const fi = makeFinderInfo('TEXT', 'ttxt');
    writeBe16(fi, 26, 12);
    expect(finderCommentId(fi)).toBe(12);
    expect(decodeFcmt(pstring('Backup before System 7.5'))).toBe('Backup before System 7.5');
    const payload = pstring('Project notes');
    const entry: ResourceEntry = {
      name: null,
      type: 'FCMT',
      id: 12,
      length: payload.length,
      attributes: 0,
      dataOffset: 0,
      payload,
    };
    expect(finderCommentFromFork(ResourceFork.fromEntries([entry]), fi)).toBe('Project notes');
    expect(finderCommentFromFork(ResourceFork.fromEntries([{ ...entry, id: 1 }]), fi)).toBeNull();
  });
});

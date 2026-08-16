import { describe, expect, it } from 'vitest';
import { encodeMacRoman } from '../protocol/macroman';
import { writeBe16, writeBe32 } from '../protocol/binary';
import { ResourceFork, type ResourceEntry } from './resource-fork';
import { makeFinderInfo } from './mac-file';
import {
  AFP_ATTR_DELETE_INHIBIT,
  AFP_ATTR_RENAME_INHIBIT,
  AFP_ATTR_WRITE_INHIBIT,
  FINDER_IS_STATIONERY,
  FINDER_NAME_LOCKED,
  HAS_CUSTOM_ICON,
  kHasCustomIcon,
  kIsStationery,
  kNameLocked,
  decodeFcmt,
  finderCommentFromFork,
  finderCommentId,
  finderFlagLabels,
  finderFlags,
  finderGetInfoDetails,
  finderLabel,
  parseFinderInfoFile,
  parseFinderInfoFolder,
} from './finder-info';

function pstring(s: string): Uint8Array {
  const body = encodeMacRoman(s);
  const out = new Uint8Array(1 + body.length);
  out[0] = body.length;
  out.set(body, 1);
  return out;
}

/** Dropbox finderinfo-rust test vectors (com.apple.FinderInfo xattr, 32 bytes). */
const DEFAULT_FINDERINFO_XATTR_VALUE = new Uint8Array(32);

const FINDERINFO_XATTR_VALUE_ON = Uint8Array.from([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** Custom icon + Blue (kColor 0x08). */
const FINDERINFO_XATTR_RED_BLUE_FOO_ICON = Uint8Array.from([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** Label = Red (kColor 0x0c). */
const FINDERINFO_XATTR_FOO_BLUE_RED = Uint8Array.from([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const FINDERINFO_XATTR_FOO_BLUE_RED_ICON = Uint8Array.from([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

describe('Dropbox finderinfo-rust FileInfo / FolderInfo layout', () => {
  it('treats a 32-byte blob as FileInfo(16)+ExtendedFileInfo(16)', () => {
    const parsed = parseFinderInfoFile(DEFAULT_FINDERINFO_XATTR_VALUE)!;
    expect(parsed.fileInfo.finderFlags).toBe(0);
    expect(finderLabel(DEFAULT_FINDERINFO_XATTR_VALUE)).toBeNull();
    expect(parsed.fileInfo.location).toEqual({ v: 0, h: 0 });
    expect(parsed.extendedFileInfo.putAwayFolderID).toBe(0);
  });

  it('reads kHasCustomIcon from flags at offset 8 (file and folder)', () => {
    const file = parseFinderInfoFile(FINDERINFO_XATTR_VALUE_ON)!;
    const folder = parseFinderInfoFolder(FINDERINFO_XATTR_VALUE_ON)!;
    expect(file.fileInfo.finderFlags & kHasCustomIcon).toBe(kHasCustomIcon);
    expect(folder.folderInfo.finderFlags & kHasCustomIcon).toBe(kHasCustomIcon);
    expect(finderFlags(FINDERINFO_XATTR_VALUE_ON)).toBe(HAS_CUSTOM_ICON);
  });

  it('maps kColor bits the Dropbox LabelColor way (Blue 0x08, Red 0x0c)', () => {
    expect(finderLabel(FINDERINFO_XATTR_RED_BLUE_FOO_ICON)).toMatchObject({
      bits: 0x08,
      index: 4,
      name: 'Blue',
    });
    expect(parseFinderInfoFile(FINDERINFO_XATTR_RED_BLUE_FOO_ICON)!.fileInfo.finderFlags).toBe(
      0x0408,
    );

    const red = parseFinderInfoFolder(FINDERINFO_XATTR_FOO_BLUE_RED)!;
    expect(red.folderInfo.finderFlags).toBe(0x000c);
    expect(finderLabel(FINDERINFO_XATTR_FOO_BLUE_RED)?.name).toBe('Red');

    const redIcon = parseFinderInfoFile(FINDERINFO_XATTR_FOO_BLUE_RED_ICON)!;
    expect(redIcon.fileInfo.finderFlags & kHasCustomIcon).toBe(kHasCustomIcon);
    expect(finderLabel(FINDERINFO_XATTR_FOO_BLUE_RED_ICON)?.name).toBe('Red');
  });

  it('parses FileInfo type/creator and FolderInfo window bounds from the first 8 bytes', () => {
    const fileBytes = makeFinderInfo('TEXT', 'ttxt', 0, 12, -8, 2);
    const file = parseFinderInfoFile(fileBytes)!;
    expect(file.fileInfo.fileType).toBe('TEXT');
    expect(file.fileInfo.fileCreator).toBe('ttxt');
    expect(file.fileInfo.location).toEqual({ v: 12, h: -8 });
    expect(file.fileInfo.reservedField).toBe(2);

    const folderBytes = new Uint8Array(32);
    writeBe16(folderBytes, 0, 10); // top
    writeBe16(folderBytes, 2, 20); // left
    writeBe16(folderBytes, 4, 300); // bottom
    writeBe16(folderBytes, 6, 400); // right
    writeBe16(folderBytes, 8, kHasCustomIcon);
    writeBe16(folderBytes, 10, 5);
    writeBe16(folderBytes, 12, 7);
    const folder = parseFinderInfoFolder(folderBytes)!;
    expect(folder.folderInfo.windowBounds).toEqual({ top: 10, left: 20, bottom: 300, right: 400 });
    expect(folder.folderInfo.location).toEqual({ v: 5, h: 7 });
    expect(folder.folderInfo.finderFlags).toBe(kHasCustomIcon);
  });

  it('parses ExtendedFileInfo putAwayFolderID and classic comment overlay at offset 26', () => {
    const b = new Uint8Array(32);
    writeBe16(b, 16, 128); // classic fdIconID / reserved1[0]
    writeBe16(b, 24, 0x0100); // kExtendedFlagHasCustomBadge
    writeBe16(b, 26, 12); // classic fdComment / Carbon reserved2
    writeBe32(b, 28, 0x0000022a);
    const ext = parseFinderInfoFile(b)!.extendedFileInfo;
    expect(ext.reserved1[0]).toBe(128);
    expect(ext.extendedFinderFlags).toBe(0x0100);
    expect(ext.reserved2).toBe(12);
    expect(ext.putAwayFolderID).toBe(0x22a);
    expect(finderCommentId(b)).toBe(12);
  });
});

describe('finder Get Info details', () => {
  it('reports stationery, name locked, and OS X label bits from fdFlags', () => {
    const fi = makeFinderInfo('TEXT', 'ttxt', kIsStationery | kNameLocked | 0x04);
    const d = finderGetInfoDetails(fi);
    expect(d.stationery).toBe(true);
    expect(d.nameLocked).toBe(true);
    expect(d.label?.name).toBe('Green');
    expect(finderFlagLabels(d)).toEqual(['Stationery', 'Name locked']);
    expect(finderLabel(makeFinderInfo('TEXT', 'ttxt'))).toBeNull();
    expect(FINDER_IS_STATIONERY).toBe(kIsStationery);
    expect(FINDER_NAME_LOCKED).toBe(kNameLocked);
  });

  it('does not treat a folder window-bounds blob as stationery or ttro', () => {
    const folder = FINDERINFO_XATTR_VALUE_ON;
    const d = finderGetInfoDetails(folder, { isDir: true, type: 'ttro' });
    expect(d.stationery).toBe(false);
    expect(d.readOnly).toBe(false);
    expect(d.customIcon).toBe(true);
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

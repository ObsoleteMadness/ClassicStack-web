/** Filename extension → Macintosh type/creator codes (persisted in localStorage). */

export const EXTENSION_MAP_STORAGE_KEY = 'classicstack.extension-map';

export interface ExtensionMapping {
  /** Filename suffix without a leading dot (lowercase). */
  extension: string;
  /** Four-character Macintosh creator OSType. */
  creator: string;
  /** Four-character Macintosh type OSType. */
  type: string;
  /** Short Internet Config–style comment (kind / format name). */
  comment: string;
}

/**
 * Built-in mappings used until the user saves an edited list.
 * Type/creator/comment follow classic Internet Config defaults for common files.
 */
export const DEFAULT_EXTENSION_MAP: readonly ExtensionMapping[] = [
  { extension: 'hqx', creator: 'SITx', type: 'TEXT', comment: 'BinHex' },
  { extension: 'bin', creator: 'SITx', type: 'SIT!', comment: 'MacBinary' },
  { extension: 'sit', creator: 'SITx', type: 'SIT!', comment: 'StuffIt Archive' },
  { extension: 'zip', creator: 'SITx', type: 'ZIP ', comment: 'PC ZIP Archive' },
  { extension: 'aiff', creator: 'SCPL', type: 'AIFF', comment: 'AIFF Sound' },
  { extension: 'aif', creator: 'SCPL', type: 'AIFF', comment: 'AIFF Sound' },
  { extension: 'mov', creator: 'TVOD', type: 'MooV', comment: 'QuickTime Movie' },
  { extension: 'qt', creator: 'TVOD', type: 'MooV', comment: 'QuickTime Movie' },
  { extension: 'doc', creator: 'MSWD', type: 'WDBN', comment: 'Word Document' },
  { extension: 'txt', creator: 'ttxt', type: 'TEXT', comment: 'ASCII Text' },
  { extension: 'text', creator: 'ttxt', type: 'TEXT', comment: 'ASCII Text' },
  { extension: 'ttro', creator: 'ttxt', type: 'ttro', comment: 'TeachText Read-Only' },
  { extension: 'md', creator: 'ttxt', type: 'TEXT', comment: 'Markdown Text' },
  { extension: 'wav', creator: 'TVOD', type: 'WAVE', comment: 'Windows WAV Sound' },
  { extension: 'mp3', creator: 'TVOD', type: 'MPG3', comment: 'MPEG-3 Audio' },
  { extension: 'c', creator: 'CWIE', type: 'TEXT', comment: 'C Source' },
  { extension: 'h', creator: 'CWIE', type: 'TEXT', comment: 'C Include File' },
  { extension: 'p', creator: 'CWIE', type: 'TEXT', comment: 'Pascal Source' },
  { extension: 'a', creator: 'ttxt', type: 'TEXT', comment: 'Assembly Source' },
  { extension: 'ppt', creator: 'PPT3', type: 'SLDS', comment: 'PowerPoint Presentation' },
  { extension: 'xls', creator: 'XCEL', type: 'XLS ', comment: 'Excel Spreadsheet' },
  { extension: 'cwk', creator: 'BOBO', type: 'CWWP', comment: 'ClarisWorks Document' },
  { extension: 'c20', creator: 'BOBO', type: 'CWWP', comment: 'ClarisWorks 2.0 Document' },
  { extension: 'pict', creator: 'TVOD', type: 'PICT', comment: 'QuickTime Picture' },
  { extension: 'pic', creator: 'TVOD', type: 'PICT', comment: 'QuickTime Picture' },
  { extension: 'pct', creator: 'TVOD', type: 'PICT', comment: 'QuickTime Picture' },
  { extension: 'jpg', creator: 'ogle', type: 'JPEG', comment: 'JPEG Picture' },
  { extension: 'jpeg', creator: 'ogle', type: 'JPEG', comment: 'JPEG Picture' },
  { extension: 'gif', creator: 'ogle', type: 'GIFf', comment: 'GIF Picture' },
  { extension: 'png', creator: 'ogle', type: 'PNG ', comment: 'Portable Network Graphic' },
  { extension: 'psd', creator: '8BIM', type: '8BPS', comment: 'PhotoShop Document' },
  { extension: 'qxd', creator: 'XPR3', type: 'XDOC', comment: 'QuarkXpress Document' },
  { extension: 'ai', creator: 'ART5', type: 'EPSF', comment: 'Adobe Illustrator' },
  { extension: 'pm3', creator: 'ALD3', type: 'ALB3', comment: 'PageMaker 3 Document' },
  { extension: 'pm4', creator: 'ALD4', type: 'ALB4', comment: 'PageMaker 4 Document' },
  { extension: 'pm5', creator: 'ALD5', type: 'ALB5', comment: 'PageMaker 5 Document' },
  { extension: 'pm6', creator: 'ALD6', type: 'ALB6', comment: 'PageMaker 6 Document' },
  { extension: 'p65', creator: 'ALD6', type: 'ALB6', comment: 'PageMaker 6.5 Document' },
  { extension: 'pmd', creator: 'ALD6', type: 'ALB6', comment: 'PageMaker Document' },
  { extension: 'pm', creator: 'ALD5', type: 'ALB5', comment: 'PageMaker Document' },
  { extension: 'fh7', creator: 'FH70', type: 'AGD3', comment: 'FreeHand 7 Drawing' },
  { extension: 'fh8', creator: 'FH80', type: 'AGD3', comment: 'FreeHand 8 Drawing' },
  { extension: 'fh9', creator: 'FH90', type: 'AGD3', comment: 'FreeHand 9 Drawing' },
  { extension: 'fh10', creator: 'FH10', type: 'AGD3', comment: 'FreeHand 10 Drawing' },
  { extension: 'fh11', creator: 'FH11', type: 'AGD3', comment: 'FreeHand MX Drawing' },
  { extension: 'fh', creator: 'FH80', type: 'AGD3', comment: 'FreeHand Drawing' },
  { extension: 'iso', creator: 'CDr3', type: 'ISO ', comment: 'Toast Disc Image' },
  { extension: 'toast', creator: 'CDr3', type: 'devi', comment: 'Toast Disc Image' },
  { extension: 'image', creator: 'ddsk', type: 'dImg', comment: 'Disk Copy Image' },
  { extension: 'ndif', creator: 'ddsk', type: 'dImg', comment: 'Disk Copy Image' },
  { extension: 'dsk', creator: 'ddsk', type: 'dImg', comment: 'Disk Copy Image' },
  { extension: 'disk', creator: 'ddsk', type: 'dImg', comment: 'Disk Copy Image' },
  { extension: 'hfv', creator: 'ddsk', type: 'dImg', comment: 'Disk Copy Image' },
  { extension: 'dc4', creator: 'dCpy', type: 'DDim', comment: 'Disk Copy 4.2 Image' },
  { extension: 'htm', creator: 'MOSS', type: 'TEXT', comment: 'HyperText' },
  { extension: 'html', creator: 'MOSS', type: 'TEXT', comment: 'HyperText' },
  { extension: 'pdf', creator: 'CARO', type: 'PDF ', comment: 'Portable Document Format' },
];

export function cloneDefaultExtensionMap(): ExtensionMapping[] {
  return DEFAULT_EXTENSION_MAP.map((row) => ({ ...row }));
}

/** Pad/truncate to a 4-character OSType (space-padded). */
export function padOsType(s: string): string {
  return (s || '????').padEnd(4, ' ').slice(0, 4);
}

export function normalizeExtension(ext: string): string {
  return ext.trim().replace(/^\.+/, '').toLowerCase();
}

/** Last path segment after the final dot, matching historical VirtualFS behavior. */
export function filenameExtension(name: string): string {
  if (!name.includes('.')) return '';
  return (name.split('.').pop() ?? '').toLowerCase();
}

export function normalizeMappings(rows: readonly ExtensionMapping[]): ExtensionMapping[] {
  const seen = new Map<string, ExtensionMapping>();
  for (const row of rows) {
    const extension = normalizeExtension(row.extension);
    if (!extension) continue;
    seen.set(extension, {
      extension,
      creator: padOsType(row.creator),
      type: padOsType(row.type),
      comment: (row.comment ?? '').trim(),
    });
  }
  return [...seen.values()];
}

/** Parse stored JSON. `null` means “use defaults”; `[]` is a valid empty user list. */
export function parseExtensionMap(raw: unknown): ExtensionMapping[] | null {
  if (!Array.isArray(raw)) return null;
  return normalizeMappings(
    raw.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const rec = item as Record<string, unknown>;
      if (typeof rec.extension !== 'string') return [];
      return [
        {
          extension: rec.extension,
          creator: typeof rec.creator === 'string' ? rec.creator : '????',
          type: typeof rec.type === 'string' ? rec.type : '????',
          comment: typeof rec.comment === 'string' ? rec.comment : '',
        },
      ];
    }),
  );
}

export function loadExtensionMap(): ExtensionMapping[] {
  try {
    const raw = localStorage.getItem(EXTENSION_MAP_STORAGE_KEY);
    if (!raw) return cloneDefaultExtensionMap();
    const parsed = parseExtensionMap(JSON.parse(raw) as unknown);
    return parsed ?? cloneDefaultExtensionMap();
  } catch {
    return cloneDefaultExtensionMap();
  }
}

export function saveExtensionMap(rows: readonly ExtensionMapping[]): ExtensionMapping[] {
  const next = normalizeMappings(rows);
  try {
    localStorage.setItem(EXTENSION_MAP_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
  return next;
}

export function lookupExtension(
  name: string,
  rows: readonly ExtensionMapping[] = loadExtensionMap(),
): { type: string; creator: string } {
  const ext = filenameExtension(name);
  const hit = ext ? rows.find((r) => r.extension === ext) : undefined;
  return hit
    ? { type: padOsType(hit.type), creator: padOsType(hit.creator) }
    : { type: '????', creator: '????' };
}

export function finderInfoFromName(name: string, rows?: readonly ExtensionMapping[]): Uint8Array {
  const fi = new Uint8Array(32);
  const { type, creator } = lookupExtension(name, rows ?? loadExtensionMap());
  for (let i = 0; i < 4; i++) {
    fi[i] = type.charCodeAt(i) || 0x20;
    fi[4 + i] = creator.charCodeAt(i) || 0x20;
  }
  return fi;
}

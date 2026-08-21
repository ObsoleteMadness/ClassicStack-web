/** Windows PE/NE predefined resource type ids (RT_*). */

export const RT_CURSOR = 1;
export const RT_BITMAP = 2;
export const RT_ICON = 3;
export const RT_MENU = 4;
export const RT_DIALOG = 5;
export const RT_STRING = 6;
export const RT_FONTDIR = 7;
export const RT_FONT = 8;
export const RT_ACCELERATOR = 9;
export const RT_RCDATA = 10;
export const RT_MESSAGETABLE = 11;
export const RT_GROUP_CURSOR = 12;
export const RT_GROUP_ICON = 14;
export const RT_VERSION = 16;
/** Same as RT_VERSION; VERSIONINFO / VS_VERSION_INFO in .rc files. */
export const RT_VERSIONINFO = RT_VERSION;
export const RT_DLGINCLUDE = 17;
export const RT_PLUGPLAY = 19;
export const RT_VXD = 20;
export const RT_ANICURSOR = 21;
export const RT_ANIICON = 22;
export const RT_HTML = 23;
export const RT_MANIFEST = 24;

export const RT_LABELS: Record<number, string> = {
  [RT_CURSOR]: 'Cursor',
  [RT_BITMAP]: 'Bitmap',
  [RT_ICON]: 'Icon',
  [RT_MENU]: 'Menu',
  [RT_DIALOG]: 'Dialog',
  [RT_STRING]: 'String table',
  [RT_FONTDIR]: 'Font directory',
  [RT_FONT]: 'Font',
  [RT_ACCELERATOR]: 'Accelerator',
  [RT_RCDATA]: 'Raw data',
  [RT_MESSAGETABLE]: 'Message table',
  [RT_GROUP_CURSOR]: 'Cursor group',
  [RT_GROUP_ICON]: 'Icon group',
  [RT_VERSION]: 'Version',
  [RT_DLGINCLUDE]: 'Dialog include',
  [RT_PLUGPLAY]: 'Plug and Play',
  [RT_VXD]: 'VxD',
  [RT_ANICURSOR]: 'Animated cursor',
  [RT_ANIICON]: 'Animated icon',
  [RT_HTML]: 'HTML',
  [RT_MANIFEST]: 'Manifest',
};

export const RT_ICON_TYPES = new Set([RT_ICON, RT_GROUP_ICON, RT_CURSOR, RT_GROUP_CURSOR, RT_BITMAP]);

export function rtTypeKey(id: number | null, name: string | null): string {
  if (name) return `n:${name}`;
  if (id != null) return `id:${id}`;
  return 'unknown';
}

export function rtTypeLabel(id: number | null, name: string | null): string {
  if (name) return name;
  if (id != null) return RT_LABELS[id] ?? `RT_${id}`;
  return 'Unknown';
}

export const RT_NAMES: Record<number, string> = {
  [RT_CURSOR]: 'RT_CURSOR',
  [RT_BITMAP]: 'RT_BITMAP',
  [RT_ICON]: 'RT_ICON',
  [RT_MENU]: 'RT_MENU',
  [RT_DIALOG]: 'RT_DIALOG',
  [RT_STRING]: 'RT_STRING',
  [RT_FONTDIR]: 'RT_FONTDIR',
  [RT_FONT]: 'RT_FONT',
  [RT_ACCELERATOR]: 'RT_ACCELERATOR',
  [RT_RCDATA]: 'RT_RCDATA',
  [RT_MESSAGETABLE]: 'RT_MESSAGETABLE',
  [RT_GROUP_CURSOR]: 'RT_GROUP_CURSOR',
  [RT_GROUP_ICON]: 'RT_GROUP_ICON',
  [RT_VERSION]: 'RT_VERSION',
  [RT_DLGINCLUDE]: 'RT_DLGINCLUDE',
  [RT_PLUGPLAY]: 'RT_PLUGPLAY',
  [RT_VXD]: 'RT_VXD',
  [RT_ANICURSOR]: 'RT_ANICURSOR',
  [RT_ANIICON]: 'RT_ANIICON',
  [RT_HTML]: 'RT_HTML',
  [RT_MANIFEST]: 'RT_MANIFEST',
};

export function rtTypeCode(id: number | null, name: string | null): string {
  if (name) return name;
  if (id != null) return RT_NAMES[id] ?? `RT_${id}`;
  return '?';
}

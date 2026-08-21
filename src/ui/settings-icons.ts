/** Settings sidebar icons from ClassicStack-web/icons (Icons8 + classic). */

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** PNG nav glyph served from /icons/{ui|classic}/… */
export function settingsIconImg(src: string, size = 18): string {
  return `<img src="${escapeAttr(src)}" width="${size}" height="${size}" alt="" draggable="false" />`;
}

const ui = (name: string) => `/icons/ui/${name}`;
const classic = (name: string) => `/icons/classic/${name}`;

/** Bitmap icons for Settings / Preferences nav sections. */
export const settingsBitmapIcons = {
  general: settingsIconImg(ui('icons8-settings-100.png')),
  bridge: settingsIconImg(ui('icons8-network-card-100.png')),
  tashtalk: settingsIconImg(ui('icons8-ps2-female-100.png')),
  ltoudp: settingsIconImg(ui('icons8-online-100.png')),
  ethertalk: settingsIconImg(ui('icons8-wired-network-100.png')),
  ipx: settingsIconImg(classic('ipx-cp.png')),
  netbeui: settingsIconImg(ui('icons8-ibm-100.png')),
  netbios: settingsIconImg(ui('icons8-bios-100.png')),
  etherdfs: settingsIconImg(ui('icons8-dos-100.png')),
  afp: settingsIconImg(ui('icons8-happy-mac-100.png')),
  smb: settingsIconImg(ui('icons8-windows-95-100.png')),
  ncp: settingsIconImg(ui('icons8-netware-logo-100.png')),
  netboot: settingsIconImg(ui('icons8-work-boot-100.png')),
  router: settingsIconImg(ui('icons8-router-symbol-100.png')),
} as const;

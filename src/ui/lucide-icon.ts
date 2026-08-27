import {
  ChevronRight,
  ClipboardPaste,
  Columns3,
  Copy,
  Download,
  Eject,
  Ellipsis,
  LogOut,
  FileArchive,
  FolderPlus,
  Info,
  LayoutGrid,
  List,
  Maximize2,
  Menu,
  Minimize2,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Trash2,
  Upload,
  Usb,
  type IconNode,
} from 'lucide';

function escapeAttr(value: string | number): string {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function lucideSvg(icon: IconNode, size = 16): string {
  const inner = icon
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}="${escapeAttr(v as string | number)}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export const uiIcons = {
  cut: lucideSvg(Scissors),
  copy: lucideSvg(Copy),
  paste: lucideSvg(ClipboardPaste),
  mkdir: lucideSvg(FolderPlus),
  delete: lucideSvg(Trash2),
  add: lucideSvg(Plus, 14),
  props: lucideSvg(Info),
  download: lucideSvg(Download, 14),
  downloadZip: lucideSvg(FileArchive),
  viewIcon: lucideSvg(LayoutGrid),
  viewList: lucideSvg(List),
  viewColumn: lucideSvg(Columns3),
  refresh: lucideSvg(RefreshCw, 14),
  eject: lucideSvg(Eject, 14),
  disconnect: lucideSvg(LogOut, 14),
  more: lucideSvg(Ellipsis),
  menu: lucideSvg(Menu),
  import: lucideSvg(Upload),
  usb: lucideSvg(Usb),
  disclose: lucideSvg(ChevronRight, 16),
  maximize: lucideSvg(Maximize2, 14),
  restore: lucideSvg(Minimize2, 14),
  environment: lucideSvg(RotateCcw),
};

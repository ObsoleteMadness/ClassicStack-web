/**
 * Icon family grouped by resource id (port of LibHfs IconSet).
 * Color selection prefers high colour (cicn) → 8-bit → 4-bit → B&W.
 */

import type { ResourceFork } from '../resource-fork';
import {
  SUPPORTED_ICON_TYPES,
  applyMask,
  decodeIcon,
  type DecodedIcon,
} from './icon-decoder';

export enum IconSize {
  Small = 'small',
  Medium = 'medium',
  Large = 'large',
  Huge = 'huge',
  Other = 'other',
}

/** Preferred type order within each size: high colour → 8-bit → 4-bit → B&W. */
const SmallBwTypes = ['ics#'];
const LargeBwTypes = ['ICN#', 'ICON'];
const LargeColorTypes = ['cicn', 'icl8', 'icl4'];
const SmallColorTypes = ['cicn', 'ics8', 'ics4'];
const MediumBwTypes = ['icm#'];
const MediumColorTypes = ['cicn', 'icm8', 'icm4'];
const HugeColorTypes = ['cicn', 'ich8', 'ich4'];
const HugeBwTypes = ['ich#'];

/**
 * Higher is better. cicn = high colour; *8 = 8-bit; *4 = 4-bit; B&W = 0.
 */
export function iconColorDepthRank(icon: DecodedIcon): number {
  if (!icon.isColor) return 0;
  const t = icon.typeCode.trim();
  if (t === 'cicn') return 3;
  if (t.endsWith('8')) return 2;
  if (t.endsWith('4')) return 1;
  return 2;
}

export const CUSTOM_ICON_ID = -16455;
export const CDEV_ICON_ID = -4064;
export const DEFAULT_ICON_ID = 128;

export class IconSet {
  readonly icons: DecodedIcon[];

  constructor(icons: DecodedIcon[]) {
    this.icons = icons;
  }

  static fromResourceFork(id: number, fork: ResourceFork): IconSet | null {
    const entries = fork.findByIdAny(id, [...SUPPORTED_ICON_TYPES]);
    const icons: DecodedIcon[] = [];
    for (const entry of entries) {
      const icon = decodeIcon(entry.type, fork.readBytes(entry));
      if (icon) icons.push(icon);
    }
    if (!icons.length) return null;
    return new IconSet(icons);
  }

  /** Every supported icon in the fork (custom Icon\\r files, sparse extracts). */
  static fromFork(fork: ResourceFork): IconSet | null {
    const types = new Set<string>(SUPPORTED_ICON_TYPES);
    const icons: DecodedIcon[] = [];
    for (const entry of fork.allEntries) {
      if (!types.has(entry.type)) continue;
      const icon = decodeIcon(entry.type, fork.readBytes(entry));
      if (icon) icons.push(icon);
    }
    if (!icons.length) return null;
    return new IconSet(icons);
  }

  getIcon(typeCode: string): DecodedIcon | undefined {
    return this.icons.find((c) => c.typeCode === typeCode);
  }

  /** First present type from a preference-ordered list (optionally size-matched). */
  private pickByTypeOrder(types: string[], size?: IconSize): DecodedIcon | undefined {
    for (const t of types) {
      const icon = this.getIcon(t);
      if (!icon) continue;
      if (size != null && this.getIconSize(icon) !== size) continue;
      return icon;
    }
    return undefined;
  }

  addMask(icon: DecodedIcon): DecodedIcon {
    const bw = this.getIconBySize(this.getIconSize(icon), false, false);
    if (!bw) return icon;
    return applyMask(icon, bw);
  }

  getIconBySize(size: IconSize, color = true, addMaskFlag = true): DecodedIcon | undefined {
    const candidates = this.icons.filter((c) => this.getIconSize(c) === size);
    let icon: DecodedIcon | undefined;
    if (color) {
      icon = [...candidates].sort((a, b) => iconColorDepthRank(b) - iconColorDepthRank(a))[0];
    } else {
      icon = candidates.find((c) => !c.isColor);
    }

    if (addMaskFlag && icon?.isColor) icon = this.addMask(icon);
    return icon;
  }

  getIconSize(icon: DecodedIcon): IconSize {
    if (icon.width === 16 && icon.height === 16) return IconSize.Small;
    if (icon.width === 16 && icon.height === 12) return IconSize.Medium;
    if (icon.width === 32 && icon.height === 32) return IconSize.Large;
    if (icon.width === 48 && icon.height === 48) return IconSize.Huge;
    return IconSize.Other;
  }

  get smallColor(): DecodedIcon | undefined {
    return this.pickByTypeOrder(SmallColorTypes, IconSize.Small);
  }
  get smallBw(): DecodedIcon | undefined {
    return this.pickByTypeOrder(SmallBwTypes, IconSize.Small);
  }
  get largeColor(): DecodedIcon | undefined {
    return this.pickByTypeOrder(LargeColorTypes, IconSize.Large);
  }
  get largeBw(): DecodedIcon | undefined {
    return this.pickByTypeOrder(LargeBwTypes, IconSize.Large);
  }
  get mediumColor(): DecodedIcon | undefined {
    return this.pickByTypeOrder(MediumColorTypes, IconSize.Medium);
  }
  get mediumBw(): DecodedIcon | undefined {
    return this.pickByTypeOrder(MediumBwTypes, IconSize.Medium);
  }
  get hugeColor(): DecodedIcon | undefined {
    return this.pickByTypeOrder(HugeColorTypes, IconSize.Huge);
  }
  get hugeBw(): DecodedIcon | undefined {
    return this.pickByTypeOrder(HugeBwTypes, IconSize.Huge);
  }
}

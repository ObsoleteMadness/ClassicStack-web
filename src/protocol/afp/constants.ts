/** AFP 2.x constants (ClassicStack core/protocol/afp). */

export const CmdCloseVol = 2;
export const CmdCloseFork = 4;
export const CmdCreateDir = 6;
export const CmdCreateFile = 7;
export const CmdDelete = 8;
export const CmdEnumerate = 9;
export const CmdFlush = 10;
export const CmdFlushFork = 11;
export const CmdGetFileParms = 13;
export const CmdGetForkParms = 14;
export const CmdGetSrvrInfo = 15;
export const CmdGetSrvrParms = 16;
export const CmdGetVolParms = 17;
export const CmdLogin = 18;
export const CmdLoginCont = 19;
export const CmdLogout = 20;
export const CmdMoveAndRename = 23;
export const CmdOpenVol = 24;
export const CmdOpenFork = 26;
export const CmdRead = 27;
export const CmdRename = 28;
export const CmdSetDirParms = 29;
export const CmdSetFileParms = 30;
export const CmdSetForkParms = 31;
export const CmdWrite = 33;
export const CmdGetFileDirParms = 34;
export const CmdSetFileDirParms = 35;
/** ASP Write (bitmap in the write buffer). Other Desktop DB calls use 48–55. */
export const CmdAddIcon = 192;
/** Inside Macintosh AFP: afpGetIcon=51, afpGtIcnInfo=52 (not 193/194). */
export const CmdGetIcon = 51;
export const CmdGetIconInfo = 52;
export const CmdAddAPPL = 53;
export const CmdRemoveAPPL = 54;
export const CmdGetAPPL = 55;
export const CmdGetSrvrMsg = 38;
export const CmdOpenDT = 48;
export const CmdCloseDT = 49;

/** Desktop Manager iconType byte used by FPGetIcon (often only ICN# is stored). */
export const IconTypeICN = 1;
export const IconTypeIcl4 = 2;
export const IconTypeIcl8 = 3;
export const IconTypeIcs = 4;
export const IconTypeIcs4 = 5;
export const IconTypeIcs8 = 6;

const AFP_CMD_NAME: Record<number, string> = {
  [CmdCloseVol]: 'FPCloseVol',
  [CmdCloseFork]: 'FPCloseFork',
  [CmdCreateDir]: 'FPCreateDir',
  [CmdCreateFile]: 'FPCreateFile',
  [CmdDelete]: 'FPDelete',
  [CmdEnumerate]: 'FPEnumerate',
  [CmdFlush]: 'FPFlush',
  [CmdFlushFork]: 'FPFlushFork',
  [CmdGetFileParms]: 'FPGetFileParms',
  [CmdGetForkParms]: 'FPGetForkParms',
  [CmdGetSrvrInfo]: 'FPGetSrvrInfo',
  [CmdGetSrvrParms]: 'FPGetSrvrParms',
  [CmdGetVolParms]: 'FPGetVolParms',
  [CmdLogin]: 'FPLogin',
  [CmdLoginCont]: 'FPLoginCont',
  [CmdLogout]: 'FPLogout',
  [CmdMoveAndRename]: 'FPMoveAndRename',
  [CmdOpenVol]: 'FPOpenVol',
  [CmdOpenFork]: 'FPOpenFork',
  [CmdRead]: 'FPRead',
  [CmdRename]: 'FPRename',
  [CmdSetDirParms]: 'FPSetDirParms',
  [CmdSetFileParms]: 'FPSetFileParms',
  [CmdSetForkParms]: 'FPSetForkParms',
  [CmdWrite]: 'FPWrite',
  [CmdGetFileDirParms]: 'FPGetFileDirParms',
  [CmdSetFileDirParms]: 'FPSetFileDirParms',
  [CmdGetSrvrMsg]: 'FPGetSrvrMsg',
  [CmdOpenDT]: 'FPOpenDT',
  [CmdCloseDT]: 'FPCloseDT',
  [CmdAddIcon]: 'FPAddIcon',
  [CmdGetIcon]: 'FPGetIcon',
  [CmdGetIconInfo]: 'FPGetIconInfo',
  [CmdAddAPPL]: 'FPAddAPPL',
  [CmdRemoveAPPL]: 'FPRemoveAPPL',
  [CmdGetAPPL]: 'FPGetAPPL',
};

export function afpCmdName(cmd: number): string {
  return AFP_CMD_NAME[cmd] ?? `FP#${cmd}`;
}

/** FPGetSrvrInfo Flags bit 3 — clients honour attentions / fetch FPGetSrvrMsg. */
export const SrvrInfoSupportsSrvrMsg = 0x0008;
export const SrvrMsgTypeLogin = 0;
export const SrvrMsgTypeServer = 1;
export const SrvrMsgBitmapText = 0x0001;
export const MaxSrvrMsgLen = 199;

export const PathTypeLongNames = 2;
export const ForkFlagData = 0x00;
export const ForkFlagResource = 0x80;
export const AccessRead = 0x01;
export const AccessWrite = 0x02;

export const FDBitmapAttributes = 1 << 0;
export const FDBitmapParentDID = 1 << 1;
export const FDBitmapCreateDate = 1 << 2;
export const FDBitmapModDate = 1 << 3;
export const FDBitmapBackupDate = 1 << 4;
export const FDBitmapFinderInfo = 1 << 5;
export const FDBitmapLongName = 1 << 6;
export const FDBitmapShortName = 1 << 7;
export const FileBitmapFileNum = 1 << 8;
export const FileBitmapDataForkLen = 1 << 9;
export const FileBitmapRsrcForkLen = 1 << 10;
export const DirBitmapDirID = 1 << 8;
export const DirBitmapOffspring = 1 << 9;
export const DirBitmapOwnerID = 1 << 10;
export const DirBitmapGroupID = 1 << 11;
export const DirBitmapAccessRights = 1 << 12;

/** Directory access-rights longword (owner==user | UA/OA/GA/EA = RWS). */
export const DirAccessRights = 0x87070707;
export const DirAccessRightsReadOnly = 0x87030303;

export const VolBitmapAttributes = 1 << 0;
export const VolBitmapSignature = 1 << 1;
export const VolBitmapCreateDate = 1 << 2;
export const VolBitmapModDate = 1 << 3;
export const VolBitmapID = 1 << 5;
export const VolBitmapBytesFree = 1 << 6;
export const VolBitmapBytesTotal = 1 << 7;
export const VolBitmapName = 1 << 8;

export const CNIDRoot = 2;
export const AFP_EPOCH_MS = Date.UTC(2000, 0, 1);
/** HFS / MacBinary / StuffIt: seconds since 1904-01-01. */
export const HFS_EPOCH_MS = Date.UTC(1904, 0, 1);
/** Seconds from the HFS epoch to the AFP epoch. */
export const HFS_TO_AFP_SECONDS = (AFP_EPOCH_MS - HFS_EPOCH_MS) / 1000;
export const NoBackupDate = 0x80000000;

export const UAMNoUserAuthent = 'No User Authent';
export const UAMCleartxtPasswrd = 'Cleartxt Passwrd';
export const UAMRandnumExchange = 'Randnum exchange';
export const UAM2WayRandnum = '2-Way Randnum exchange';
export const AFPVersion21 = 'AFPVersion 2.1';

export const NoErr = 0;
export const ErrAccessDenied = -5000;
export const ErrObjectExists = -5017;
export const ErrItemNotFound = -5012;
export const ErrObjectNotFnd = -5018;
export const ErrParamErr = -5019;
export const ErrAuthContinue = -5021;
export const ErrUserNotAuth = -5023;
export const ErrCallNotSuppt = -5024;
export const ErrEOFErr = -5009;
export const ErrDiskFull = -5008;
export const ErrBitmapErr = -5004;

export function afpResultName(result: number): string {
  const s = result | 0;
  switch (s) {
    case NoErr:
      return 'NoErr';
    case ErrAccessDenied:
      return 'AccessDenied';
    case ErrObjectExists:
      return 'ObjectExists';
    case ErrItemNotFound:
      return 'ItemNotFound';
    case ErrObjectNotFnd:
      return 'ObjectNotFound';
    case ErrParamErr:
      return 'ParamErr';
    case ErrAuthContinue:
      return 'AuthContinue';
    case ErrUserNotAuth:
      return 'UserNotAuth';
    case ErrCallNotSuppt:
      return 'CallNotSupported';
    case ErrEOFErr:
      return 'EOFErr';
    case ErrDiskFull:
      return 'DiskFull';
    case ErrBitmapErr:
      return 'BitmapErr';
    default:
      return String(s);
  }
}

export function macTime(d = new Date()): number {
  return Math.floor((d.getTime() - AFP_EPOCH_MS) / 1000) >>> 0;
}

export function fromMacTime(mt: number): Date {
  if (mt === NoBackupDate) return new Date(0);
  return new Date(AFP_EPOCH_MS + ((mt << 0) >> 0) * 1000);
}

/** Convert an HFS/StuffIt/MacBinary timestamp (seconds since 1904) to AFP (seconds since 2000). */
export function hfsTimeToAfp(hfs: number): number {
  if (!hfs) return 0;
  return ((hfs >>> 0) - HFS_TO_AFP_SECONDS) | 0;
}

export function pstring(s: string, macRoman: (s: string) => Uint8Array): Uint8Array {
  const b = macRoman(s);
  if (b.length > 255) throw new Error('pstring too long');
  const out = new Uint8Array(1 + b.length);
  out[0] = b.length;
  out.set(b, 1);
  return out;
}

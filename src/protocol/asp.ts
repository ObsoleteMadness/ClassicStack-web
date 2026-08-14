/** ASP constants and UserData helpers (OmniTalk core/protocol/asp). */

export const SPFuncCloseSess = 1;
export const SPFuncCommand = 2;
export const SPFuncGetStatus = 3;
export const SPFuncOpenSess = 4;
export const SPFuncTickle = 5;
export const SPFuncWrite = 6;
export const SPFuncWriteContinue = 7;
export const SPFuncAttention = 8;

export const Version = 0x0100;
export const TickleIntervalMs = 30_000;
export const SessionTimeoutMs = 120_000;
export const QuantumSize = 578 * 8; // 4624
export const DefaultSLS = 251;
export const ATPMaxData = 578;

export const SPErrorNoError = 0;
export const SPErrorBadVersNum = -1066;
export const SPErrorNoMoreSessions = -1068;
export const SPErrorParamErr = -1070;
export const SPErrorServerBusy = -1071;
export const SPErrorSessClosed = -1072;
export const SPErrorSizeErr = -1073;
export const SPErrorTooManyClients = -1074;

/** Pack ASP UserData: [SPFunc][byte1][hi][lo] as big-endian uint32. */
export function packUserData(spFunc: number, b1: number, word: number): number {
  return ((spFunc & 0xff) << 24) | ((b1 & 0xff) << 16) | (word & 0xffff);
}

export function unpackUserData(ud: number): { spFunc: number; b1: number; word: number } {
  return {
    spFunc: (ud >>> 24) & 0xff,
    b1: (ud >>> 16) & 0xff,
    word: ud & 0xffff,
  };
}

export function packOpenSess(wssSocket: number, version = Version): number {
  return packUserData(SPFuncOpenSess, wssSocket, version);
}

export function packCommand(sessionId: number, seq: number): number {
  return packUserData(SPFuncCommand, sessionId, seq);
}

export function packGetStatus(): number {
  return packUserData(SPFuncGetStatus, 0, 0);
}

export function packTickle(sessionId: number): number {
  return packUserData(SPFuncTickle, sessionId, 0);
}

export function packClose(sessionId: number): number {
  return packUserData(SPFuncCloseSess, sessionId, 0);
}

/** AFP attention flags in the SPAttention word (netatalk AFPATTN_* / OmniTalk AspAttn*). */
export const AttnServerGoingDown = 0x8000;
export const AttnCrash = 0x4000;
export const AttnMsg = 0x2000;
export const AttnNoReconnect = 0x1000;
export const AttnTimeMask = 0x0fff;

export function attnTime(minutes: number): number {
  if (minutes < 0) return 0;
  if (minutes > AttnTimeMask) return AttnTimeMask;
  return minutes & AttnTimeMask;
}

/** Server→workstation SPAttention UserData: [SPFuncAttention][sessionId][code BE16]. */
export function packAttention(sessionId: number, code: number): number {
  return packUserData(SPFuncAttention, sessionId, code & 0xffff);
}

export function packWrite(sessionId: number, seq: number): number {
  return packUserData(SPFuncWrite, sessionId, seq);
}

/** WriteContinue (server→WS): UserData [SPFuncWriteContinue][sess][seq], data = BufferSize BE16. */
export function packWriteContinue(sessionId: number, seq: number): number {
  return packUserData(SPFuncWriteContinue, sessionId, seq);
}

export function writeContinuePayload(bufferSize: number): Uint8Array {
  const out = new Uint8Array(2);
  out[0] = (bufferSize >>> 8) & 0xff;
  out[1] = bufferSize & 0xff;
  return out;
}

/** AFP result is signed int32 in ATP UserData for Command replies. */
export function resultFromUserData(ud: number): number {
  return (ud << 0) >> 0;
}

/** OpenSess reply UserData: [SSS][SessionID][Error BE16]. */
export function packOpenReply(sss: number, sessionId: number, errorCode: number): number {
  return ((sss & 0xff) << 24) | ((sessionId & 0xff) << 16) | (errorCode & 0xffff);
}

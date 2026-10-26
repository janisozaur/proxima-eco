/**
 * Wire protocol for the PROXIMA bram GSM gate.
 *
 * Every constant in this file was measured against a real gate (USBPcap captures of the vendor
 * client's sessions). Values that were *not* observed are marked TODO and left unusable rather
 * than guessed.
 */

// ---------------------------------------------------------------- transport geometry
export const REPORT_LEN = 64; // wMaxPacketSize, both directions, fixed size
export const IMAGE_LEN = 0x20000; // 128 KiB device memory image
export const CHUNK_LEN = 0x38; // 56 data bytes per page
export const WINDOW_START = 0x0001; // 0x83 region table[1]
export const WINDOW_END = 0xd7be; // 0x83 region table[11], exclusive
export const FLUSH_ADDR = 0x20000; // end-of-image marker address
export const LOGIN_MAX_LEN = 8; // TEdit MaxLength in the vendor client's dialog

// ---------------------------------------------------------------- opcodes
export const CMD_STATUS = 0x01;
export const CMD_REGIONS = 0x03;
export const CMD_READ = 0x06; // bulk READ only
export const CMD_LIVE = 0x0c; // [1] subscribe / [0] unsubscribe
export const CMD_LOGIN = 0x0f;
export const CMD_WRITE = 0x86; // bulk WRITE (measured: NOT 0x06)
export const CMD_PUSH = 0x90; // unsolicited live push

/**
 * TODO: the vendor client issues opcode 0x05 with a one-byte payload; neither capture exercised it,
 * so its semantics is unknown. Declared for completeness, never sent by this library.
 */
export const CMD_UNKNOWN = 0x05;

// ---------------------------------------------------------------- frame shape
export interface Frame {
  opcode: number;
  body: Uint8Array; // the 63 bytes after the opcode
  raw: Uint8Array; // the full 64-byte report
}

/**
 * A response is the request opcode with bit 7 set (`0x06` → `0x86`). Unsolicited pushes (`0x90`)
 * are the only frames that do not follow this rule.
 */
export function responseOf(request: number): number {
  return request | 0x80;
}

export function isResponseOf(request: number, response: number): boolean {
  return response === (request | 0x80);
}

/** Encode one report: opcode, then body, zero-padded to the fixed report length. */
export function encodeFrame(opcode: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (opcode < 0 || opcode > 0xff) {
    throw new RangeError(`opcode out of range: 0x${opcode.toString(16)}`);
  }
  if (body.length > REPORT_LEN - 1) {
    throw new RangeError(`body too long: ${body.length} > ${REPORT_LEN - 1}`);
  }
  const out = new Uint8Array(REPORT_LEN);
  out[0] = opcode;
  for (let i = 0; i < body.length; i++) {
    out[1 + i] = body[i];
  }
  return out;
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length !== REPORT_LEN) {
    throw new RangeError(`report must be ${REPORT_LEN} bytes, got ${bytes.length}`);
  }
  return { opcode: bytes[0], body: bytes.subarray(1), raw: bytes };
}

// ---------------------------------------------------------------- 24-bit little-endian addresses
export function put24(target: Uint8Array, at: number, value: number): void {
  if (value < 0 || value > 0xffffff) {
    throw new RangeError(`address out of 24-bit range: 0x${value.toString(16)}`);
  }
  target[at] = value & 0xff;
  target[at + 1] = (value >> 8) & 0xff;
  target[at + 2] = (value >> 16) & 0xff;
}

export function get24(source: Uint8Array, at: number): number {
  return source[at] | (source[at + 1] << 8) | (source[at + 2] << 16);
}

// ---------------------------------------------------------------- memory pages
export interface Page {
  addr: number;
  count: number;
  data: Uint8Array;
}

/**
 * Page body: `[addr LSB, addr mid, addr MSB, count, data…]`.
 * For a write request `data` is the payload; for a read request there is no data.
 */
export function encodePage(addr: number, count: number, data?: Uint8Array): Uint8Array {
  if (count > CHUNK_LEN) {
    throw new RangeError(`page count exceeds the measured maximum: ${count} > ${CHUNK_LEN}`);
  }
  if (data && data.length < count) {
    throw new RangeError(`data shorter than declared count: ${data.length} < ${count}`);
  }
  const out = new Uint8Array(4 + count);
  put24(out, 0, addr);
  out[3] = count;
  if (data) {
    for (let i = 0; i < count; i++) {
      out[4 + i] = data[i];
    }
  }
  return out;
}

export function decodePage(body: Uint8Array): Page {
  const addr = get24(body, 0);
  const count = body[3];
  return { addr, count, data: body.subarray(4, 4 + count) };
}

/**
 * The measured read loop always asks for a full page, including the final one, which overshoots
 * the window end; the write loop clamps the final page to the window.
 */
export function readPlan(start = WINDOW_START, end = WINDOW_END): number[] {
  const addrs: number[] = [];
  for (let addr = start; addr < end; addr += CHUNK_LEN) {
    addrs.push(addr);
  }
  return addrs;
}

export function writeCount(addr: number, end = WINDOW_END): number {
  return Math.min(CHUNK_LEN, end - addr);
}

// ---------------------------------------------------------------- 0x83 region table
/**
 * `0x83` replies with 21 little-endian 24-bit dwords starting at frame byte 1. The table is a
 * static device map (byte-identical across independent captures). Known landmarks, for reference:
 * `[1]` = window start, `[11]` = window end, `[8]` = first subscriber slot, `[9]` = name table,
 * `[16]` = image end.
 */
export const REGION_TABLE_DWORDS = 21;

export function decodeRegions(f: Frame): number[] {
  const out: number[] = [];
  for (let i = 0; i < REGION_TABLE_DWORDS; i++) {
    out.push(get24(f.raw, 1 + 3 * i));
  }
  return out;
}

// ---------------------------------------------------------------- 0x81 status block
export interface Status {
  raw: Uint8Array;
  stateFlag: number; // frame[1]: observed {0, 2}; NOT an authorization indicator
  liveFlag: number; // frame[4]: observed {0x21, 0x25}
  adminPin: string; // frame[9..12] ASCII — same bytes as image[1..4]
  counterA: number; // LE16 at frame[19]
  counterB: number; // LE16 at frame[22]
  fixedField: number; // LE16 at frame[24]
  imageHead: number; // frame[34] — equals image[0], which is never transferred
}

export function decodeStatus(f: Frame): Status {
  const frame = f.raw;
  return {
    raw: frame,
    stateFlag: frame[1],
    liveFlag: frame[4],
    adminPin: ascii(frame, 9, 4),
    counterA: frame[19] | (frame[20] << 8),
    counterB: frame[22] | (frame[23] << 8),
    fixedField: frame[24] | (frame[25] << 8),
    imageHead: frame[34],
  };
}

// ---------------------------------------------------------------- login
/**
 * Passwords travel raw ASCII, NUL-padded, unhashed. The reply's first body byte is the accept
 * flag (0 = rejected, non-zero = accepted) — confirmed by a rejected `9999` and an accepted
 * `4124` on the wire.
 */
export function encodeLoginBody(password: string): Uint8Array {
  const bytes = new Uint8Array(LOGIN_MAX_LEN);
  let n = 0;
  for (const ch of password) {
    const code = ch.charCodeAt(0);
    if (code > 0xff) {
      throw new RangeError(`login password must be 8-bit: ${JSON.stringify(password)}`);
    }
    if (n >= LOGIN_MAX_LEN) {
      throw new RangeError(`login password longer than ${LOGIN_MAX_LEN} characters`);
    }
    bytes[n++] = code;
  }
  return bytes;
}

export function loginAccepted(f: Frame): boolean {
  return f.raw[1] !== 0;
}

// ---------------------------------------------------------------- live feed
/**
 * `0x0C [1]` starts the feed, `0x0C [0]` stops it; both reply `0x8C` all-zero. While subscribed,
 * `0x90` pushes arrive every 2.000 s. The push fields are not yet decoded — TODO.
 */
export function encodeLiveBody(subscribe: boolean): Uint8Array {
  return new Uint8Array([subscribe ? 1 : 0]);
}

/**
 * The `0x90` push layout is not pinned: only "bytes 1,2,3,4,6 vary" was measured. Until it is,
 * callers get the raw body.
 */
export function decodePush(f: Frame): Uint8Array {
  return f.body;
}

// ---------------------------------------------------------------- helpers
/** Copy `src` into `target` at `at`, bounded by both. */
export function copyInto(target: Uint8Array, at: number, src: Uint8Array): void {
  const n = Math.min(src.length, target.length - at);
  for (let i = 0; i < n; i++) {
    target[at + i] = src[i];
  }
}

function ascii(frame: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = at; i < at + len; i++) {
    s += String.fromCharCode(frame[i]);
  }
  return s;
}

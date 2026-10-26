/**
 * Device simulator for tests — a protocol model, not a recording.
 *
 * It implements the measured device-side behaviour: paging with the window clamp, the write
 * acknowledgement, the end-of-image marker, the login accept flag and the live-feed toggle.
 * Nothing here involves vendor data; the image it serves is whatever the test hands it.
 */

import type { Frame, Transport } from '../src/transport.ts';
import {
  CHUNK_LEN,
  CMD_LIVE,
  CMD_LOGIN,
  CMD_READ,
  CMD_STATUS,
  CMD_WRITE,
  CMD_REGIONS,
  FLUSH_ADDR,
  IMAGE_LEN,
  REGION_TABLE_DWORDS,
  REPORT_LEN,
  WINDOW_END,
  WINDOW_START,
  decodeFrame,
  encodeFrame,
  encodePage,
  get24,
  put24,
} from '../src/protocol.ts';

/** The region table as measured on one gate; the sim only needs its window bounds. */
const REGION_TABLE = [
  0x00000, WINDOW_START, 0x0000a, 0x0000e, 0x0000f, 0x00011, 0x00016, 0x0001f,
  0x00407, 0x004e3f, 0x008cbf, WINDOW_END, WINDOW_END + 1, 0x0d8fe, 0x0d8ff, 0x0d9a1,
  IMAGE_LEN - 1, 0x0dce0, 0x0ffff, 0x1d9a0, 0x00000,
];

export class DeviceSim implements Transport {
  private readonly image: Uint8Array;
  private readonly pin: string;
  private readonly password: string;
  private live = false;

  constructor(image: Uint8Array, pin: string, password: string) {
    this.image = image;
    this.pin = pin;
    this.password = password;
  }

  request(opcode: number, body?: Uint8Array): Promise<Frame> {
    return Promise.resolve(this.reply(opcode, body ?? new Uint8Array(0)));
  }

  onPush(): void {}

  close(): void {}

  reply(opcode: number, body: Uint8Array): Frame {
    switch (opcode) {
      case CMD_STATUS:
        return this.frame(CMD_STATUS, this.statusBody());
      case CMD_REGIONS:
        return this.frame(CMD_REGIONS, this.regionBody());
      case CMD_READ:
        return this.frame(CMD_READ, this.readBody(body));
      case CMD_WRITE:
        return this.frame(CMD_WRITE, this.writeBody(body));
      case CMD_LOGIN:
        return this.frame(CMD_LOGIN, this.loginBody(body));
      case CMD_LIVE:
        this.live = body[0] !== 0;
        return this.frame(CMD_LIVE, new Uint8Array(0));
      default:
        throw new Error(`sim: unexpected request opcode 0x${opcode.toString(16)}`);
    }
  }

  /** A report with no body, wrapped as a frame. */
  frame(opcode: number, body: Uint8Array): Frame {
    return decodeFrame(encodeFrame(opcode, body));
  }

  statusBody(): Uint8Array {
    const s = new Uint8Array(REPORT_LEN - 1);
    s[0] = 0; // stateFlag at frame[1]
    s[3] = 0x21; // liveFlag at frame[4]
    for (let i = 0; i < this.pin.length; i++) {
      s[8 + i] = this.pin.charCodeAt(i) & 0xff; // frame[9..12]
    }
    s[18] = 0x8a;
    s[19] = 0x08; // counterA LE16 at frame[19..20]
    s[21] = 0x37;
    s[22] = 0x06; // counterB LE16 at frame[22..23]
    s[23] = 0xc4;
    s[24] = 0x04; // fixedField at frame[24..25]
    s[30] = 0x11; // frame[31]
    s[33] = this.image[0]; // imageHead at frame[34]
    return s;
  }

  regionBody(): Uint8Array {
    const b = new Uint8Array(3 * REGION_TABLE_DWORDS);
    for (let i = 0; i < REGION_TABLE.length; i++) {
      put24(b, 3 * i, REGION_TABLE[i]);
    }
    return b;
  }

  readBody(body: Uint8Array): Uint8Array {
    const addr = get24(body, 0);
    const requested = body[3];
    const count = Math.min(requested, WINDOW_END - addr);
    return encodePage(addr, count, this.image.subarray(addr, addr + count));
  }

  writeBody(body: Uint8Array): Uint8Array {
    const addr = get24(body, 0);
    const count = body[3];
    if (addr === FLUSH_ADDR && count === 0) {
      return encodePage(FLUSH_ADDR, 0); // marker is acknowledged, it writes nothing
    }
    for (let i = 0; i < count; i++) {
      this.image[addr + i] = body[4 + i];
    }
    return encodePage(addr, 0);
  }

  loginBody(body: Uint8Array): Uint8Array {
    let n = 0;
    while (n < body.length && body[n] !== 0) {
      n++;
    }
    let got = '';
    for (let i = 0; i < n; i++) {
      got += String.fromCharCode(body[i]);
    }
    return new Uint8Array([got === this.password ? 1 : 0]);
  }
}

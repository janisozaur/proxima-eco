/**
 * The device-facing session: login, status, region table, bulk read/write with the measured
 * verification step, and the live feed.
 */

import type { Frame, Status } from './protocol.ts';
import type { Transport } from './transport.ts';
import {
  CHUNK_LEN,
  CMD_LIVE,
  CMD_LOGIN,
  CMD_READ,
  CMD_REGIONS,
  CMD_STATUS,
  CMD_WRITE,
  FLUSH_ADDR,
  IMAGE_LEN,
  copyInto,
  decodePage,
  decodeRegions,
  decodeStatus,
  encodeLiveBody,
  encodeLoginBody,
  encodePage,
  isResponseOf,
  loginAccepted,
  readPlan,
  responseOf,
  writeCount,
} from './protocol.ts';

/**
 * The vendor client short-circuits this service password locally: no packet reaches the gate at
 * all (measured — the sessions that used it contain zero login exchanges).
 */
export const SERVICE_PASSWORD = 'SERWIS75';

export class PageRejected extends Error {
  readonly addr: number;
  constructor(addr: number) {
    super();
    this.addr = addr;
    this.message = `page at 0x${addr.toString(16)} was rejected (read-back did not match)`;
  }
}

export class Session {
  private readonly t: Transport;

  constructor(t: Transport) {
    this.t = t;
  }

  /** Returns true when the gate accepts. `SERVICE_PASSWORD` never contacts the gate. */
  async login(password: string): Promise<boolean> {
    if (password === SERVICE_PASSWORD) {
      return true;
    }
    const f = await this.t.request(CMD_LOGIN, encodeLoginBody(password));
    expect(f, CMD_LOGIN);
    return loginAccepted(f);
  }

  async status(): Promise<Status> {
    const f = await this.t.request(CMD_STATUS);
    expect(f, CMD_STATUS);
    return decodeStatus(f);
  }

  async regions(): Promise<number[]> {
    const f = await this.t.request(CMD_REGIONS);
    expect(f, CMD_REGIONS);
    return decodeRegions(f);
  }

  /**
   * Bulk read. The measured loop always requests a full page, so the final page overshoots the
   * window end; the device clamps it and echoes the requested address back.
   */
  async readWindow(): Promise<Uint8Array> {
    const image = new Uint8Array(IMAGE_LEN);
    for (const addr of readPlan()) {
      const f = await this.t.request(CMD_READ, encodePage(addr, CHUNK_LEN));
      expect(f, CMD_READ);
      const p = decodePage(f.body);
      if (p.addr !== addr) {
        throw new Error(
          `read reply echoed 0x${p.addr.toString(16)} for page 0x${addr.toString(16)}`,
        );
      }
      copyInto(image, addr, p.data);
    }
    return image;
  }

  /**
   * Bulk write. Measured order is write page → read-back verify, per page, then the end-of-image
   * marker. A page whose read-back differs was rejected by the firmware.
   */
  async writeWindow(image: Uint8Array): Promise<void> {
    for (const addr of readPlan()) {
      const count = writeCount(addr);
      const data = image.subarray(addr, addr + count);

      const w = await this.t.request(CMD_WRITE, encodePage(addr, count, data));
      expect(w, CMD_WRITE);

      const r = await this.t.request(CMD_READ, encodePage(addr, count));
      expect(r, CMD_READ);
      const p = decodePage(r.body);
      for (let i = 0; i < count; i++) {
        if (p.data[i] !== data[i]) {
          throw new PageRejected(addr);
        }
      }
    }

    const marker = await this.t.request(CMD_WRITE, encodePage(FLUSH_ADDR, 0));
    expect(marker, CMD_WRITE);
  }

  async subscribeLive(handler: (frame: Frame) => void): Promise<void> {
    this.t.onPush({ handle: handler });
    const f = await this.t.request(CMD_LIVE, encodeLiveBody(true));
    expect(f, CMD_LIVE);
  }

  async unsubscribeLive(): Promise<void> {
    const f = await this.t.request(CMD_LIVE, encodeLiveBody(false));
    expect(f, CMD_LIVE);
  }
}

function expect(f: Frame, request: number): void {
  if (!isResponseOf(request, f.opcode)) {
    throw new Error(
      `expected response 0x${responseOf(request).toString(16)}, got 0x${f.opcode.toString(16)}`,
    );
  }
}

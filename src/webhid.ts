/**
 * WebHID transport (Chrome/Edge).
 *
 * The gate uses fixed 64-byte reports with **no report-ID prefix**, so `send(0, bytes)` is correct:
 * reportId `0` means "no ID byte", and the opcode is byte 0 of the report itself.
 *
 * `requestDevice` filters by VID/PID, which is **not recoverable from the captures** (no
 * `GET_DEVICE_DESCRIPTOR` was ever issued). Until the pair is pinned, we request with an empty
 * filter and disambiguate by the measured `maxMessageSize === 64`.
 */

import type { Frame } from './protocol.ts';
import type { HidApi, HidDevice, HidFilter, HidCollection, HidDeviceInfo, NavigatorWithHid } from '../types/webhid.ts';
import type { PushHandler, Transport } from './transport.ts';
import { CMD_PUSH, REPORT_LEN, decodeFrame, encodeFrame, isResponseOf } from './protocol.ts';

/** A report carries no report-ID byte, so the ID passed to `send` is always 0. */
const NO_REPORT_ID = 0;

export class WebHidTransport implements Transport {
  private readonly device: HidDevice;
  private readonly handlers: PushHandler[] = [];

  constructor(device: HidDevice) {
    this.device = device;
  }

  request(opcode: number, body?: Uint8Array): Promise<Frame> {
    return this.exchange(opcode, body ?? new Uint8Array(0));
  }

  private async exchange(opcode: number, body: Uint8Array): Promise<Frame> {
    this.device.send(NO_REPORT_ID, encodeFrame(opcode, body));
    for (;;) {
      const f = decodeFrame(await this.device.receive());
      if (f.opcode === CMD_PUSH) {
        for (const h of this.handlers) {
          h.handle(f);
        }
        continue; // a push is not the reply; keep waiting
      }
      if (!isResponseOf(opcode, f.opcode)) {
        throw new Error(
          `unexpected response 0x${f.opcode.toString(16)} for 0x${opcode.toString(16)}`,
        );
      }
      return f;
    }
  }

  onPush(handler: PushHandler): void {
    this.handlers.push(handler);
  }

  /** Which device this transport is open on, so the app can show its VID:PID. */
  get identity(): HidIdentity {
    return {
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      maxMessageSize: this.device.maxMessageSize,
      maxReportsCount: this.device.maxReportsCount,
    };
  }

  close(): void {
    this.device.close();
  }
}

/** What the browser reports about one HID device — enough to pin it without a capture. */
export interface HidIdentity {
  vendorId: number;
  productId: number;
  maxMessageSize: number; // the gate's is 64, which is how it is recognised
  maxReportsCount: number;
}

export interface ConnectOptions {
  /** Empty filter means "any device"; pin the real pair once discovered. */
  filters?: HidFilter[];
}

/**
 * TODO: pin the gate's `vendorId`/`productId` here after one successful discovery run, so the
 * browser prompt shows exactly one device.
 *
 * Chrome rejects a filter that carries no property (`[{}]` throws "A filter must provide a
 * property to filter by"), and `interface` alone is not accepted. An **empty list** is the valid
 * "match everything" form, which is what the code below passes until this array is filled in.
 */
export const PINNED_FILTERS: HidFilter[] = [];

export async function connectWebHid(options: ConnectOptions = {}): Promise<WebHidTransport> {
  const hid: HidApi | undefined = (navigator as NavigatorWithHid).hid;
  if (hid === undefined) {
    throw new Error('WebHID is not available in this browser');
  }
  const filters = options.filters ?? PINNED_FILTERS;
  const devices = await hid.requestDevice({ filters });
  if (devices.length === 0) {
    throw new Error('no HID device matched');
  }
  // The gate is the HID-class device with 64-byte fixed reports.
  const gate = devices.find((d) => d.maxMessageSize === REPORT_LEN) ?? devices[0];
  return new WebHidTransport(gate);
}

/** Discovery helper: reports what the browser sees, so VID:PID can be pinned. */
export async function describeDevices(): Promise<HidIdentity[]> {
  const hid: HidApi | undefined = (navigator as NavigatorWithHid).hid;
  if (hid === undefined) {
    return [];
  }
  const devices = await hid.requestDevice({ filters: [] });
  return devices.map((d) => ({
    vendorId: d.vendorId,
    productId: d.productId,
    maxMessageSize: d.maxMessageSize,
    maxReportsCount: d.maxReportsCount,
  }));
}

/** One device as the app prints it: hex to transcribe, decimal to match the browser's prompt. */
export function formatIdentity(d: HidIdentity): string {
  return `VID 0x${hex4(d.vendorId)} (${d.vendorId}) · PID 0x${hex4(d.productId)} (${d.productId}) · ${d.maxMessageSize}-byte reports`;
}

/** The same device as the literal that pins it into PINNED_FILTERS, ready to copy out. */
export function filterLiteral(d: HidIdentity): string {
  return `{ vendorId: 0x${hex4(d.vendorId)}, productId: 0x${hex4(d.productId)} }`;
}

/** Four hex digits, capitalised: how a HID descriptor writes an ID. */
function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

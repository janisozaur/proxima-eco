/**
 * The session driven against the protocol simulator: login outcomes, the status block, the region
 * table, a full bulk read, a full bulk write with its per-page verification, and detection of a
 * device that corrupts one page.
 */

import { ok } from 'node:assert';

function eq(actual: unknown, expected: unknown): void {
  const same =
    actual === expected ||
    (typeof actual === 'object' && typeof expected === 'object' &&
      JSON.stringify(actual) === JSON.stringify(expected));
  ok(same, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
import { Session, PageRejected, SERVICE_PASSWORD } from '../src/session.ts';
import { DeviceSim } from './device-sim.ts';
import {
  WINDOW_END,
  WINDOW_START,
  get24,
  IMAGE_LEN,
} from '../src/protocol.ts';

function syntheticImage(): Uint8Array {
  const img = new Uint8Array(IMAGE_LEN);
  for (let i = 0; i < IMAGE_LEN; i++) {
    img[i] = (i * 13 + 5) & 0xff;
  }
  return img;
}

const image = syntheticImage();
const sim = new DeviceSim(image, '1234', '4124');
const s = new Session(sim);

// ---- login: accept, reject, and the local service bypass ----
eq(await s.login('4124'), true);
eq(await s.login('9999'), false);
eq(await s.login(SERVICE_PASSWORD), true);

// ---- status block ----
{
  const st = await s.status();
  eq(st.adminPin, '1234');
  eq(st.imageHead, image[0]);
}

// ---- region table drives the window ----
{
  const regions = await s.regions();
  eq(regions[1], WINDOW_START);
  eq(regions[11], WINDOW_END);
}

// ---- bulk read reproduces the device image across the whole window ----
{
  const got = await s.readWindow();
  let same = true;
  for (let i = WINDOW_START; i < WINDOW_END; i++) {
    if (got[i] !== image[i]) {
      same = false;
      break;
    }
  }
  eq(same, true);
}

// ---- bulk write of what we just read: the sim applies it, verification passes ----
await s.writeWindow(image);

// ---- a device that corrupts one page must be caught by the read-back verify ----
{
  class Corruptor extends DeviceSim {
    readBody(body: Uint8Array): Uint8Array {
      const out = super.readBody(body);
      if (get24(body, 0) === 0x39) {
        out[4] ^= 0xff; // flip the first data byte of that page
      }
      return out;
    }
  }

  const bad = new Corruptor(syntheticImage(), '1234', '4124');
  const s2 = new Session(bad);
  let caught: number | null = null;
  try {
    await s2.writeWindow(image);
  } catch (e) {
    ok(e instanceof PageRejected);
    caught = (e as PageRejected).addr;
  }
  eq(caught, 0x39);
}

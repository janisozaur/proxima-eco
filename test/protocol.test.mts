/**
 * Protocol primitives, checked against the measured constants.
 */

import { ok } from 'node:assert';

/** `node:assert`'s `eq` is not a named export in the typings; `ok` is. */
function eq(actual: unknown, expected: unknown): void {
  const same =
    actual === expected ||
    (typeof actual === 'object' && typeof expected === 'object' &&
      JSON.stringify(actual) === JSON.stringify(expected));
  ok(same, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
import {
  CHUNK_LEN,
  CMD_LOGIN,
  CMD_READ,
  FLUSH_ADDR,
  REPORT_LEN,
  WINDOW_END,
  WINDOW_START,
  decodeFrame,
  decodePage,
  decodeRegions,
  decodeStatus,
  encodeFrame,
  encodeLoginBody,
  encodePage,
  isResponseOf,
  loginAccepted,
  readPlan,
  responseOf,
  writeCount,
} from '../src/protocol.ts';

// ---- frame shape: fixed 64 bytes, opcode first, no report-ID prefix ----
{
  const report = encodeFrame(CMD_READ, encodePage(0x00d7b1, 13));
  eq(report.length, REPORT_LEN);
  eq(report[0], CMD_READ);
  const f = decodeFrame(report);
  eq(f.opcode, CMD_READ);
  eq(f.body.length, REPORT_LEN - 1);
  const p = decodePage(f.body);
  eq(p.addr, 0x00d7b1);
  eq(p.count, 13);
}

// ---- response opcode rule ----
ok(isResponseOf(CMD_READ, responseOf(CMD_READ)));
eq(responseOf(CMD_LOGIN), 0x8f);

// ---- the measured transfer window and paging arithmetic ----
{
  const plan = readPlan();
  eq(plan.length, 987); // measured page count for the whole window
  eq(plan[0], WINDOW_START);
  eq(plan[plan.length - 1], 0x00d7b1);
  eq(writeCount(plan[plan.length - 1]), 13); // final write page is clamped
  eq(writeCount(plan[0]), CHUNK_LEN);
  // reads are never clamped by the client — they ask for a full page and overshoot
  eq(WINDOW_START + 987 * CHUNK_LEN > WINDOW_END, true);
}

// ---- login encoding: raw ASCII, NUL-padded, unhashed ----
{
  const body = encodeLoginBody('4124');
  eq([...body.slice(0, 4)], [0x34, 0x31, 0x32, 0x34]);
  eq(body.length, 8);
  eq(body[4], 0);
}

// ---- accept flag ----
{
  const accept = decodeFrame(encodeFrame(0x8f, new Uint8Array([1])));
  ok(loginAccepted(accept));
  const reject = decodeFrame(encodeFrame(0x8f, new Uint8Array([0])));
  ok(!loginAccepted(reject));
}

// ---- the end-of-image marker is an address, not a payload ----
{
  const marker = encodePage(FLUSH_ADDR, 0);
  eq([...marker], [0x00, 0x00, 0x02, 0x00]);
}

// ---- region table decode (21 little-endian 24-bit dwords) ----
{
  const raw = new Uint8Array(REPORT_LEN);
  raw[0] = 0x83;
  const table = [
    0x00000, 0x00001, 0x0000a, 0x0000e, 0x0000f, 0x00011, 0x00016, 0x0001f,
    0x00407, 0x004e3f, 0x008cbf, 0x0d7be, 0x0d7bf, 0x0d8fe, 0x0d8ff, 0x0d9a1,
    0x1ffff, 0x0dce0, 0x0ffff, 0x1d9a0, 0x00000,
  ];
  for (let i = 0; i < table.length; i++) {
    raw[1 + 3 * i] = table[i] & 0xff;
    raw[2 + 3 * i] = (table[i] >> 8) & 0xff;
    raw[3 + 3 * i] = (table[i] >> 16) & 0xff;
  }
  const f = decodeFrame(raw);
  const got = decodeRegions(f);
  eq(got.length, 21);
  eq(got[1], WINDOW_START);
  eq(got[11], WINDOW_END);
  eq(got[16], 0x1ffff);
}

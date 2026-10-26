/**
 * The subscriber table and the admin PINs, against a **synthetic** image — no vendor data
 * involved. The point is the layout arithmetic: slots are 19 bytes at 0x400 with the phone string
 * at offset 7, names are 16-byte records at 0x4E3F, and 1000 slots fit exactly.
 */

import { ok } from 'node:assert';

function eq(actual: unknown, expected: unknown): void {
  ok(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
import { ABONENT_BASE, ABONENT_SLOT, ABONENT_PHONE_AT, NAME_BASE, NAME_SLOT, readAbonents, readAdminInfo, countAbonents } from '../src/abonents.ts';
import { IMAGE_LEN } from '../src/protocol.ts';

// ---- the arithmetic the layout claims is exact ----
eq(ABONENT_BASE + ABONENT_SLOT * 1000, 0x4e38);
eq(ABONENT_PHONE_AT + (ABONENT_SLOT - ABONENT_PHONE_AT), ABONENT_SLOT);

function put(bytes: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    bytes[at + i] = text.charCodeAt(i);
  }
}

{
  const image = new Uint8Array(IMAGE_LEN);

  // config head: capacity marker, PIN, then the PC and SMS passwords
  image[0] = 0x07;
  put(image, 1, '1234');
  put(image, 0x11, '4124');
  put(image, 0x16, '5555');

  // two subscribers, slots 0 and 2 (slot 1 deliberately left empty)
  put(image, ABONENT_BASE + 0 * ABONENT_SLOT + ABONENT_PHONE_AT, '+48000000001');
  put(image, ABONENT_BASE + 2 * ABONENT_SLOT + ABONENT_PHONE_AT, '+48000000002');
  put(image, NAME_BASE + 0 * NAME_SLOT, 'Zero');
  put(image, NAME_BASE + 2 * NAME_SLOT, 'Two');

  const rows = readAbonents(image);
  eq(rows.length, 2);
  eq(rows[0].poz, 1);
  eq(rows[0].phone, '+48000000001');
  eq(rows[0].name, 'Zero');
  eq(rows[1].poz, 3);
  eq(rows[1].phone, '+48000000002');
  eq(rows[1].name, 'Two');

  eq(countAbonents(image), 2);

  const admin = readAdminInfo(image);
  eq(admin.devicePin, '1234');
  eq(admin.pcPassword, '4124');
  eq(admin.smsPassword, '5555');
}

// ---- an all-zero image has no subscribers ----
{
  const empty = new Uint8Array(IMAGE_LEN);
  eq(countAbonents(empty), 0);
  eq(readAbonents(empty).length, 0);
}

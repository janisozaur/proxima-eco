/**
 * The subscriber tables and the admin PINs, against a **synthetic** image — no vendor data
 * involved. The point is the layout arithmetic: the flag array is 1000 bytes at 0x1F, the phone
 * slots are 19 bytes at 0x407 (a `string[18]` payload, length byte dropped), the name slots are
 * 16 bytes at 0x4E3F, and the three arrays are exactly contiguous.
 */

import { ok } from 'node:assert';

function eq(actual: unknown, expected: unknown): void {
  ok(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
import {
  FLAG_BASE,
  ABONENT_SLOTS,
  PHONE_BASE,
  PHONE_SLOT,
  PHONE_MAX,
  NAME_BASE,
  NAME_SLOT,
  NAME_MAX,
  WYJ1_BIT,
  WYJ2_BIT,
  GROUP_COUNT_AT,
  TOTAL_COUNT_AT,
  readAbonents,
  readAdminInfo,
  readSplit,
  countAbonents,
  writeAbonentPhone,
  writeAbonentName,
  setAbonentOutput,
} from '../src/abonents.ts';
import { IMAGE_LEN } from '../src/protocol.ts';

// ---- the arithmetic the layout claims is exact ----
eq(FLAG_BASE + ABONENT_SLOTS, PHONE_BASE);
eq(PHONE_BASE + PHONE_SLOT * ABONENT_SLOTS, NAME_BASE);
eq(NAME_BASE + NAME_SLOT * ABONENT_SLOTS, 0x8cbf);
eq(PHONE_MAX + 1, PHONE_SLOT);
eq(NAME_MAX + 1, NAME_SLOT);

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

  // three subscribers: slots 0 and 2 (slot 1 deliberately empty), flags 3 / 1 / 2
  put(image, PHONE_BASE + 0 * PHONE_SLOT, '+48000000001');
  put(image, PHONE_BASE + 2 * PHONE_SLOT, '+48000000002');
  put(image, PHONE_BASE + 3 * PHONE_SLOT, '+48000000003');
  put(image, NAME_BASE + 0 * NAME_SLOT, 'Zero');
  put(image, NAME_BASE + 2 * NAME_SLOT, 'Two');
  image[FLAG_BASE + 0] = WYJ1_BIT | WYJ2_BIT; // both outputs
  image[FLAG_BASE + 2] = WYJ1_BIT; // output 2 off
  image[FLAG_BASE + 3] = WYJ2_BIT; // output 1 off

  const rows = readAbonents(image);
  eq(rows.length, 3);
  eq(rows[0].poz, 1);
  eq(rows[0].phone, '+48000000001');
  eq(rows[0].name, 'Zero');
  eq(rows[0].wyj1, true);
  eq(rows[0].wyj2, true);
  eq(rows[1].poz, 3);
  eq(rows[1].phone, '+48000000002');
  eq(rows[1].name, 'Two');
  eq(rows[1].wyj1, true);
  eq(rows[1].wyj2, false);
  eq(rows[2].poz, 4);
  eq(rows[2].phone, '+48000000003');
  eq(rows[2].wyj2, true);

  // the padding after a phone is zero, never a per-record prefix
  eq(image[PHONE_BASE + 0 * PHONE_SLOT + 11], 0x31);
  eq(image[PHONE_BASE + 0 * PHONE_SLOT + 12], 0x00);

  eq(countAbonents(image), 3);

  const admin = readAdminInfo(image);
  eq(admin.devicePin, '1234');
  eq(admin.pcPassword, '4124');
  eq(admin.smsPassword, '5555');
}

// ---- the last flag byte sits immediately before the first phone ----
{
  const image = new Uint8Array(IMAGE_LEN);
  image[PHONE_BASE - 1] = WYJ1_BIT | WYJ2_BIT; // abonent 1000
  eq(readAbonents(image).length, 0);
  eq(image[FLAG_BASE + ABONENT_SLOTS - 1], 0x03);
}

// ---- an all-zero image has no subscribers ----
{
  const empty = new Uint8Array(IMAGE_LEN);
  eq(countAbonents(empty), 0);
  eq(readAbonents(empty).length, 0);
}

// ---- the users/admin split the config head keeps, and editing a slot in place ----
{
  const image = new Uint8Array(IMAGE_LEN);
  image[0] = 0x07;
  image[GROUP_COUNT_AT] = 2; // users: slots 1..2
  image[TOTAL_COUNT_AT] = 4; // total entries, little-endian
  image[TOTAL_COUNT_AT + 1] = 0;

  for (const k of [0, 1, 2, 3]) {
    writeAbonentPhone(image, k + 1, `+480000000${k + 1}`);
    writeAbonentName(image, k + 1, `n${k + 1}`);
    image[FLAG_BASE + k] = WYJ1_BIT | WYJ2_BIT;
  }

  const split = readSplit(image);
  eq(split.users, 2);
  eq(split.total, 4);

  const rows = readAbonents(image);
  eq(rows.length, 4);
  eq(rows[1].admin, false);
  eq(rows[2].admin, true); // the split point itself is already an administrator

  // an edit is just rewriting the slot: the image is the storage
  writeAbonentPhone(image, 3, '+48999999999');
  writeAbonentName(image, 3, 'Zb');
  setAbonentOutput(image, 3, WYJ1_BIT, false);
  setAbonentOutput(image, 1, WYJ2_BIT, true);
  eq(image[FLAG_BASE + 2], WYJ2_BIT);
  eq(image[FLAG_BASE + 0], WYJ1_BIT | WYJ2_BIT);

  const after = readAbonents(image);
  eq(after[2].poz, 3);
  eq(after[2].phone, '+48999999999');
  eq(after[2].name, 'Zb');
  eq(after[2].wyj1, false);
  eq(after[2].wyj2, true);
  eq(countAbonents(image), 4);
}

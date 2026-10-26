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

/** The phone/name slot as text — these tests only ever hold ASCII, so no CP-1250 table needed. */
function slotText(image: Uint8Array, base: number, slot: number, poz: number): string {
  let out = '';
  for (let i = 0; i < slot; i++) {
    const byte = image[base + (poz - 1) * slot + i];
    if (byte === 0) {
      break;
    }
    out += String.fromCharCode(byte);
  }
  return out;
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
  ADMIN_SLOTS,
  TOTAL_COUNT_AT,
  ADMIN_FIELDS,
  readAbonents,
  readAdminInfo,
  readTotal,
  countGroups,
  countAbonents,
  writeAbonentPhone,
  writeAbonentName,
  setAbonentOutput,
  clearAbonent,
  nextFreeSlot,
  lastOccupied,
  writeTotal,
  countGaps,
  compactAbonents,
  OUT1_AT,
  OUT2_AT,
  OUT_TENTHS_MAX,
  outTenths,
  outBistabilny,
  writeOut,
  CLIP_AT,
  CLIP_ROWS,
  CLIP_ROW,
  CLIP_TEXT_AT,
  CLIP_TEXT_LEN,
  readClipRows,
  clipTextAt,
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

// ---- the admin fields tab 2 edits, and the capacities the packer gives them ----
{
  const image = new Uint8Array(IMAGE_LEN);
  image[0] = 0x07; // the head marker above the PIN, which an edit must never reach
  const values = ['1234', '4124', '555555555'];
  for (let i = 0; i < ADMIN_FIELDS.length; i++) {
    const f = ADMIN_FIELDS[i];
    for (let j = 0; j < f.limit; j++) {
      image[f.at + j] = j < values[i].length ? values[i].charCodeAt(j) : 0;
    }
    eq(slotText(image, f.at, f.limit, 1), values[i]);
  }
  // each capacity stops exactly where the next field begins, so an edit cannot spill sideways
  eq(ADMIN_FIELDS[0].at + ADMIN_FIELDS[0].limit, 5);
  eq(ADMIN_FIELDS[1].at + ADMIN_FIELDS[1].limit, ADMIN_FIELDS[2].at);
  eq(ADMIN_FIELDS[2].at + ADMIN_FIELDS[2].limit, FLAG_BASE);
  eq(image[0], 0x07); // the PIN's 4 bytes stop at 0x0004
  eq(image[FLAG_BASE], 0); // the SMS password's 9 bytes stop at 0x001E
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

// ---- the two fixed regions: 16 administratorzy slots, then uŁytkownicy ----
{
  const image = new Uint8Array(IMAGE_LEN);
  image[0] = 0x07;
  image[TOTAL_COUNT_AT] = 18; // entry bound, little-endian
  image[TOTAL_COUNT_AT + 1] = 0;

  // administrators occupy the first region, with holes: slots 1, 2 and 4 (slot 3 unpopulated)
  for (const k of [0, 1, 3]) {
    writeAbonentPhone(image, k + 1, `+480000000${k + 1}`);
    writeAbonentName(image, k + 1, `adm ${k + 1}`);
    image[FLAG_BASE + k] = WYJ1_BIT | WYJ2_BIT;
  }
  // the first occupied slot of the second region sits right after the 16 admin slots
  writeAbonentPhone(image, ADMIN_SLOTS + 1, '+48999999999');
  writeAbonentName(image, ADMIN_SLOTS + 1, 'krzysiek');
  writeAbonentPhone(image, ADMIN_SLOTS + 2, '+48888888888');

  const counts = countGroups(image);
  eq(counts.admins, 3); // three of the sixteen admin slots are populated
  eq(counts.users, 2);

  const rows = readAbonents(image);
  eq(rows.length, 5);
  eq(rows[0].admin, true);
  eq(rows[2].admin, true); // slot 4 is still an administrator
  eq(rows[3].poz, ADMIN_SLOTS + 1); // the first user slot
  eq(rows[3].admin, false);
  eq(rows[3].name, 'krzysiek'); // a named entry beyond 16 is a user, not an admin
  eq(readTotal(image), 18);

  // an edit is just rewriting the slot: the image is the storage
  writeAbonentPhone(image, 4, '+48777777777');
  writeAbonentName(image, 4, 'Zb');
  setAbonentOutput(image, 4, WYJ1_BIT, false);
  setAbonentOutput(image, 1, WYJ2_BIT, true);
  eq(image[FLAG_BASE + 3], WYJ2_BIT);
  eq(image[FLAG_BASE + 0], WYJ1_BIT | WYJ2_BIT);

  const after = readAbonents(image);
  eq(after[2].poz, 4);
  eq(after[2].phone, '+48777777777');
  eq(after[2].name, 'Zb');
  eq(after[2].wyj1, false);
  eq(after[2].wyj2, true);
  eq(after[2].admin, true);
  eq(countAbonents(image), 5);
}

// ---- adding and removing entries, and the entry bound that goes with them ----
{
  const image = new Uint8Array(IMAGE_LEN);
  writeTotal(image, 3);
  for (const k of [1, 2, 3]) {
    writeAbonentPhone(image, k, `+48000000${k}0`);
    writeAbonentName(image, k, `n${k}`);
    image[FLAG_BASE + k - 1] = WYJ1_BIT | WYJ2_BIT;
  }
  eq(readTotal(image), 3);
  eq(lastOccupied(image), 3);

  // the vendor's add button appends at the bound, so the bound moves first
  writeTotal(image, readTotal(image) + 1);
  writeAbonentPhone(image, readTotal(image), '+48666000004');
  eq(lastOccupied(image), 4);
  eq(countAbonents(image), 4);

  // removing clears the phone, the name and the flag byte in one go
  clearAbonent(image, 2);
  eq(image[PHONE_BASE + 1 * PHONE_SLOT], 0);
  eq(image[NAME_BASE + 1 * NAME_SLOT], 0);
  eq(image[FLAG_BASE + 1], 0);
  eq(countAbonents(image), 3);
  eq(nextFreeSlot(image, 1, ADMIN_SLOTS), 2); // the hole is reusable

  // clearing a middle entry leaves the bound alone; clearing the last one shrinks it
  clearAbonent(image, 3);
  eq(readTotal(image), 4);
  clearAbonent(image, 4);
  writeTotal(image, lastOccupied(image));
  eq(readTotal(image), 1);
  eq(countAbonents(image), 1);
}

// ---- the gaps inside the users region, and closing them ----
{
  const image = new Uint8Array(IMAGE_LEN);
  writeTotal(image, 20);
  for (const k of [1, 3]) {
    writeAbonentPhone(image, k, `+48000000${k}0`);
    image[FLAG_BASE + k - 1] = WYJ1_BIT;
  }
  for (const k of [17, 19, 20]) {
    writeAbonentPhone(image, k, `+4870000${k}0`);
    writeAbonentName(image, k, `u${k}`);
    image[FLAG_BASE + k - 1] = WYJ1_BIT | WYJ2_BIT;
  }
  eq(countGaps(image), 1); // slot 18 is blank inside the bound

  const closed = compactAbonents(image);
  eq(closed, 1);
  eq(readTotal(image), 19); // 16 admin slots plus the three users, dense
  eq(countGaps(image), 0);

  // the order is kept, and the administratorzy region is left where it was
  eq(slotText(image, PHONE_BASE, PHONE_SLOT, 17), '+4870000170');
  eq(slotText(image, PHONE_BASE, PHONE_SLOT, 18), '+4870000190');
  eq(slotText(image, PHONE_BASE, PHONE_SLOT, 19), '+4870000200');
  eq(slotText(image, NAME_BASE, NAME_SLOT, 19), 'u20');
  eq(image[FLAG_BASE + 18], WYJ1_BIT | WYJ2_BIT);
  eq(image[PHONE_BASE + 2 * PHONE_SLOT] !== 0, true); // admin slot 3 did not move
  eq(image[PHONE_BASE + 3 * PHONE_SLOT], 0); // admin slot 4 is still a hole
}

// ---- the two output words in the config head: time in tenths, bit 15 = bistabilny ----
{
  const image = new Uint8Array(IMAGE_LEN);
  writeOut(image, 1, 50, false); // what both dumps hold: 5.0 s, monostabilny
  writeOut(image, 2, 50, false);
  eq(outTenths(image, 1), 50);
  eq(outBistabilny(image, 1), false);
  eq(image[OUT1_AT], 50);
  eq(image[OUT1_AT + 1], 0);

  writeOut(image, 1, OUT_TENTHS_MAX + 500, true); // over the client's clamp, mode flipped
  eq(outTenths(image, 1), OUT_TENTHS_MAX);
  eq(outBistabilny(image, 1), true);
  eq(image[OUT1_AT], 0xff);
  eq(image[OUT1_AT + 1], 0xff); // 0x7fff | 0x8000

  writeOut(image, 1, 5, true);
  eq(outTenths(image, 1), 5);
  eq(outBistabilny(image, 1), true);
  eq(image[OUT1_AT], 5);
  eq(image[OUT1_AT + 1], 0x80);

  // the two outputs are separate words, so editing one cannot reach the other
  eq(outTenths(image, 2), 50);
  eq(outBistabilny(image, 2), false);
  eq(OUT2_AT - OUT1_AT, 2);
}

// ---- the reaction rows at 0x8CBF, and which of them are used ----
{
  const image = new Uint8Array(IMAGE_LEN);
  const at = CLIP_AT;
  image[at] = 0x13; // u16 @+0 = 19
  image[at + 2] = 6; // u8 @+2
  image[at + 3] = 1; // u16 @+3 = 1, so the row is used
  const test = [0x54, 0x45, 0x53, 0x54]; // "TEST"
  for (let i = 0; i < test.length; i++) {
    image[at + CLIP_TEXT_AT + i] = test[i];
  }
  const rows = readClipRows(image);
  eq(rows.length, 1);
  eq(rows[0].poz, 1);
  eq(rows[0].a, 19);
  eq(rows[0].b, 6);
  eq(rows[0].group, 1);
  eq(rows[0].text, 'TEST');
  eq(clipTextAt(1), CLIP_AT + CLIP_TEXT_AT);
  eq(clipTextAt(CLIP_ROWS), CLIP_AT + (CLIP_ROWS - 1) * CLIP_ROW + CLIP_TEXT_AT);

  // an all-0xFF row is not used: its group is 0xFFFF, which the loader skips
  const erased = new Uint8Array(IMAGE_LEN).fill(0xff);
  eq(readClipRows(erased).length, 0);
  // neither is a zero-filled row: its group is 0
  image[at + 3] = 0;
  image[at + 4] = 0;
  eq(readClipRows(image).length, 0);
  eq(CLIP_TEXT_LEN, 59);
}

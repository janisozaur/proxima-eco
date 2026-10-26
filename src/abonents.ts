/**
 * The subscriber ("abonenci") tables inside the device image.
 *
 * The three per-subscriber arrays are exactly contiguous, which is what pins their bounds:
 * `0x1F + 1000 = 0x407`, `0x407 + 19·1000 = 0x4E3F`, `0x4E3F + 16·1000 = 0x8CBF`. Each array
 * holds the payload of a Delphi short string **without** its length byte, zero-padded to the
 * slot size — so a 12-char phone sits in a 19-byte slot and the 7 bytes that follow it are
 * padding, not a per-record prefix. The bytes that merely *look* like a header in front of the
 * first phone (`0x400–0x406`) are the flags of abonents 994–1000.
 */

import { decodeCp1250, encodeCp1250 } from './cp1250.ts';

export const FLAG_BASE = 0x001f; // one byte per subscriber
export const ABONENT_SLOTS = 1000;
export const PHONE_BASE = 0x0407;
export const PHONE_SLOT = 19; // string[18] payload, length byte dropped
export const PHONE_MAX = 18;
export const NAME_BASE = 0x4e3f;
export const NAME_SLOT = 16; // string[15] payload, length byte dropped
export const NAME_MAX = 15;

/** Bit 0 = "Wyjście 1", bit 1 = "Wyjście 2"; the vendor default arms both (0x03). */
export const WYJ1_BIT = 0x01;
export const WYJ2_BIT = 0x02;

/**
 * The phone book is **two fixed regions**, not one list split by a stored count: slots `1..16` are
 * the `administratorzy` grid — always 16 slots, some of them unpopulated — and slots `17..1000` are
 * the `uŁytkownicy` grid. Both dumps agree: the occupied slots inside `1..16` are exactly the
 * entries the vendor lists as administrators (`1,2,3` in one dump, `1,2,3,5` in the other), and the
 * first occupied slot from 17 on is `17` in both. The head's `0x000F` word is the total entry
 * bound (`length(abonents)`, written by the packer and read back by the unpacker); the byte at
 * `0x000E` is a `TListView` item count the packer also stores, and it is **not** the split — it is
 * `100` in both dumps while the admin region is 16 slots.
 */
export const ADMIN_SLOTS = 16; // fixed administratorzy region, slots 1..16
export const TOTAL_COUNT_AT = 0x000f; // 16-bit little-endian

/** The total entry bound the config head keeps at `0x000F`. */
export function readTotal(image: Uint8Array): number {
  return image[TOTAL_COUNT_AT] | (image[TOTAL_COUNT_AT + 1] << 8);
}

/** How many slots in each region actually hold an entry. */
export interface Counts {
  admins: number; // occupied slots in 1..ADMIN_SLOTS
  users: number; // occupied slots in ADMIN_SLOTS+1..ABONENT_SLOTS
}

export function countGroups(image: Uint8Array): Counts {
  let admins = 0;
  let users = 0;
  for (let k = 0; k < ABONENT_SLOTS; k++) {
    if (image[PHONE_BASE + k * PHONE_SLOT] === 0) {
      continue;
    }
    if (k < ADMIN_SLOTS) {
      admins += 1;
    } else {
      users += 1;
    }
  }
  return {admins, users};
}

export interface Abonent {
  poz: number; // 1-based, as the vendor UI numbers them
  phone: string;
  name: string;
  wyj1: boolean;
  wyj2: boolean;
  admin: boolean; // one of the 16 administratorzy slots
}

/** Occupied slots only — an empty slot has no phone string. */
export function readAbonents(image: Uint8Array): Abonent[] {
  const out: Abonent[] = [];
  for (let k = 0; k < ABONENT_SLOTS; k++) {
    const phone = decodeCp1250(image, PHONE_BASE + k * PHONE_SLOT, PHONE_MAX);
    if (phone === '') {
      continue;
    }
    const flag = image[FLAG_BASE + k];
    out.push({
      poz: k + 1,
      phone,
      name: decodeCp1250(image, NAME_BASE + k * NAME_SLOT, NAME_MAX),
      wyj1: (flag & WYJ1_BIT) !== 0,
      wyj2: (flag & WYJ2_BIT) !== 0,
      admin: k < ADMIN_SLOTS,
    });
  }
  return out;
}

/**
 * Write one subscriber back in place. The image is the storage, so editing is just rewriting the
 * two string slots and the flag byte; nothing is sent anywhere until a write is asked for.
 */
export function writeAbonentPhone(image: Uint8Array, poz: number, phone: string): void {
  encodeCp1250(image, PHONE_BASE + (poz - 1) * PHONE_SLOT, PHONE_MAX, phone);
}

export function writeAbonentName(image: Uint8Array, poz: number, name: string): void {
  encodeCp1250(image, NAME_BASE + (poz - 1) * NAME_SLOT, NAME_MAX, name);
}

export function setAbonentOutput(image: Uint8Array, poz: number, bit: number, on: boolean): void {
  const at = FLAG_BASE + (poz - 1);
  image[at] = on ? image[at] | bit : image[at] & ~bit & 0xff;
}

/**
 * Add or clear an entry. The vendor's loader (`FUN_004C7E94`) walks slots `1..total` and puts each
 * one into exactly one of the two grids: the `administratorzy` grid gets slot `k` only when `k ≤ 16`
 * **and the phone is not empty**, while the `uŁytkownicy` grid gets every slot from 17 up whether or
 * not it is populated. So adding is writing a phone into a free slot and removing is clearing one,
 * and a cleared slot also loses its name and its flag byte — which is what the dumps show at the
 * holes inside `1..16`.
 */
export function clearAbonent(image: Uint8Array, poz: number): void {
  writeAbonentPhone(image, poz, '');
  writeAbonentName(image, poz, '');
  image[FLAG_BASE + (poz - 1)] = 0;
}

/** The first empty slot in `from..to` (1-based, inclusive), or 0 when the region is full. */
export function nextFreeSlot(image: Uint8Array, from: number, to: number): number {
  for (let k = Math.max(1, from); k <= Math.min(ABONENT_SLOTS, to); k++) {
    if (image[PHONE_BASE + (k - 1) * PHONE_SLOT] === 0) {
      return k;
    }
  }
  return 0;
}

/** The last slot that still holds an entry — the entry bound after a remove. */
export function lastOccupied(image: Uint8Array): number {
  for (let k = ABONENT_SLOTS; k >= 1; k--) {
    if (image[PHONE_BASE + (k - 1) * PHONE_SLOT] !== 0) {
      return k;
    }
  }
  return 0;
}

/** Write the entry bound the head keeps at `0x000F`. */
export function writeTotal(image: Uint8Array, total: number): void {
  image[TOTAL_COUNT_AT] = total & 0xff;
  image[TOTAL_COUNT_AT + 1] = (total >> 8) & 0xff;
}

/** Occupied-slot count, which is what the vendor status bar reports as "abonenci: n/1000". */
export function countAbonents(image: Uint8Array): number {
  let n = 0;
  for (let k = 0; k < ABONENT_SLOTS; k++) {
    if (image[PHONE_BASE + k * PHONE_SLOT] !== 0) {
      n++;
    }
  }
  return n;
}

/**
 * Admin PINs: `image[1..4]` is the PIN the gate authenticates against; the two NUL-terminated
 * ASCII strings at `0x11` and `0x16` are the "HasÅ¡o computer PC" and "HasÅ¡o SMS" fields.
 */
export interface AdminInfo {
  devicePin: string; // image[1..4]
  pcPassword: string; // at 0x11, capacity 5
  smsPassword: string; // at 0x16, capacity 9
}

export function readAdminInfo(image: Uint8Array): AdminInfo {
  const at = (p: number): string => {
    let s = '';
    for (let i = p; i < image.length && image[i] !== 0; i++) {
      s += String.fromCharCode(image[i]);
    }
    return s;
  };
  return {
    devicePin: at(1),
    pcPassword: at(0x11),
    smsPassword: at(0x16),
  };
}

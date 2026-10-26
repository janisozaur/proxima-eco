/**
 * The subscriber ("abonenci") table and the parallel names table inside the device image.
 *
 * Layout was confirmed against a real dump: the subscriber table is **exactly 1000 slots × 19
 * bytes** starting at `0x400` (the arithmetic: `0x400 + 19·1000 = 0x4E38`), with the phone string
 * at slot offset 7 — a 12-char phone string fills a slot exactly. The names table starts at
 * `0x4E3F` with a 16-byte stride, so 7 zero bytes separate the two tables.
 */

import { decodeCp1250 } from './cp1250.ts';

export const ABONENT_BASE = 0x00400;
export const ABONENT_SLOT = 19;
export const ABONENT_SLOTS = 1000;
export const ABONENT_PHONE_AT = 7; // phone string offset within a slot
export const ABONENT_PHONE_LEN = ABONENT_SLOT - ABONENT_PHONE_AT;

export const NAME_BASE = 0x004e3f;
export const NAME_SLOT = 16;

/**
 * The leading 7 bytes of each slot (before the phone string) hold per-subscriber reaction
 * switches — the vendor UI shows them as "Wyjście 1 / Wyjście 2" checkboxes. Their encoding is
 * **not yet decoded**, so they are not rendered. TODO.
 */
export interface Abonent {
  poz: number; // 1-based, as the vendor UI numbers them
  phone: string;
  name: string;
}

/** Occupied slots only — an empty slot has no phone string. */
export function readAbonents(image: Uint8Array): Abonent[] {
  const out: Abonent[] = [];
  for (let k = 0; k < ABONENT_SLOTS; k++) {
    const slot = ABONENT_BASE + k * ABONENT_SLOT;
    const phone = decodeCp1250(image, slot + ABONENT_PHONE_AT, ABONENT_PHONE_LEN);
    if (phone === '') {
      continue;
    }
    const name = decodeCp1250(image, NAME_BASE + k * NAME_SLOT, NAME_SLOT);
    out.push({ poz: k + 1, phone, name });
  }
  return out;
}

/** Occupied-slot count, which is what the vendor status bar reports as "abonenci: n/1000". */
export function countAbonents(image: Uint8Array): number {
  let n = 0;
  for (let k = 0; k < ABONENT_SLOTS; k++) {
    if (image[ABONENT_BASE + k * ABONENT_SLOT + ABONENT_PHONE_AT] !== 0) {
      n++;
    }
  }
  return n;
}

/**
 * Admin PINs from the config head: two NUL-terminated ASCII numeric strings at `0x11` and `0x16`,
 * which the vendor UI labels "HasÅ¡o computer PC" and "HasÅ¡o SMS". `image[1..4]` is the PIN the
 * gate authenticates against (also visible in the `0x81` status block).
 */
export interface AdminInfo {
  devicePin: string; // image[1..4]
  pcPassword: string; // at 0x11
  smsPassword: string; // at 0x16
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

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

import { decodeCp1250 } from './cp1250.ts';

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

export interface Abonent {
  poz: number; // 1-based, as the vendor UI numbers them
  phone: string;
  name: string;
  wyj1: boolean;
  wyj2: boolean;
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
    });
  }
  return out;
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

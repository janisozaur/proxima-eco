/**
 * The `.bme` file codec.
 *
 * A `.bme` file is a fixed-size, header-less, checksum-less byte transformation of the 128 KiB
 * device image — which is exactly why a `.bme` file and a stream of `0x06` reads are
 * interchangeable.
 *
 * Verified against a real dump pair over all 131 072 bytes: encode reproduces the saved file, and
 * every ciphertext byte has exactly one admissible key, so decoding needs no side information.
 */

import { IMAGE_LEN } from './protocol.ts';

const KEY = [0x4a, 0xcc, 0x96, 0x9e];

/** Key index taken from the *plaintext* byte: bit 0 and bit 5. */
function keyIndex(plainByte: number): number {
  return (plainByte & 1) | ((plainByte & 0x20) >> 4);
}

function rotl(x: number, n: number): number {
  return ((x << n) | (x >> (8 - n))) & 0xff;
}

function rotr(x: number, n: number): number {
  return ((x >> n) | (x << (8 - n))) & 0xff;
}

/** image → `.bme` file bytes. */
export function encodeBme(image: Uint8Array): Uint8Array {
  const out = new Uint8Array(image.length);
  for (let i = 0; i < image.length; i++) {
    const p = image[i];
    out[i] = rotl(p ^ KEY[keyIndex(p)], 1);
  }
  return out;
}

/**
 * `.bme` file bytes → image. The key depends on the plaintext byte, so each byte is decoded by
 * trying all four keys and keeping the one that is self-consistent; exactly one always is.
 */
export function decodeBme(file: Uint8Array): Uint8Array {
  const out = new Uint8Array(file.length);
  for (let i = 0; i < file.length; i++) {
    const t = rotr(file[i], 1);
    let found = -1;
    for (let s = 0; s < KEY.length; s++) {
      const p = t ^ KEY[s];
      if (keyIndex(p) === s) {
        if (found >= 0) {
          throw new Error(`ambiguous key at ${i}: both ${found} and ${s} are self-consistent`);
        }
        found = p;
      }
    }
    if (found < 0) {
      throw new Error(`no self-consistent key at ${i}`);
    }
    out[i] = found;
  }
  return out;
}

/** A `.bme` file is always exactly the image size; anything else is not a client dump. */
export function assertImageSize(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== IMAGE_LEN) {
    throw new RangeError(`expected ${IMAGE_LEN} bytes, got ${bytes.length}`);
  }
  return bytes;
}

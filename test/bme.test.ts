/**
 * The `.bme` codec. Verified structurally (no vendor data involved): every byte value round-trips,
 * and a synthetic full image round-trips.
 */

import { eq } from 'node:assert';
import { assertImageSize, decodeBme, encodeBme } from '../src/bme.ts';
import { IMAGE_LEN } from '../src/protocol.ts';

// ---- every byte value survives a round trip (the key is self-consistent) ----
for (let b = 0; b < 256; b++) {
  const one = new Uint8Array([b]);
  eq(decodeBme(encodeBme(one))[0], b);
}

// ---- a full synthetic image round-trips ----
{
  const image = new Uint8Array(IMAGE_LEN);
  for (let i = 0; i < image.length; i++) {
    image[i] = (i * 31 + 7) & 0xff;
  }
  const file = encodeBme(image);
  eq(file.length, IMAGE_LEN);
  const back = decodeBme(assertImageSize(file));
  let same = true;
  for (let i = 0; i < image.length; i++) {
    if (back[i] !== image[i]) {
      same = false;
      break;
    }
  }
  eq(same, true);
}

// ---- a truncated file is rejected, not silently padded ----
{
  let rejected = false;
  try {
    decodeBme(assertImageSize(new Uint8Array(16)));
  } catch {
    rejected = true;
  }
  eq(rejected, true);
}

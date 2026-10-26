/**
 * CP-1250 decoding. Structural: the table must be exactly the 0x80..0xFF range, and the Polish
 * letters that actually appear in device text must map the way the vendor renders them.
 */

import { ok } from 'node:assert';

function eq(actual: unknown, expected: unknown): void {
  ok(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
import { decodeByte, decodeCp1250, unencodable } from '../src/cp1250.ts';

// ---- the table covers 0x80..0xFF and nothing else ----
eq(decodeByte(0x41), 'A');
eq(decodeByte(0x80), '\u20ac'); // €
eq(decodeByte(0xff), '\u02d9'); // ˙

// ---- the undefined code points are not silently mapped to a letter ----
for (const gap of [0x81, 0x83, 0x88, 0x90, 0x98]) {
  eq(decodeByte(gap), '\ufffd');
}

// ---- the Polish letters seen in device text ----
eq(decodeByte(0xa3), '\u0141'); // Ł — the first byte of the name "Łukasz"
eq(decodeByte(0xb3), '\u0142'); // ł
eq(decodeByte(0xa5), '\u0104'); // Ą
eq(decodeByte(0xb9), '\u0105'); // ą
eq(decodeByte(0xe6), '\u0107'); // ć
eq(decodeByte(0x9c), '\u015b'); // ś

// ---- reading stops at the NUL terminator, not at the slot boundary ----
{
  const bytes = new Uint8Array([0x41, 0xa3, 0x00, 0x42]);
  eq(decodeCp1250(bytes, 0, 4), 'AŁ');
  eq(decodeCp1250(bytes, 3, 1), 'B');
}

// ---- unencodable names the first letter the encoder would have to fake ----
eq(unencodable(''), '');
eq(unencodable('LANDA'), '');
eq(unencodable('\u0141ukasz'), ''); // Łukasz: every letter has a byte
eq(unencodable('\u20ac'), ''); // U+20AC is byte 0x80
eq(unencodable('a\u0414b'), '\u0414'); // Cyrillic has no byte, and it is the first offender
eq(unencodable('a\u01c5b'), '\u01c5'); // U+01C5 is a gap in the table
eq(unencodable('?'), ''); // the '?' the encoder falls back to is itself storable

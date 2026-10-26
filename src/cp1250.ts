/**
 * CP-1250 decoding for text stored in the device image.
 *
 * The vendor client writes NUL-terminated text in **CP-1250** (Windows-1250, Central European):
 * the names table holds `0xA3` = Ł, and the app's own rich-text controls declare
 * `EASTEUROPE_CHARSET`. Browsers cannot help — the WHATWG Encoding Standard deliberately maps
 * cp1250–cp1258 onto windows-1252 — so `TextDecoder('cp1250')` yields the wrong glyph for every
 * Polish letter. The explicit table below is therefore used instead.
 *
 * Table source: `CP1250.TXT` (Unicode Consortium / Microsoft, cp1250 → Unicode). The five
 * undefined code points (0x81, 0x83, 0x88, 0x90, 0x98) decode to U+FFFD.
 */

/** One code point per byte 0x80..0xFF, in order; U+FFFD marks an undefined code point. */
const HIGH: string =
  '\u20ac\ufffd\u201a\ufffd\u201e\u2026\u2020\u2021\ufffd\u2030\u0160\u2039\u015a\u0164\u017d' +
  '\u0179\ufffd\u2018\u2019\u201c\u201d\u2022\u2013\u2014\ufffd\u2122\u0161\u203a\u015b\u0165' +
  '\u017e\u017a\u00a0\u02c7\u02d8\u0141\u00a4\u0104\u00a6\u00a7\u00a8\u00a9\u015e\u00ab\u00ac' +
  '\u00ad\u00ae\u017b\u00b0\u00b1\u02db\u0142\u00b4\u00b5\u00b6\u00b7\u00b8\u0105\u015f\u00bb' +
  '\u013d\u02dd\u013e\u017c\u0154\u00c1\u00c2\u0102\u00c4\u0139\u0106\u00c7\u010c\u00c9\u0118' +
  '\u00cb\u011a\u00cd\u00ce\u010e\u0110\u0143\u0147\u00d3\u00d4\u0150\u00d6\u00d7\u0158\u016e' +
  '\u00da\u0170\u00dc\u00dd\u0162\u00df\u0155\u00e1\u00e2\u0103\u00e4\u013a\u0107\u00e7\u010d' +
  '\u00e9\u0119\u00eb\u011b\u00ed\u00ee\u010f\u0111\u0144\u0148\u00f3\u00f4\u0151\u00f6\u00f7' +
  '\u0159\u016f\u00fa\u0171\u00fc\u00fd\u0163\u02d9';

/** Decode one byte. Bytes below 0x80 are ASCII; 0x80..0xFF index the table above. */
export function decodeByte(byte: number): string {
  if (byte < 0x80) {
    return String.fromCharCode(byte);
  }
  const ch = HIGH[byte - 0x80];
  return ch === '\ufffd' ? '\ufffd' : ch;
}

/**
 * Decode a NUL-terminated CP-1250 string from `bytes` starting at `at`, reading at most `limit`
 * bytes. Reading stops at the first NUL, which is how every string in the image is delimited.
 */
export function decodeCp1250(bytes: Uint8Array, at: number, limit: number): string {
  let out = '';
  for (let i = at; i < at + limit && i < bytes.length && bytes[i] !== 0; i++) {
    out += decodeByte(bytes[i]);
  }
  return out;
}

/** Reverse of `decodeByte`: the code point a byte stands for, or undefined for a gap. */
const HIGH_CODE: number[] = [...HIGH].map((ch) => ch.charCodeAt(0));

export function encodeByte(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code < 0x80) {
    return code;
  }
  const i = HIGH_CODE.indexOf(code);
  return i < 0 ? 0x3f : i + 0x80; // '?' for a letter CP-1250 cannot represent
}

/**
 * Write `text` as CP-1250 into `bytes` at `at`, zero-filling the rest of `limit` — the slot
 * convention the vendor writes (payload only, no length byte). Returns the number of bytes used.
 * Longer text is truncated to `limit`, which is the slot capacity.
 */
export function encodeCp1250(bytes: Uint8Array, at: number, limit: number, text: string): number {
  let n = 0;
  for (; n < limit && n < text.length; n++) {
    bytes[at + n] = encodeByte(text[n]);
  }
  for (let i = n; i < limit; i++) {
    bytes[at + i] = 0;
  }
  return n;
}

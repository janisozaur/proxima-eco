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

import { decodeCp1250, encodeCp1250, unencodable } from './cp1250.ts';

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

/**
 * Empty slots inside the users region `17..bound` — the blank rows the vendor's grid shows. Holes
 * inside the fixed 16-slot administratorzy region are **not** counted: that region is fixed and its
 * grid never draws an empty slot, so its holes are legitimate.
 */
export function countGaps(image: Uint8Array): number {
  const total = Math.min(ABONENT_SLOTS, readTotal(image));
  let gaps = 0;
  for (let k = ADMIN_SLOTS + 1; k <= total; k++) {
    if (image[PHONE_BASE + (k - 1) * PHONE_SLOT] === 0) {
      gaps += 1;
    }
  }
  return gaps;
}

/**
 * Close the gaps in the users region: move the populated entries down so they are dense from slot
 * 17 up, keeping their order, and lower the entry bound. Two things are deliberately left alone:
 * the administratorzy region keeps its holes (it is a fixed 16 slots and its grid never shows an
 * empty one), and the CLIP table at `0x8CBF` is a separate table whose row indices are not slot
 * numbers — in both dumps it is `0xFF` except for row 0 — so renumbering entries says nothing
 * about it.
 */
export function compactAbonents(image: Uint8Array): number {
  const total = Math.min(ABONENT_SLOTS, readTotal(image));
  const kept: number[] = [];
  for (let k = ADMIN_SLOTS + 1; k <= total; k++) {
    if (image[PHONE_BASE + (k - 1) * PHONE_SLOT] !== 0) {
      kept.push(k);
    }
  }
  const gaps = total - ADMIN_SLOTS - kept.length;
  if (gaps === 0) {
    return 0;
  }

  // read every payload before writing any, so the rewrite cannot eat something not yet moved
  const flags = kept.map((k) => image[FLAG_BASE + k - 1]);
  const phones = kept.map((k) => image.slice(PHONE_BASE + (k - 1) * PHONE_SLOT, PHONE_BASE + k * PHONE_SLOT));
  const names = kept.map((k) => image.slice(NAME_BASE + (k - 1) * NAME_SLOT, NAME_BASE + k * NAME_SLOT));

  for (let k = ADMIN_SLOTS + 1; k <= total; k++) {
    clearAbonent(image, k);
  }
  for (let i = 0; i < kept.length; i++) {
    const k = ADMIN_SLOTS + 1 + i;
    image[FLAG_BASE + k - 1] = flags[i];
    copySlot(image, PHONE_BASE + (k - 1) * PHONE_SLOT, phones[i]);
    copySlot(image, NAME_BASE + (k - 1) * NAME_SLOT, names[i]);
  }
  writeTotal(image, ADMIN_SLOTS + kept.length);
  return gaps;
}

function copySlot(image: Uint8Array, at: number, bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) {
    image[at + i] = bytes[i];
  }
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
 * The three fields the vendor's „Info admin." tab edits, and where the packer (`FUN_004CAD38`)
 * puts them in the image. The capacities come from the packer's own write loops:
 *
 * * device PIN — 4 ASCII digits at `0x0001`. The head write keeps a capacity/length marker at
 *   `image[0]` and the payload from `0x0001`; the `0x81` status block carries the same four bytes
 *   at `b[9..12]`, which is what fixes the length at 4.
 * * „Hasło computer PC" — a Delphi `string[5]`, so 5 payload bytes at `0x0011`. The packer loop
 *   runs 6 times with the length clamped to 5, and its 6th write (a 0 at `0x0016`) is immediately
 *   overwritten by the SMS field below it.
 * * „Hasło SMS" — a `string[9]`, 9 payload bytes at `0x0016`. Its loop runs 10 times, and the 10th
 *   write (a 0 at `0x001F`) is overwritten by the flag array, which the packer writes after it.
 *
 * So the usable payloads are exactly `0x0001..0x0004`, `0x0011..0x0015` and `0x0016..0x001E`:
 * `image[0]` and `image[0x1F]` belong to other fields and are never written by an edit here.
 */
export const PIN_AT = 0x0001;
export const PIN_LEN = 4;
export const PC_AT = 0x0011;
export const PC_LEN = 5;
export const SMS_AT = 0x0016;
export const SMS_LEN = 9;

export interface AdminField {
  label: string; // the vendor's own caption on tab 2
  at: number; // where the payload starts in the image
  limit: number; // bytes it holds, i.e. the capacity of the edit
}

/** The admin fields in the order the vendor's tab shows them. */
export const ADMIN_FIELDS: AdminField[] = [
  {label: 'PIN (gate)', at: PIN_AT, limit: PIN_LEN},
  {label: 'Hasło komputer PC:', at: PC_AT, limit: PC_LEN},
  {label: 'Hasło SMS:', at: SMS_AT, limit: SMS_LEN},
];

/**
 * The two output settings the vendor's „Reakcje wyjść na CLIP" group box holds, and where the
 * packer (`FUN_004CAD38`) puts them. Each output owns one 16-bit little-endian word:
 *
 * ```
 * image[0x0A..0x0B]  output 1     image[0x0C..0x0D]  output 2
 * ```
 *
 * The low 15 bits are the monostable working time in **tenths of a second** — the client clamps it
 * to `0x7FFF` (3276.7 s) when a `TMemoEdit` with edit mask `9999.9;1;0` sets it, and prints it as
 * `%.4d.%d`. Bit 15 is the working mode: the packer does `image[at + 1] |= 0x80` when the mode
 * global is non-zero, and the `TComboBox OnChange` handler sets that global to 1 for the first item
 * („bistabilny") and to 0 for the second („monostabilny", the branch that also reads the time). So
 * bit 15 set means bistabilny, and a cleared bit means monostabilny — which is the mode that needs
 * a time, and both dumps have it cleared with a time of 50 tenths = 5.0 s.
 */
export const OUT1_AT = 0x000a;
export const OUT2_AT = 0x000c;
export const OUT_TENTHS_MAX = 0x7fff;
export const OUT_BISTABILNY = 0x8000;

/** The monostable time of output `n` (1 or 2), in tenths of a second, flag bit excluded. */
export function outTenths(image: Uint8Array, n: number): number {
  const at = n === 1 ? OUT1_AT : OUT2_AT;
  return (image[at] | (image[at + 1] << 8)) & (OUT_TENTHS_MAX as number);
}

/** Whether output `n` works bistably (its time is then meaningless). */
export function outBistabilny(image: Uint8Array, n: number): boolean {
  const at = n === 1 ? OUT1_AT : OUT2_AT;
  return (image[at + 1] & (OUT_BISTABILNY >> 8)) !== 0;
}

/** Write both halves of one output's word at once, so the flag bit and the time cannot drift. */
export function writeOut(image: Uint8Array, n: number, tenths: number, bistabilny: boolean): void {
  const at = n === 1 ? OUT1_AT : OUT2_AT;
  const t = tenths < 0 ? 0 : tenths > OUT_TENTHS_MAX ? OUT_TENTHS_MAX : tenths;
  image[at] = t & 0xff;
  image[at + 1] = ((t >> 8) & 0x7f) | (bistabilny ? 0x80 : 0);
}

/**
 * The reaction list — the vendor's `LV_ReakcjeWejsc` grid on the same tab, whose group box is
 * captioned „Reakcja wyjść na zdarzenia od wejść i przycisków". The packer writes 300 rows of 64
 * bytes at `0x8CBF`, and both the packer and the unpacker agree on the row framing:
 *
 * ```
 * +0..1  u16   field A
 * +2     u8    field B
 * +3..4  u16   group
 * +5..63 59 B  text, copied byte for byte
 * ```
 *
 * A row is **used** exactly when its `group` is neither 0 nor `0xFFFF` — that is the test the
 * unpacker uses before it appends a row to the client's list, and it is why the unused rows read as
 * an all-`0xFF` span rather than as data. The client keeps 33 words (66 B) per row and the image
 * keeps 64, which is where the high byte of field B and the client's last byte are dropped.
 *
 * What `A`, `B` and `group` mean is still open: the CSV export uses `group` as an index into an
 * 11-entry table and switches on `B` to pick how the row prints, but neither table has been pinned
 * to the vendor's own captions yet. The text is copied verbatim, so it is the only column this
 * client edits.
 */
export const CLIP_AT = 0x8cbf;
export const CLIP_ROWS = 300;
export const CLIP_ROW = 64;
export const CLIP_TEXT_AT = 5;
export const CLIP_TEXT_LEN = 59;

export interface ClipRow {
  poz: number; // 1-based row number, the vendor's "Lp" column
  at: number; // where the row starts in the image
  a: number; // u16 at +0, meaning not decoded
  b: number; // u8 at +2, meaning not decoded
  group: number; // u16 at +3, meaning not decoded
  text: string; // the 59 text bytes at +5
}

/** The rows the image actually holds, in order. */
export function readClipRows(image: Uint8Array): ClipRow[] {
  const out: ClipRow[] = [];
  for (let r = 0; r < CLIP_ROWS; r++) {
    const at = CLIP_AT + r * CLIP_ROW;
    const group = image[at + 3] | (image[at + 4] << 8);
    if (group === 0 || group === 0xffff) {
      continue;
    }
    out.push({
      poz: r + 1,
      at,
      a: image[at] | (image[at + 1] << 8),
      b: image[at + 2],
      group,
      text: decodeCp1250(image, at + CLIP_TEXT_AT, CLIP_TEXT_LEN),
    });
  }
  return out;
}

/** Where the text of a reaction row lives, for an in-place edit. */
export function clipTextAt(poz: number): number {
  return CLIP_AT + (poz - 1) * CLIP_ROW + CLIP_TEXT_AT;
}

/**
 * What the vendor prints for a row. `FUN_004C7584` builds the caption list at load time, one entry
 * per id, and the row's `a` field is that id:
 *
 * ```
 * 1                 Reset modułu GSM
 * 2…7               the six input kinds, for input 1
 * 8…13              the same six kinds, for input 2
 * 14, 15            Wciśnie przycisku 1 / 2
 * 16, 17            Zwolnienie przycisku 1 / 2
 * 18                Obcy SMS - sms nie od uſytkownika i administratora
 * 19                Autotest 24 godzinny
 * 20…1019           CLIP abonenta <phone of slot id-19>
 * 1020              CLIP dowolnego abonenta
 * 1024, 1025        Powrot sygnału GSM / Zanik sygnału GSM
 * ```
 *
 * The captions are the const pool at `0x4BAD2C`…`0x4BAF2C`, so the ids 2…7 and 8…13 are the same
 * six captions with `%d` replaced by the input number. `b` picks the „Reakcja" caption and how
 * „Właśiwośi" prints: 5 is the CLIP reaction with a `Tclip=%d.%d sek.`
 * property whose value is the row's first text byte in tenths, 6 is the SMS reaction with the
 * text itself. Any other id has no evidence yet and stays as the raw value.
 */
export const EVENT_INPUT_KINDS = [
  'Podanie masy na wejście %d',
  'Podanie plusa na wejście %d',
  'Zanik masy na wejściu %d',
  'Zanik plusa na wejściu %d',
  'Zmiana z masy na plusa na wejściu %d',
  'Zmiana z plusa na masę na wejściu %d',
];

/** The caption for a row's `a` id, or `''` when the id is not one the client can name. */
export function eventCaption(image: Uint8Array, id: number): string {
  if (id === 1) {
    return 'Reset modułu GSM';
  }
  if (id >= 2 && id <= 13) {
    const kind = EVENT_INPUT_KINDS[(id - 2) % 6];
    return kind.replace('%d', String(1 + Math.floor((id - 2) / 6)));
  }
  if (id === 14 || id === 15) {
    return `Wciśnięcie przycisku ${id - 13}`;
  }
  if (id === 16 || id === 17) {
    return `Zwolnienie przycisku ${id - 15}`;
  }
  if (id === 18) {
    return 'Obcy SMS - sms nie od użytkownika i administratora';
  }
  if (id === 19) {
    return 'Autotest 24 godzinny';
  }
  if (id >= 20 && id <= 1019) {
    const slot = id - 19;
    const phone = decodeCp1250(image, PHONE_BASE + (slot - 1) * PHONE_SLOT, PHONE_MAX);
    return `CLIP abonenta ${phone}`;
  }
  if (id === 1020) {
    return 'CLIP dowolnego abonenta';
  }
  if (id === 1024) {
    return 'Powrot sygnału GSM';
  }
  if (id === 1025) {
    return 'Zanik sygnału GSM';
  }
  return '';
}

/** The „Reakcja" caption for a row's `b`, or `''` when that id is not pinned yet. */
export function reactionCaption(b: number): string {
  if (b === 5) {
    return 'Wyłanie CLIP-u';
  }
  if (b === 6) {
    return 'Wyłanie SMS-a';
  }
  return '';
}

/** The „Właśiwośi" column: a CLIP row prints its Tclip, an SMS row its text. */
export function eventProperty(image: Uint8Array, row: ClipRow): string {
  if (row.b === 5) {
    const tenths = image[row.at + CLIP_TEXT_AT];
    return `Tclip=${Math.trunc(tenths / 10)}.${tenths % 10} sek.`;
  }
  return row.text;
}

/**
 * Admin PINs read through the field table above: `image[1..4]` is the PIN the gate authenticates
 * against, and the two NUL-terminated ASCII strings at `0x11` and `0x16` are the „Hasło computer
 * PC" and „Hasło SMS" fields.
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
    devicePin: at(PIN_AT),
    pcPassword: at(PC_AT),
    smsPassword: at(SMS_AT),
  };
}

/**
 * Why the client will not accept a typed value, or `''` when it will. The capacity is the vendor's
 * own and is not a style choice: a phone slot is a `string[18]` and a name slot a `string[15]`, so
 * the image has no room for one character more, and CP-1250 has no byte for some letters at all.
 *
 * The `+` is a client rule. Every phone the vendor ever writes starts with one — `+48…` in the
 * dumps — and the gate needs it to know which country code to dial, so a phone that does not start
 * with one is refused rather than silently stored. An empty phone is fine: that is an empty slot,
 * which is how an entry gets removed.
 */
export function textProblem(text: string, limit: number, phone: boolean): string {
  if (text.length > limit) {
    return `too long: the slot holds ${limit} characters`;
  }
  const bad = unencodable(text);
  if (bad !== '') {
    return `CP-1250 has no byte for ${bad}`;
  }
  if (!phone) {
    return '';
  }
  if (text === '') {
    return '';
  }
  if (text[0] !== '+') {
    return 'must start with + for the country code';
  }
  for (let i = 1; i < text.length; i++) {
    if (text[i] < '0' || text[i] > '9') {
      return 'only digits after the +';
    }
  }
  return '';
}

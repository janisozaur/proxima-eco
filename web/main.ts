/**
 * Browser entry point — the UI, mirroring the vendor client's tab layout.
 *
 * Tab captions and column headers are the vendor's own strings, read out of the form definitions
 * inside `ProgramatorBramaGsmMiniKlient.exe` (the `TTabSheet`/`Caption` properties and the
 * `JVListView` column captions), decoded from CP-1250. Only short labels are reproduced.
 *
 * Two things this client deliberately does **not** copy from the vendor app:
 *
 * * It never asks for a password. The vendor's service password short-circuits locally — no
 *   packet reaches the gate — so asking for one would be theatre. `login(SERVICE_PASSWORD)`
 *   performs zero exchanges (see `session.ts`), and every measured session that used it
 *   contains no `0x0F`/`0x8F` exchange at all.
 * * It does not fake tabs it cannot implement. A tab whose semantics are still undecoded renders
 *   an explicit note instead of plausible-looking data.
 */

import { Session, SERVICE_PASSWORD, PageRejected } from '../src/session.ts';
import { connectWebHid, describeDevices } from '../src/webhid.ts';
import { webHidAvailable } from '../src/capability.ts';
import { assertImageSize, decodeBme, encodeBme } from '../src/bme.ts';
import { IMAGE_LEN, REGION_TABLE_DWORDS } from '../src/protocol.ts';
import {
  ABONENT_SLOTS,
  FLAG_BASE,
  PHONE_BASE,
  PHONE_SLOT,
  PHONE_MAX,
  NAME_BASE,
  NAME_SLOT,
  NAME_MAX,
  WYJ1_BIT,
  WYJ2_BIT,
  ADMIN_SLOTS,
  ADMIN_FIELDS,
  PIN_AT,
  PIN_LEN,
  readAbonents,
  OUT_TENTHS_MAX,
  outTenths,
  outBistabilny,
  writeOut,
  CLIP_ROWS,
  CLIP_TEXT_LEN,
  readClipRows,
  clipTextAt,
  readTotal,
  countGroups,
  countAbonents,
  clearAbonent,
  lastOccupied,
  writeTotal,
  countGaps,
  compactAbonents,
} from '../src/abonents.ts';
import { decodeCp1250, encodeCp1250 } from '../src/cp1250.ts';
import type { Transport } from '../src/transport.ts';
import type { Frame, Status } from '../src/protocol.ts';

// ---------------------------------------------------------------- state

interface State {
  image: Uint8Array | null;
  origin: Uint8Array | null; // the image exactly as it was loaded/read, to reset edits against
  status: Status | null;
  regions: number[] | null;
  pushes: Frame[];
  devices: string[];
  source: string; // what the current image came from, for the footer strip
  error: string | null;
  live: boolean;
}

const state: State = {
  image: null,
  origin: null,
  status: null,
  regions: null,
  pushes: [],
  devices: [],
  source: 'No image loaded.',
  error: null,
  live: false,
};

/** Whether the image differs at all from the image exactly as it was read or loaded. */
function edited(): boolean {
  const a = state.image;
  const b = state.origin;
  if (a === null || b === null) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return true;
    }
  }
  return false;
}

/** The session and its transport, set once the device is connected. */
let session: Session | null = null;
let device: Transport | null = null;

// ---------------------------------------------------------------- DOM helpers

function el(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls !== '') {
    e.className = cls;
  }
  if (text !== '') {
    e.textContent = text;
  }
  return e;
}

function add(parent: HTMLElement, child: HTMLElement): HTMLElement {
  parent.appendChild(child);
  return child;
}

function row(parent: HTMLElement, fallbackCls: string, cells: [string, string][]): HTMLElement {
  const tr = add(parent, el('tr', '', ''));
  for (const [cls, text] of cells) {
    const effective = cls === '' ? fallbackCls : cls;
    const tag = effective.split('.')[0];
    add(tr, el(tag, effective, text));
  }
  return tr;
}

function card(title: string, pairs: [string, string][]): HTMLElement {
  const c = el('div', 'card', '');
  add(c, el('h2', '', title));
  const dl = add(c, el('dl', 'dl', ''));
  for (const [k, v] of pairs) {
    add(dl, el('dt', '', k));
    add(dl, el('dd', '', v));
  }
  return c;
}

function note(parent: HTMLElement, text: string): void {
  add(parent, el('p', 'note', text));
}

function hex(bytes: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = at; i < at + len && i < bytes.length; i++) {
    s += ` ${bytes[i].toString(16).padStart(2, '0')}`;
  }
  return s.trim();
}

function addr24(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Known landmarks in the 0x83 region table, measured across two independent captures. */
const LANDMARKS: Record<number, string> = {
  1: 'transfer window start',
  8: 'first subscriber slot',
  9: 'names table',
  10: 'TEST record',
  11: 'window end / event log start',
  16: 'image end',
};

// ---------------------------------------------------------------- panels

/**
 * Tab 1 is **two grids**, exactly as the vendor's form has them: `LB_TytulUzytkownikow` +
 * `LV_Uzytkownicy` and `LB_TytulAdministratorow` + `LV_Administratorzy`. Both read the same
 * thousand-slot arrays, and the loader (`FUN_004C7E94`) decides which one a slot belongs to:
 * slots `1..16` are the `administratorzy` region — a fixed 16 slots, not a stored count — and
 * slots `17..` are the users.
 *
 * Cells are editable in place: the phone and name cells are `contenteditable` and a mutation
 * writes them straight back into the image slot, while a click on a checkbox cell toggles the
 * flag bit — the same gesture the vendor's `TGridClickHandler` performs. A phone that goes from
 * empty to filled (or the other way) adds or removes an entry, which also moves the entry bound
 * the head keeps at `0x000F`.
 */
const CELL_SLOTS = new Map<HTMLElement, CellSlot>();
const FLAG_CELLS = new Map<HTMLElement, { at: number; bit: number }>();
const OUT_CELLS = new Map<HTMLElement, { n: number }>(); // the „Czas monostabilnej pracy" cells
const TIME_ROWS = new Map<number, HTMLElement[]>(); // one output's whole time row, hidden when bistabilny
const READ_CELLS = new Map<number, HTMLElement>(); // the vendor's own „0h 0min. 5.0sek." read-out

interface CellSlot {
  at: number; // where the slot starts in the image
  limit: number; // bytes the slot holds
  phone: boolean; // a Telefon cell, i.e. an entry's presence
  poz: number; // 1-based slot number
}

function paintFlag(cell: HTMLElement, on: boolean): void {
  cell.className = on ? 'td.flagOn' : 'td.flagOff';
  cell.textContent = on ? '✓' : '';
}

/** Outline a cell whose value no longer matches the image exactly as it was loaded. */
function markCell(cell: HTMLElement, on: boolean): void {
  const parts: string[] = [];
  for (const cls of cell.className.split(' ')) {
    if (cls !== 'dirty' && cls !== '') {
      parts.push(cls);
    }
  }
  if (on) {
    parts.push('dirty');
  }
  cell.className = parts.join(' ');
}

/** The value the slot behind `at` held when the image was last read or loaded. */
function originText(at: number, limit: number): string {
  const o = state.origin;
  return o === null ? '' : decodeCp1250(o, at, limit);
}

function originFlag(at: number, bit: number): boolean {
  const o = state.origin;
  return o !== null && (o[at] & bit) !== 0;
}

/** Every observer the current paint owns; re-rendering disconnects all of them. */
let paintObservers: MutationObserver[] = [];

function beginPaint(): void {
  CELL_SLOTS.clear();
  FLAG_CELLS.clear();
  OUT_CELLS.clear();
  TIME_ROWS.clear();
  READ_CELLS.clear();
  for (const o of paintObservers) {
    o.disconnect();
  }
  paintObservers = [];
}

/**
 * What a mutation in an editable cell means: the text now in the cell is written straight back
 * into the image slot behind it, which is what makes the change reach the gate on „Zapis to
 * device" or „Save .bme". A phone cell going empty ↔ filled also adds or removes an entry, so the
 * grids and the head's bound at `0x000F` are rebuilt.
 */
function cellMutations(ms: MutationRecord[]): void {
  const img = state.image;
  if (img === null) {
    return;
  }
  let touched = false;
  for (const m of ms) {
    const node = m.target;
    if (node === null) {
      continue;
    }
    const cell = node instanceof HTMLElement ? node : node.parentElement;
    if (cell === null) {
      continue;
    }
    const slot = CELL_SLOTS.get(cell);
    if (slot === undefined) {
      continue;
    }
    const before = decodeCp1250(img, slot.at, slot.limit);
    encodeCp1250(img, slot.at, slot.limit, cell.textContent);
    const stored = decodeCp1250(img, slot.at, slot.limit);
    if (cell.textContent !== stored) {
      // the slot is shorter than what was typed, or a letter has no CP-1250 byte: show what the
      // image actually holds rather than what was typed
      cell.textContent = stored;
    }
    if (slot.phone && (before === '') !== (stored === '')) {
      // an entry was added or removed: the grids and the head's bound follow the table
      if (stored === '') {
        clearAbonent(img, slot.poz);
      }
      syncBound(img, slot.poz);
      repaint();
      return;
    }
    touched = true;
    markCell(cell, stored !== originText(slot.at, slot.limit));
  }
  if (touched) {
    renderFooter();
  }
}

/** Watch the containers the current paint owns, with the handler that writes their cells back. */
function watchCells(roots: HTMLElement[], handle: (ms: MutationRecord[]) => void): void {
  const obs = new MutationObserver(handle);
  const watch = {childList: true, characterData: true, subtree: true};
  for (const r of roots) {
    obs.observe(r, watch);
  }
  paintObservers.push(obs);
}

/**
 * A typed „Czas monostabilnej pracy" cell is written back as tenths of a second, which is what the
 * image holds, and the cell is then re-set to the canonical form so it always shows what the image
 * actually says. The mode bit of the same word is left alone.
 */
function outMutations(ms: MutationRecord[]): void {
  const img = state.image;
  if (img === null) {
    return;
  }
  let touched = false;
  for (const m of ms) {
    const node = m.target;
    if (node === null) {
      continue;
    }
    const cell = node instanceof HTMLElement ? node : node.parentElement;
    if (cell === null) {
      continue;
    }
    const f = OUT_CELLS.get(cell);
    if (f === undefined) {
      continue;
    }
    if (cell.className.split(' ').includes('off')) {
      continue; // a greyed-out row is inert: nothing typed into it can reach the image
    }
    const tenths = parseTenths(cell.textContent);
    writeOut(img, f.n, tenths, outBistabilny(img, f.n));
    const shown = showTenths(tenths);
    if (cell.textContent !== shown) {
      cell.textContent = shown;
    }
    paintTimeRow(f.n, img);
    touched = true;
    markCell(cell, tenths !== originTenths(f.n));
  }
  if (touched) {
    renderFooter();
  }
}

/** Swap a cell's state class (`edit` or `off`) and leave the rest, `dirty` included, alone. */
function cellState(cell: HTMLElement, want: string[]): void {
  const parts: string[] = [];
  for (const cls of cell.className.split(' ')) {
    if (cls !== 'off' && cls !== 'edit' && cls !== '') {
      parts.push(cls);
    }
  }
  for (const w of want) {
    parts.push(w);
  }
  cell.className = parts.join(' ');
}

/**
 * Repaint one output's time row to match its mode, without moving anything.
 *
 * The vendor takes the field out of the form while an output is bistabilny: the DFM has
 * `Visible = False` on `LB_CzasMonoWy1`, `LB_CzasWlaczeniaWy1`, `LB_JedCzasMonoWy1`,
 * `ME_CzasWlaczeniaWy1` and `UpDo_CzasWlaczeniaWy1`, and `CB_TrybPracyWyjscia1Change`
 * (`0x4CCC7C`) sets Visible and Enabled to False for all five when the combo picks item 0
 * („bistabilny") and to True when it picks item 1 („monostabilny") — the branch that also calls
 * `ME_CzasWlaczeniaWy1Change` (`0x4CC3E8`) to repaint the memo.
 *
 * This client keeps the row in the grid and greys it out instead. The vendor's own form changes
 * height between the two modes, which makes the card jump every time the mode is flipped; here the
 * row stays in place, loses its typing affordance and its `contenteditable`, and is dimmed, so the
 * card is the same size and the same columns in both states. The value is still shown, dimmed,
 * because the image still holds it — only the gate ignores it while the output is bistabilny.
 */
function paintTimeRow(n: number, img: Uint8Array): void {
  const row = TIME_ROWS.get(n);
  if (row === undefined) {
    return;
  }
  const off = outBistabilny(img, n);
  const [dt, time, read] = row;
  cellState(dt, off ? ['off'] : []);
  cellState(time, off ? ['off'] : ['edit']);
  cellState(read, off ? ['off'] : []);
  if (off) {
    time.removeAttribute('contenteditable');
  } else {
    time.setAttribute('contenteditable', 'true');
  }
  const tenths = outTenths(img, n);
  const shown = showTenths(tenths);
  if (time.textContent !== shown) {
    time.textContent = shown;
  }
  const clock = showClock(tenths);
  if (read.textContent !== clock) {
    read.textContent = clock;
  }
}

/** Read a typed time as tenths of a second: "5", "5.0" and "5,5" all mean 50. */
function parseTenths(text: string): number {
  let whole = '';
  let tenth = '';
  let after = false;
  for (const ch of text.replace(',', '.')) {
    if (ch === '.') {
      after = true;
    } else if (ch >= '0' && ch <= '9') {
      if (!after) {
        whole += ch;
      } else if (tenth === '') {
        tenth = ch;
      }
    }
  }
  const w = whole === '' ? 0 : Number(whole);
  return w * 10 + (tenth === '' ? 0 : Number(tenth));
}

/** The vendor's own print of a time: `%.4d.%d` of tenths/10 and tenths%10. */
function showTenths(tenths: number): string {
  const t = tenths < 0 ? 0 : tenths > OUT_TENTHS_MAX ? OUT_TENTHS_MAX : tenths;
  return `${String(Math.trunc(t / 10)).padStart(4, '0')}.${t % 10}`;
}

/**
 * The same value the vendor prints next to the memo, from its `TUpDown` handler:
 * `%dh %dmin. %d.%dsek.` of `v/36000`, `v%36000/600`, `v%36000%600/10` and `v%10` — 36000 is one
 * hour in tenths, so the unit is 0.1 s and 50 tenths reads `0h 0min. 5.0sek.`.
 */
function showClock(tenths: number): string {
  const t = tenths < 0 ? 0 : tenths > OUT_TENTHS_MAX ? OUT_TENTHS_MAX : tenths;
  const rest = t % 36000;
  return `${Math.trunc(t / 36000)}h ${Math.trunc(rest / 600)}min. ${Math.trunc((rest % 600) / 10)}.${rest % 10}sek.`;
}

/** The time and the mode output `n` held when the image was last read or loaded. */
function originTenths(n: number): number {
  const o = state.origin;
  return o === null ? 0 : outTenths(o, n);
}

function originBistabilny(n: number): boolean {
  const o = state.origin;
  return o !== null && outBistabilny(o, n);
}

/**
 * Which slots each grid shows. The vendor's loader (`FUN_004C7E94`) walks slots `1..total` and
 * hands each one to exactly one of the two list views: the `administratorzy` view takes slot `k`
 * only when `k ≤ 16` **and its phone is not empty**, the `uŁytkownicy` view takes every slot from
 * 17 up, empty ones included. The row's index field is the global slot number, which is what the
 * `Poz.` column prints.
 *
 * This client shows the 16 administratorzy slots **including the empty ones**, which is the one
 * place it deliberately differs from the vendor: an empty administratorzy slot has nowhere to
 * type into otherwise, and the region is a fixed 16 slots, so its holes are real slots rather
 * than missing rows.
 */
function phoneAt(image: Uint8Array, poz: number): string {
  return decodeCp1250(image, PHONE_BASE + (poz - 1) * PHONE_SLOT, PHONE_MAX);
}

function adminSlots(): number[] {
  const out: number[] = [];
  for (let k = 1; k <= ADMIN_SLOTS; k++) {
    out.push(k);
  }
  return out;
}

function userSlots(image: Uint8Array): number[] {
  const total = Math.min(ABONENT_SLOTS, readTotal(image));
  const out: number[] = [];
  for (let k = ADMIN_SLOTS + 1; k <= total; k++) {
    out.push(k);
  }
  return out;
}

/** Keep the head's entry bound in step with the table after an entry is added or removed. */
function syncBound(image: Uint8Array, poz: number): void {
  const total = readTotal(image);
  if (poz > total) {
    writeTotal(image, poz);
    return;
  }
  const last = lastOccupied(image);
  if (poz >= total && last < total) {
    writeTotal(image, last);
  }
}

/** Put the loaded value back into one cell, re-drawing the grids when that changes which rows exist. */
function resetCell(cell: HTMLElement, at: number, limit: number, phone: boolean, poz: number): void {
  const img = state.image;
  if (img === null) {
    return;
  }
  const back = originText(at, limit);
  const before = decodeCp1250(img, at, limit);
  encodeCp1250(img, at, limit, back);
  cell.textContent = back;
  markCell(cell, false);
  if (phone && (before === '') !== (back === '')) {
    if (back === '') {
      clearAbonent(img, poz);
    }
    syncBound(img, poz);
    repaint();
    return;
  }
  renderFooter();
}

/**
 * Where the reader had scrolled in each grid of the panel about to be replaced. Re-rendering
 * rebuilds the scroll containers, which would otherwise jump every table back to the top on an
 * add, a remove or a cleanup.
 */
let gridScroll: number[] = [];

function restoreScroll(wrap: HTMLElement, index: number): void {
  const span = wrap.scrollHeight - wrap.clientHeight;
  if (index < gridScroll.length && span > 0) {
    wrap.scrollTop = Math.round(gridScroll[index] * span);
  }
}

function renderAbonents(panel: HTMLElement): void {
  const image = state.image;
  if (image === null) {
    note(panel, 'No image — read the gate or open a .bme file.');
    return;
  }

  // the cells this render owns are registered as they are built; showPanel already dropped the
  // previous paint's cells and its observer in beginPaint

  const grids = add(panel, el('div', 'grids', ''));
  const groups: { title: string; slots: number[]; addLabel: string }[] = [
    {
      title: 'Abonenci - administratorzy - reakcja na CLIP :',
      slots: adminSlots(),
      addLabel: '',
    },
    {
      title: 'Abonenci - uŁytkownicy reakcja na CLIP:',
      slots: userSlots(image),
      addLabel: 'Dodaj nwego abonenta',
    },
  ];
  const bodies: HTMLElement[] = [];
  let column = 0;
  for (const g of groups) {
    const col = add(grids, el('div', 'grid', ''));
    const wrap = add(col, el('div', 'table', ''));
    const table = add(wrap, el('table', '', ''));
    add(table, el('caption', '', g.title));
    const head = add(table, el('thead', '', ''));
    row(
      head,
      'th',
      [
        ['th', 'Poz.'],
        ['th', 'Telefon'],
        ['th', 'Nazwa'],
        ['th', 'Wyjście 1'],
        ['th', 'Wyjście 2'],
        ['th', 'Del'],
      ],
    );
    const body = add(table, el('tbody', '', ''));
    bodies.push(body);

    for (const poz of g.slots) {
      const tr = add(body, el('tr', '', ''));
      add(tr, el('td', 'num', String(poz).padStart(4, '0')));
      const phone = add(tr, el('td', 'phone', phoneAt(image, poz)));
      const name = add(tr, el('td', 'edit', decodeCp1250(image, NAME_BASE + (poz - 1) * NAME_SLOT, NAME_MAX)));
      const textCells: { cell: HTMLElement; at: number; limit: number; phone: boolean }[] = [
        {
          cell: phone,
          at: PHONE_BASE + (poz - 1) * PHONE_SLOT,
          limit: PHONE_MAX,
          phone: true,
        },
        {
          cell: name,
          at: NAME_BASE + (poz - 1) * NAME_SLOT,
          limit: NAME_MAX,
          phone: false,
        },
      ];
      for (const t of textCells) {
        const at = t.at;
        const limit = t.limit;
        t.cell.setAttribute('contenteditable', 'true');
        t.cell.setAttribute('spellcheck', 'false');
        CELL_SLOTS.set(t.cell, { at, limit, phone: t.phone, poz });
        markCell(t.cell, decodeCp1250(image, at, limit) !== originText(at, limit));
        t.cell.addEventListener('dblclick', () => {
          resetCell(t.cell, at, limit, t.phone, poz);
        });
      }
      const flagAt = FLAG_BASE + (poz - 1);
      const flag = image[flagAt];
      const bits: [number, boolean][] = [[WYJ1_BIT, (flag & WYJ1_BIT) !== 0], [WYJ2_BIT, (flag & WYJ2_BIT) !== 0]];
      for (const [bit, on] of bits) {
        const cell = add(tr, el('td', 'flagOff', ''));
        paintFlag(cell, on);
        FLAG_CELLS.set(cell, { at: flagAt, bit });
        markCell(cell, on !== originFlag(flagAt, bit));
        cell.addEventListener('click', () => {
          const img = state.image;
          if (img === null) {
            return;
          }
          const now = (img[flagAt] & bit) === 0;
          img[flagAt] = (now ? img[flagAt] | bit : img[flagAt] & ~bit) & 0xff;
          paintFlag(cell, now);
          markCell(cell, now !== originFlag(flagAt, bit));
          renderFooter();
        });
        cell.addEventListener('dblclick', () => {
          const img = state.image;
          if (img === null) {
            return;
          }
          const want = originFlag(flagAt, bit);
          img[flagAt] = (want ? img[flagAt] | bit : img[flagAt] & ~bit) & 0xff;
          paintFlag(cell, want);
          markCell(cell, false);
          renderFooter();
        });
      }
      const del = add(tr, el('td', 'del', '✕'));
      del.addEventListener('click', () => {
        const img = state.image;
        if (img === null) {
          return;
        }
        clearAbonent(img, poz);
        syncBound(img, poz);
        repaint();
      });
    }
    restoreScroll(wrap, column);
    column += 1;
    if (g.addLabel !== '') {
      const bar = add(col, el('div', 'addbar', ''));
      const addButton = add(bar, el('button', 'act add', g.addLabel));
      addButton.addEventListener('click', addAbonent);
    }
  }

  watchCells(bodies, cellMutations);

  note(
    panel,
    'Type in a Telefon / Nazwa cell to change it, click a Wyjście cell to toggle it, double-click a ' +
      'marked cell to put the loaded value back. „Zapis to device" or „Save .bme" carries the change.',
  );
  note(
    panel,
    'Add / remove: the ✕ cell at the end of a row removes that entry — its Nazwa and both Wyjście ' +
      'switches go with it, and clearing the last occupied slot lowers the bound. Typing a phone ' +
      'into an empty row adds an entry, in either grid. „Dodaj nwego abonenta" under the users grid ' +
      'only moves the bound, so the new row is blank and you type into it. „Cleanup gaps" closes the ' +
      'blank rows the users grid shows.',
  );
  const total = readTotal(image);
  const gaps = countGaps(image);
  note(
    panel,
    `The phone book is two fixed regions: 0001…${String(ADMIN_SLOTS).padStart(4, '0')} are the ` +
      `„administratorzy" slots and 0017…${String(total).padStart(4, '0')} „uŁytkownicy" — the head keeps ` +
      `that bound ${total} at 0x000F. The users region has ${gaps} empty slot${gaps === 1 ? '' : 's'} inside ` +
      'the bound, shown as blank rows; „Cleanup gaps" moves the entries down so there are none and ' +
      'lowers the bound. The vendor\'s own grid skips empty administratorzy slots; this client draws ' +
      'all 16 so there is somewhere to type an administrator into.',
  );
}

/**
 * Tab 2, `TS_Administracja` (caption `2 Info admin.`). The vendor's form is one group box
 * `GB_DodawanieZdarzenAdministratorow` captioned `Informacje przekazywane administratorom:`, holding
 * the label `Administratorzy:` next to the `TComboBox CB_Administrator` — a `csDropDownList` whose
 * hint is `Wybór administratora do dodania zdarzeń.` and which the client fills at runtime with the
 * administrators — the button `BT_DodajZdarzenieAdmin` (`Dodaj zdarzenie`, action
 * `ActionDodajZdarzenie`), and the `TListView LV_ZdarzeniaAdmin` in `vsReport` style with the columns
 * `Lp.` / `Zdarzenie` / `Reakcja` / `Właściwości`.
 *
 * The combobox contents are decoded: they are the 16 administratorzy slots that hold a phone, drawn
 * as `phone name` like the vendor's own screenshot. The button is a device action, not an image
 * field, so it is drawn in the client's "not implemented" style. The grid is the same 300-row table
 * as tab 3, so it is rendered by the shared `renderEventGrid`.
 */
function renderAdmin(panel: HTMLElement): void {
  const image = state.image;
  if (image === null) {
    note(panel, 'No image — the administratorzy region and the event rows are both in the image.');
    return;
  }

  const c = add(panel, el('div', 'card', ''));
  add(c, el('h2', '', 'Info admin.'));
  const dl = add(c, el('dl', 'dl', ''));
  add(dl, el('dt', '', 'Administratorzy:'));
  const admins = readAbonents(image).filter((a) => a.admin);
  const pick = add(dl, el('dd', 'pick', admins.length === 0 ? '' : `${admins[0].phone} ${admins[0].name}`.trim()));
  pick.setAttribute('title', 'Wybór administratora do dodania zdarze');
  const bar = add(c, el('div', 'pickbar', ''));
  for (const a of admins) {
    const label = `${a.phone} ${a.name}`.trim();
    const b = add(bar, el('button', 'pick', label));
    b.addEventListener('click', () => {
      pick.textContent = label;
      markCell(pick, false);
    });
  }
  const btn = add(c, el('button', 'act', 'Dodaj zdarzenie'));
  btn.setAttribute('data-todo', '');

  note(
    panel,
    `The dropdown is the vendor's CB_Administrator, a csDropDownList filled with the ${admins.length} ` +
      'occupied administratorzy slots as „phone name" like its own screenshot shows; clicking one ' +
      'selects it. „Dodaj zdarzenie" is the vendor\'s BT_DodajZdarzenieAdmin, whose action sends the ' +
      'new event to the gate rather than editing the image, so this client draws it as a pending ' +
      'action. The grid below is the vendor\'s own group caption, its stray opening bracket included ' +
      '— that is how the vendor wrote it.',
  );
  renderEventGrid(panel, image, '(Informacje przekazywane administratorom:');
}

/**
 * Tab 3. The vendor's form has two halves here. The group box `GB_UstWyjsc`, captioned „Reakcje
 * wyjść na CLIP:", holds the two `CB_TrybPracyWyjscia1/2` combo boxes — whose only items are
 * „bistabilny" and „monostabilny" — and the two `ME_CzasWlaczeniaWy1/2` memos with edit mask
 * `9999.9;1;0`. Those four values are decoded and editable: each output owns a 16-bit word in the
 * config head, low 15 bits = the monostable time in tenths of a second, bit 15 = bistabilny.
 *
 * The other half is the group box `GB_ReakcjaNaWejscia`, captioned „Reakcja wyjść na zdarzenia od
 * wejść i przycisków:", whose `LV_ReakcjeWejsc` grid is the 300-row table at `0x8CBF`. Only its row
 * framing and its 59-byte text column are decoded, so the numeric columns are printed as the raw
 * values they are rather than dressed up as the vendor's „Zdarzenie"/„Reakcja" captions.
 *
 * A bistabilny output shows no time at all — see `paintTimeRow`, which greys the row out instead of
 * taking it out of the form the way the vendor does, so the card keeps its size.
 */
function renderReakcje(panel: HTMLElement): void {
  const image = state.image;
  if (image === null) {
    note(panel, 'No image — the output settings live in the config head at 0x000A.');
    return;
  }

  const c = add(panel, el('div', 'card', ''));
  add(c, el('h2', '', 'Reakcje wyjść na CLIP:'));
  const dl = add(c, el('dl', 'dl out', ''));
  for (const n of [1, 2]) {
    add(dl, el('dt', '', `Tryb pracy wyjścia ${n}:`));
    const mode = add(dl, el('dd', 'mode', outBistabilny(image, n) ? 'bistabilny' : 'monostabilny'));
    add(dl, el('dd', '', '')); // the read-out column, empty while the output is bistabilny

    const dt = add(dl, el('dt', '', `Czas monostabilnej pracy ${n}:`));
    const time = add(dl, el('dd', 'time', showTenths(outTenths(image, n))));
    time.spellcheck = false;
    const read = add(dl, el('dd', 'read', showClock(outTenths(image, n))));
    TIME_ROWS.set(n, [dt, time, read]);
    READ_CELLS.set(n, read);
    OUT_CELLS.set(time, {n});
    paintTimeRow(n, image);
    markCell(time, outTenths(image, n) !== originTenths(n));

    mode.addEventListener('click', () => {
      const img = state.image;
      if (img === null) {
        return;
      }
      const now = !outBistabilny(img, n);
      writeOut(img, n, outTenths(img, n), now);
      mode.textContent = now ? 'bistabilny' : 'monostabilny';
      markCell(mode, now !== originBistabilny(n));
      paintTimeRow(n, img);
      renderFooter();
    });
    mode.addEventListener('dblclick', () => {
      const img = state.image;
      if (img === null) {
        return;
      }
      const want = originBistabilny(n);
      writeOut(img, n, outTenths(img, n), want);
      mode.textContent = want ? 'bistabilny' : 'monostabilny';
      markCell(mode, false);
      paintTimeRow(n, img);
      renderFooter();
    });

    time.addEventListener('dblclick', () => {
      const img = state.image;
      if (img === null || outBistabilny(img, n)) {
        return; // an inert row does nothing, exactly as it looks
      }
      const want = originTenths(n);
      writeOut(img, n, want, outBistabilny(img, n));
      time.textContent = showTenths(want);
      markCell(time, false);
      paintTimeRow(n, img);
      renderFooter();
    });
  }
  watchCells([dl], outMutations);
  note(
    panel,
    'Click a Tryb cell to flip it between bistabilny and monostabilny; type in a Czas cell to change ' +
      'the time, in seconds with one decimal — it is stored as tenths, so 5.0 s is 50. Double-click ' +
      'either to put the loaded value back. Both halves of a word are written together, so flipping ' +
      'the mode never disturbs the time and vice versa. A bistabilny output has no time, so its Czas ' +
      'row is greyed out and cannot be typed into; the vendor takes that field out of the form ' +
      'altogether, which makes its own card change height, while this one keeps the row in place so ' +
      'the layout never moves. The dimmed value is still what the image holds — only the gate ' +
      'ignores it while the output is bistabilny — and the dim text beside a time is the vendor\'s ' +
      'own read-out of the same value.',
  );

  renderEventGrid(panel, image, 'Reakcja wyjść na zdarzenia od wejść i przycisków:');
}

/**
 * The one table the vendor shows three times: `LV_ZdarzeniaAdmin` on tab 2, `LV_ReakcjeWejsc` on
 * tab 3 and `LV_ZdarzeniaWszystkie` on tab 5, which add `Nazwa abonenta` and `Nr telefonu`. They are
 * views over the same 300 rows, filtered by which events belong to the selected administrator, to
 * the inputs and buttons, and to everything. The filter is not decoded, so every view here shows
 * every used row.
 */
function renderEventGrid(panel: HTMLElement, image: Uint8Array, caption: string): void {
  const rows = readClipRows(image);
  const wrap = add(panel, el('div', 'table', ''));
  const table = add(wrap, el('table', '', ''));
  add(table, el('caption', '', caption));
  const head = add(table, el('thead', '', ''));
  row(
    head,
    'th',
    [
      ['th', 'Lp.'],
      ['th', 'u16 @+0'],
      ['th', 'u8 @+2'],
      ['th', 'u16 @+3'],
      ['th', 'Właściwości'],
    ],
  );
  const body = add(table, el('tbody', '', ''));
  for (const r of rows) {
    const tr = add(body, el('tr', '', ''));
    add(tr, el('td', 'num', String(r.poz).padStart(4, '0')));
    add(tr, el('td', 'raw', String(r.a)));
    add(tr, el('td', 'raw', String(r.b)));
    add(tr, el('td', 'raw', String(r.group)));
    const at = clipTextAt(r.poz);
    const text = add(tr, el('td', 'edit', r.text));
    text.setAttribute('contenteditable', 'true');
    text.spellcheck = false;
    CELL_SLOTS.set(text, {at, limit: CLIP_TEXT_LEN, phone: false, poz: 0});
    text.addEventListener('dblclick', () => resetCell(text, at, CLIP_TEXT_LEN, false, 0));
  }
  watchCells([body], cellMutations);
  note(
    panel,
    `The image holds ${rows.length} of ${CLIP_ROWS} event rows at 0x8CBF; a row is used when its ` +
      'u16 at +3 is neither 0 nor 0xFFFF, which is the test the vendor\'s own loader uses before it ' +
      'adds a row to the list. The 59 bytes at +5 are copied into the image verbatim, so that column ' +
      'is editable; the three numeric columns are printed as the raw values because their encoding ' +
      'is not decoded yet — the vendor draws them as „Zdarzenie" and „Reakcja", and inventing those ' +
      'labels here would be a guess.',
  );
}

/**
 * The vendor's own `LB_OpisAutotestu` caption on tab 4, verbatim from the DFM at 0x4FA33E
 * (a `0x14` long string, 276 bytes) with its `#13` turned into a newline. The misspellings are
 * the vendor's and are kept as they are.
 */
const AUTOTEST_CAPTION =
  'Reset czasu autotestu,\n' +
  'powinie odbyć sie, po zamontowaniu sterownika na obiekcie o godznie, ' +
  'o której mamy zamiar dostawać informacja o autoteście. Jest to ' +
  'przybliżona godzina odliczana co 24 godziny, ponieważ stwerownik nie ' +
  'mosiada własnego zeara czasu rzeczywistego.';

/**
 * Tab 4, `TS_Ustawienia`. The vendor's form is two group boxes side by side:
 *
 * * `GB_Hasla`, caption `Hasła:`, holding the labels `Hasło computer PC:` and `Hasło SMS:` above the
 *   two `TEdit` controls `E_PCHaslo` and `E_SMSHaslo`. Those are the payloads at `0x0011` (5 bytes)
 *   and `0x0016` (9), so they are editable here.
 * * `GB_ResetAutotestu`, caption `Ustawianie autotestu`, holding the button `BT_ResetCzasuAutotestu`
 *   and the centred label `LB_OpisAutotestu`, whose caption is the vendor's own explanation — kept
 *   here verbatim, its own misspellings included.
 *
 * The gate PIN is not one of the vendor's controls: the form has no PIN field, and the client only
 * reaches it through the image and the `0x81` status block. It stays editable, but in the config-head
 * card rather than pretending to be part of `Hasła:`.
 */
function renderSettings(panel: HTMLElement): void {
  const image = state.image;
  if (image === null) {
    note(panel, 'No image — the two hasles and the PIN live in the config head at 0x0000.');
    return;
  }

  const pair = add(panel, el('div', 'grids', ''));
  const hasla = add(pair, el('div', 'card', ''));
  add(hasla, el('h2', '', 'Hasła:'));
  const dl = add(hasla, el('dl', 'dl', ''));
  for (const f of ADMIN_FIELDS) {
    if (f.at === PIN_AT) {
      continue; // not a control in the vendor's Hasła: group box
    }
    add(dl, el('dt', '', f.label));
    const dd = add(dl, el('dd', 'edit', decodeCp1250(image, f.at, f.limit)));
    const at = f.at;
    const limit = f.limit;
    dd.setAttribute('contenteditable', 'true');
    dd.spellcheck = false;
    CELL_SLOTS.set(dd, {at, limit, phone: false, poz: 0});
    dd.addEventListener('dblclick', () => resetCell(dd, at, limit, false, 0));
    markCell(dd, decodeCp1250(image, at, limit) !== originText(at, limit));
  }
  watchCells([dl], cellMutations);
  note(
    hasla,
    'Type in a value to change it: the PC hasle is 5 bytes at 0x0011 and the SMS one 9 at 0x0016, ' +
      'which is the capacity of the vendor\'s own TEdit controls, so longer text is cut to fit. ' +
      'Double-click a marked value to put the loaded one back.',
  );

  const auto = add(pair, el('div', 'card', ''));
  add(auto, el('h2', '', 'Ustawianie autotestu'));
  const btn = add(auto, el('button', 'act', 'Reset czasu autotestu'));
  btn.setAttribute('data-todo', '');
  add(auto, el('p', 'quote', AUTOTEST_CAPTION));
  note(
    auto,
    'The button is the vendor\'s BT_ResetCzasuAutotestu: it sends the gate a new autotest anchor ' +
      'rather than changing a byte in the image, so this client has not implemented it. The text ' +
      'above is the vendor\'s own label, kept verbatim including its misspellings.',
  );

  const c = add(panel, el('div', 'card', ''));
  add(c, el('h2', '', 'Config head 0x0000–0x002F'));
  add(c, el('div', 'mono', hex(image, 0x00, 0x30)));
  add(c, el('p', 'note', 'image[0] is the capacity marker; the PIN the gate authenticates against ' +
    'is image[1..4], which the vendor has no control for — it is editable here because it is still ' +
    'a field of the image.'));
  const pinDl = add(c, el('dl', 'dl', ''));
  add(pinDl, el('dt', '', 'PIN (gate):'));
  const pin = add(pinDl, el('dd', 'edit', decodeCp1250(image, PIN_AT, PIN_LEN)));
  pin.setAttribute('contenteditable', 'true');
  pin.spellcheck = false;
  CELL_SLOTS.set(pin, {at: PIN_AT, limit: PIN_LEN, phone: false, poz: 0});
  pin.addEventListener('dblclick', () => resetCell(pin, PIN_AT, PIN_LEN, false, 0));
  markCell(pin, decodeCp1250(image, PIN_AT, PIN_LEN) !== originText(PIN_AT, PIN_LEN));
  watchCells([pinDl], cellMutations);

  if (state.regions !== null) {
    const wrap = add(panel, el('div', 'table', ''));
    const table = add(wrap, el('table', '', ''));
    add(table, el('caption', '', '0x83 region table — 21 × 24-bit little-endian dwords'));
    const head = add(table, el('thead', '', ''));
    row(head, 'th', [['th', '#'], ['th', 'Value'], ['th', 'Known landmark']]);
    const body = add(table, el('tbody', '', ''));
    for (let i = 0; i < REGION_TABLE_DWORDS && i < state.regions.length; i++) {
      row(body, 'td', [
        ['td.num', String(i)],
        ['td', addr24(state.regions[i])],
        ['td', LANDMARKS[i] ?? ''],
      ]);
    }
  }
}

function renderEvents(panel: HTMLElement): void {
  add(panel, card('zdarze', [['count', 'not readable over this window']]));
  note(
    panel,
    'The event/SMS log sits at 0xD7BE–0xDFFF, outside the transfer window [0x0001, ' +
      '0xD7BE). The vendor reaches it through another path; this client has not implemented that, ' +
      'so the table stays empty.',
  );
}

function renderGsm(panel: HTMLElement): void {
  if (state.status === null) {
    note(panel, 'No 0x81 status block yet — connect and read.');
    return;
  }
  const s = state.status;
  add(panel, card('Status block 0x81', [
    ['stateFlag', `0x${s.stateFlag.toString(16)}`],
    ['liveFlag', `0x${s.liveFlag.toString(16)}`],
    ['adminPin', s.adminPin],
    ['counter A', String(s.counterA)],
    ['counter B', String(s.counterB)],
    ['fixed field', addr24(s.fixedField)],
    ['image head', `0x${s.imageHead.toString(16)} (= image[0])`],
  ]));
  note(
    panel,
    'Only these byte positions ever change across captures. The vendor tab also shows modem state ' +
      '(PIN SIM, USSD, time sync) driven by the 0x90 push fields, which are not decoded yet — ' +
      'those rows are omitted rather than invented.',
  );
}

function renderMonitoring(panel: HTMLElement): void {
  const kpi = el('div', 'card', '');
  add(kpi, el('h2', '', 'live pushes'));
  add(kpi, el('div', 'kpi', String(state.pushes.length)));
  add(kpi, el('div', 'kpi small', 'every 2.000 s while subscribed'));
  add(panel, kpi);

  if (state.pushes.length > 0) {
    const c = add(panel, el('div', 'card', ''));
    add(c, el('h2', '', '0x90 push log (newest first)'));
    for (const f of state.pushes.slice(-12).reverse()) {
      add(c, el('div', 'mono', hex(f.raw, 0, 16)));
    }
  }
  note(panel, 'Bytes 1,2,3,4,6 vary across pushes; the field layout is not decoded, so pushes are shown raw.');
}

function renderNet(panel: HTMLElement): void {
  add(panel, card('Internet', [['NET/Winsock transport', 'not implemented']]));
  note(
    panel,
    'The second transport in the vendor client is a Winsock/TCP path whose framing additions were ' +
      'captured. Until they are known, this tab cannot be implemented honestly.',
  );
}

function renderSerwis(panel: HTMLElement): void {
  add(panel, card('Serwis', [
    ['WebHID', webHidAvailable() ? 'available' : 'not available in this browser'],
    ['device', session === null ? 'not connected' : 'connected'],
    ['image', state.image === null ? '—' : `${IMAGE_LEN} bytes`],
  ]));
  note(panel, 'Discovered HID devices — pin VID:PID once it is stable:');
  add(panel, el('div', 'mono', state.devices.join('\n')));
}

function renderUnknown(panel: HTMLElement): void {
  note(panel, 'This tab is not implemented.');
}

const PANELS: Record<string, (panel: HTMLElement) => void> = {
  abonents: renderAbonents,
  admin: renderAdmin,
  reakcje: renderReakcje,
  settings: renderSettings,
  events: renderEvents,
  gsm: renderGsm,
  monitoring: renderMonitoring,
  net: renderNet,
  serwis: renderSerwis,
};

// ---------------------------------------------------------------- actions strip

const actions = document.getElementById('actions') as HTMLElement;
const progressFill = add(add(actions, el('div', 'progress', '')), el('i', '', ''));

function actionButton(label: string, handler: () => void): void {
  const b = el('button', 'act', label);
  b.addEventListener('click', handler);
  add(actions, b);
}

function todoButton(label: string): void {
  add(actions, el('button', 'act', label)).setAttribute('data-todo', '');
}

/** The file input is the vendor's „Odczytajó z pliku" path. */
const fileInput = document.createElement('input');
fileInput.className = 'file';
fileInput.setAttribute('type', 'file');
fileInput.setAttribute('accept', '.bme');
add(actions, fileInput);
fileInput.addEventListener('change', () => {
  void loadFile();
});

function setProgress(fraction: number): void {
  progressFill.style.width = `${Math.round(fraction * 100)}%`;
  const src = document.getElementById('source');
  if (src !== null && fraction < 1) {
    src.textContent = `${progressLabel} … ${Math.round(fraction * 100)}%`;
  }
}

let progressLabel = 'Odczytano';

// ---------------------------------------------------------------- flows

async function readDevice(): Promise<void> {
  state.error = null;
  state.devices = await describeDevices();
  setState('read', 'Connecting…');
  try {
    const t = await connectWebHid();
    const s = new Session(t);
    device = t;
    session = s;
    setState('read', 'Connected');

    // The service password is a client-side bypass: this performs zero exchanges.
    if (!s.login(SERVICE_PASSWORD)) {
      fail('The gate rejected the session.');
      return;
    }
    state.status = await s.status();
    state.regions = await s.regions();

    progressLabel = 'Odczytano';
    setState('read', 'Reading…');
    state.image = await s.readWindow(setProgress);
    state.origin = Uint8Array.from(state.image as Uint8Array);
    state.source = 'Odczytano z sterownika.';
    repaint();
    setState('read', 'Device read');
  } catch (e) {
    fail(String(e));
  }
}

/**
 * The save paths ask before writing when the users region has gaps: holes there are blank rows the
 * vendor's own grid draws, and the head's bound stays past the last entry. The prompt is a card in
 * the page rather than a browser dialog — this is a PWA that has to keep working on a phone.
 */
let pendingSave: () => void = () => {};

function hidePrompt(): void {
  const host = document.getElementById('prompt');
  if (host !== null) {
    host.hidden = true;
    host.replaceChildren();
  }
}

function askCleanup(action: () => void): void {
  const host = document.getElementById('prompt');
  const img = state.image;
  if (host === null || img === null) {
    action();
    return;
  }
  pendingSave = action;
  host.hidden = false;
  host.replaceChildren();
  const gaps = countGaps(img);
  note(
    host,
    `The users region has ${gaps} empty slot${gaps === 1 ? '' : 's'} inside the entry bound, which ` +
      'writes as a blank row. Cleanup moves the entries down so there are no gaps and lowers the ' +
      'bound at 0x000F.',
  );
  const clean = el('button', 'act', 'Cleanup and save');
  clean.addEventListener('click', () => {
    const go = pendingSave;
    hidePrompt();
    if (state.image !== null) {
      compactAbonents(state.image);
    }
    repaint();
    go();
  });
  const asIs = el('button', 'act', 'Save as is');
  asIs.addEventListener('click', () => {
    const go = pendingSave;
    hidePrompt();
    go();
  });
  add(host, clean);
  add(host, asIs);
}

async function writeDevice(): Promise<void> {
  const s = session;
  const img = state.image;
  if (s === null || img === null) {
    fail('Nothing to write — read an image first.');
    return;
  }
  if (countGaps(img) > 0) {
    askCleanup(() => {
      void writeDeviceRaw();
    });
    return;
  }
  await writeDeviceRaw();
}

async function writeDeviceRaw(): Promise<void> {
  const s = session;
  if (s === null || state.image === null) {
    fail('Nothing to write — read an image first.');
    return;
  }
  state.error = null;
  progressLabel = 'Zapisano';
  setState('write', 'Writing…');
  try {
    await s.writeWindow(state.image, setProgress);
    state.source = 'Zapisano to sterownika.';
    if (state.image !== null) {
      state.origin = Uint8Array.from(state.image); // what the gate now holds is the new baseline
    }
    repaint();
    setState('write', 'Device written');
  } catch (e) {
    fail(e instanceof PageRejected ? `Page at 0x${e.addr.toString(16)} rejected` : String(e));
  }
}

async function loadFile(): Promise<void> {
  // `input[type=file].value` is only a `C:\fakepath\…` string — the chosen `File` lives on the
  // element's non-standard `files` property, which Chrome/Edge populate when the selection
  // `change` event fires. It is absent from the DOM typings, hence the local cast.
  const [picked] = (fileInput as unknown as { files: File[] }).files;
  if (picked === undefined) {
    fail('No file selected.');
    return;
  }
  try {
    const bytes = new Uint8Array(await picked.arrayBuffer());
    state.image = decodeBme(assertImageSize(bytes));
    state.origin = Uint8Array.from(state.image as Uint8Array);
    state.source = `Odczytano z pliku. (${picked.name})`;
    state.error = null;
    repaint();
  } catch (e) {
    fail(String(e));
  }
}

function saveFile(): void {
  const img = state.image;
  if (img === null) {
    fail('No image to save.');
    return;
  }
  if (countGaps(img) > 0) {
    askCleanup(saveFileRaw);
    return;
  }
  saveFileRaw();
}

function saveFileRaw(): void {
  if (state.image === null) {
    fail('No image to save.');
    return;
  }
  const encoded = encodeBme(state.image);
  const blob = new Blob([new Uint8Array(encoded)], { type: 'application/octet-stream' });
  const a = el('a', '', 'brama-memdump.bme');
  a.setAttribute('href', URL.createObjectURL(blob));
  a.setAttribute('download', 'brama-memdump.bme');
  add(actions, a);
}

/** Close the blank rows in the users region and lower the entry bound. */
function cleanup(): void {
  const img = state.image;
  if (img === null) {
    fail('No image loaded.');
    return;
  }
  compactAbonents(img);
  repaint();
}

/**
 * Add an entry, the way the vendor's own „Dodaj nwego abonenta" button does (`FUN_004D03A8`): it
 * appends at the end of the abonent array, so the new row always lands in the uŁytkownicy region.
 * The vendor fills in a placeholder phone (`+4866600NNNN`) when the user has not typed one; this
 * client only moves the bound, so the new row is **blank** and you type the phone into it.
 */
function addAbonent(): void {
  const img = state.image;
  if (img === null) {
    fail('No image loaded.');
    return;
  }
  const total = readTotal(img);
  if (total >= ABONENT_SLOTS) {
    fail('The phone book is full — all 1000 slots are used.');
    return;
  }
  writeTotal(img, total + 1);
  repaint();
}

async function toggleLive(): Promise<void> {
  const s = session;
  if (s === null) {
    fail('Connect first.');
    return;
  }
  try {
    if (state.live) {
      await s.unsubscribeLive();
      state.live = false;
      setState('read', 'Feed stopped');
    } else {
      await s.subscribeLive((f: Frame) => {
        state.pushes.push(f);
      });
      state.live = true;
      setState('live', 'Live feed on');
    }
  } catch (e) {
    fail(String(e));
  }
}

function disconnect(): void {
  const t = device;
  if (t !== null) {
    t.close();
  }
  session = null;
  device = null;
  state.live = false;
  setState('idle', 'Not connected');
}

// ---------------------------------------------------------------- wiring

/** The header status pill: a dot whose colour carries the state, plus text. */
function setState(kind: string, text: string): void {
  const pill = document.querySelector('.state');
  if (pill === null) {
    return;
  }
  pill.setAttribute('data-s', kind);
  const dot = pill.querySelector('i');
  if (dot !== null) {
    dot.setAttribute('data-s', kind);
  }
  const label = pill.querySelector('span');
  if (label !== null) {
    label.textContent = text;
  }
}

function fail(message: string): void {
  state.error = message;
  setState('error', message);
}

/** Tab switching: the active panel is the only one laid out. */
let currentTab = '';

function showPanel(id: string): void {
  currentTab = id;
  const panels = document.getElementById('panels');
  if (panels === null) {
    return;
  }
  const list = panels.querySelectorAll('.panel');
  for (let i = 0; i < list.length; i++) {
    const p = list[i] as HTMLElement;
    const active = p.getAttribute('data-panel') === id;
    p.hidden = !active;
    if (active) {
      beginPaint();
      gridScroll = [];
      const painted = p.querySelectorAll('.table');
      for (let k = 0; k < painted.length; k++) {
        const w = painted[k] as HTMLElement;
        const span = w.scrollHeight - w.clientHeight;
        gridScroll.push(span > 0 ? w.scrollTop / span : 0);
      }
      p.replaceChildren();
      const render = PANELS[id];
      if (render !== undefined) {
        render(p);
      }
    }
  }
  renderFooter();
}

/** Repaint the panel that is showing — state changes must not wait for a tab click. */
function repaint(): void {
  showPanel(currentTab);
}

/** Footer strip, mirroring the vendor's „Odczytano z pliku." + counters. */
function renderFooter(): void {
  const src = document.getElementById('source');
  if (src !== null) {
    src.textContent = state.error ?? (edited() ? `${state.source} · edited` : state.source);
    src.setAttribute('class', state.error === null ? 'src' : 'bad');
  }
  const ab = document.getElementById('abonents');
  if (ab !== null) {
    if (state.image === null) {
      ab.textContent = `abonenci: –/${ABONENT_SLOTS}`;
    } else {
      const c = countGroups(state.image);
      ab.textContent =
        `abonenci: ${countAbonents(state.image)}/${ABONENT_SLOTS} · ` +
        `administratorzy ${c.admins}/${ADMIN_SLOTS} · uŁytkownicy ${c.users}`;
    }
  }
  const ev = document.getElementById('events');
  if (ev !== null) {
    ev.textContent = 'zdarze: –/300';
  }
}

const nav = document.querySelector('.tabs');
if (nav !== null) {
  const buttons = nav.querySelectorAll('.tab');
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i] as HTMLElement;
    b.addEventListener('click', () => {
      for (let k = 0; k < buttons.length; k++) {
        const other = buttons[k] as HTMLElement;
        if (other === b) {
          other.setAttribute('aria-current', 'true');
        } else {
          other.removeAttribute('aria-current');
        }
      }
      showPanel(b.getAttribute('data-tab') ?? '');
    });
  }
}

actionButton('Odczyt from device', () => {
  void readDevice();
});
actionButton('Zapis to device', () => {
  void writeDevice();
});
actionButton('Monitoring', () => {
  void toggleLive();
});
actionButton('Rozlacz', disconnect);
actionButton('Save .bme', saveFile);
actionButton('Cleanup gaps', cleanup);
todoButton('Zdarzenia (other path)');
todoButton('Internet');

/** Initial paint: the vendor's first tab, like the original app opens. */
showPanel('abonents');

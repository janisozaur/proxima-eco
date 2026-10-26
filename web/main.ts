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
  Abonent,
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
  readAbonents,
  readAdminInfo,
  readTotal,
  countGroups,
  countAbonents,
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
 * thousand-slot arrays; the split is the count the config head keeps at `0x0E`.
 *
 * Cells are editable in place: the phone and name cells are `contenteditable` and a mutation
 * writes them straight back into the image slot, while a click on a checkbox cell toggles the
 * flag bit — the same gesture the vendor's `TGridClickHandler` performs.
 */
const CELL_SLOTS = new Map<HTMLElement, { at: number; limit: number }>();
const FLAG_CELLS = new Map<HTMLElement, { at: number; bit: number }>();

function paintFlag(cell: HTMLElement, on: boolean): void {
  cell.className = on ? 'td.flagOn' : 'td.flagOff';
  cell.textContent = on ? '✓' : '';
}

/** Outline a cell whose value no longer matches the image exactly as it was loaded. */
function markCell(cell: HTMLElement, on: boolean): void {
  const parts = cell.className.split(' ').filter((c) => c !== 'dirty');
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

/** One observer for whichever grids are currently painted; re-rendering replaces it. */
let cellObserver: MutationObserver | null = null;

function renderAbonents(panel: HTMLElement): void {
  const image = state.image;
  if (image === null) {
    note(panel, 'No image — read the gate or open a .bme file.');
    return;
  }

  // the cells this render owns; stale entries from a previous paint must not be edited into
  CELL_SLOTS.clear();
  FLAG_CELLS.clear();
  const previous: MutationObserver | null = cellObserver;
  if (previous !== null) {
    previous.disconnect();
  }
  cellObserver = null;

  const rows = readAbonents(image);
  const groups: [string, Abonent[]][] = [
    ['Abonenci - uŁytkownicy reakcja na CLIP:', rows.filter((a) => !a.admin)],
    ['Abonenci - administratorzy - reakcja na CLIP :', rows.filter((a) => a.admin)],
  ];
  const bodies: HTMLElement[] = [];
  for (const [title, list] of groups) {
    if (list.length === 0) {
      continue;
    }
    const wrap = add(panel, el('div', 'table', ''));
    const table = add(wrap, el('table', '', ''));
    add(table, el('caption', '', title));
    const head = add(table, el('thead', '', ''));
    row(head, 'th', [['th', 'Poz.'], ['th', 'Telefon'], ['th', 'Nazwa'], ['th', 'Wyjście 1'], ['th', 'Wyjście 2']]);
    const body = add(table, el('tbody', '', ''));
    bodies.push(body);

    for (const a of list) {
      const tr = add(body, el('tr', '', ''));
      add(tr, el('td', 'num', String(a.poz).padStart(4, '0')));
      const phone = add(tr, el('td', 'phone', a.phone));
      const name = add(tr, el('td', 'edit', a.name));
      const slots: [HTMLElement, number, number][] = [
        [phone, PHONE_BASE + (a.poz - 1) * PHONE_SLOT, PHONE_MAX],
        [name, NAME_BASE + (a.poz - 1) * NAME_SLOT, NAME_MAX],
      ];
      for (const [cell, at, limit] of slots) {
        cell.setAttribute('contenteditable', 'true');
        cell.setAttribute('spellcheck', 'false');
        CELL_SLOTS.set(cell, { at, limit });
        markCell(cell, decodeCp1250(image, at, limit) !== originText(at, limit));
        cell.addEventListener('dblclick', () => {
          const img = state.image;
          if (img === null) {
            return;
          }
          const back = originText(at, limit);
          encodeCp1250(img, at, limit, back);
          cell.textContent = back;
          markCell(cell, false);
          renderFooter();
        });
      }
      const flags: [[number, boolean], [number, boolean]] = [[WYJ1_BIT, a.wyj1], [WYJ2_BIT, a.wyj2]];
      for (const [bit, on] of flags) {
        const cell = add(tr, el('td', 'flagOff', ''));
        paintFlag(cell, on);
        const at = FLAG_BASE + (a.poz - 1);
        FLAG_CELLS.set(cell, { at, bit });
        markCell(cell, on !== originFlag(at, bit));
        cell.addEventListener('click', () => {
          const img = state.image;
          if (img === null) {
            return;
          }
          const now = (img[at] & bit) === 0;
          img[at] = (now ? img[at] | bit : img[at] & ~bit) & 0xff;
          paintFlag(cell, now);
          markCell(cell, now !== originFlag(at, bit));
          renderFooter();
        });
        cell.addEventListener('dblclick', () => {
          const img = state.image;
          if (img === null) {
            return;
          }
          const want = originFlag(at, bit);
          img[at] = (want ? img[at] | bit : img[at] & ~bit) & 0xff;
          paintFlag(cell, want);
          markCell(cell, false);
          renderFooter();
        });
      }
    }
  }

  const obs = new MutationObserver((ms) => {
    if (state.image === null) {
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
      encodeCp1250(state.image, slot.at, slot.limit, cell.textContent);
      touched = true;
      markCell(cell, decodeCp1250(state.image, slot.at, slot.limit) !== originText(slot.at, slot.limit));
    }
    if (touched) {
      renderFooter();
    }
  });
  const watch = {childList: true, characterData: true, subtree: true};
  for (const b of bodies) {
    obs.observe(b, watch);
  }
  cellObserver = obs;

  note(
    panel,
    'Type in a Telefon / Nazwa cell to change it, click a Wyjście cell to toggle it, double-click a ' +
      'marked cell to put the loaded value back. „Zapis to device" or „Save .bme" carries the change.',
  );
  const total = readTotal(image);
  note(
    panel,
    `The phone book is two fixed regions: slots 0001…${String(ADMIN_SLOTS).padStart(4, '0')} are the ` +
      `„administratorzy" grid (${ADMIN_SLOTS} slots, some unpopulated) and 0017… are „uŁytkownicy"; ` +
      `the head keeps the entry bound ${total} at 0x000F.`,
  );
}

function renderAdmin(panel: HTMLElement): void {
  if (state.image === null) {
    note(panel, 'No image — the admin PINs live in the config head at 0x0000.');
    return;
  }
  const a = readAdminInfo(state.image);
  add(panel, card('Info admin.', [
    ['PIN (gate)', a.devicePin],
    ['Hasło computer PC', a.pcPassword],
    ['Hasło SMS', a.smsPassword],
  ]));
  if (state.status !== null) {
    add(panel, card('From the 0x81 status block', [['adminPin', state.status.adminPin]]));
  }
  note(
    panel,
    'The PIN at image[1..4] is what the gate authenticates against; the strings at 0x11 and 0x16 ' +
      'are the PC and SMS passwords. Nothing is ever sent anywhere else.',
  );
}

function renderReakcje(panel: HTMLElement): void {
  add(panel, card('Clip i Wej->Wyj', [
    ['Reakcje wyjść na CLIP', 'not decoded'],
    ['Tryb pracy wyjście 1', 'not decoded'],
    ['Tryb pracy wyjście 2', 'not decoded'],
    ['Czas monostabilnej pracy', 'not decoded'],
  ]));
  note(
    panel,
    'These switches live in the config head (0x000B–0x00B2, a field of 0x03 markers). Their ' +
      'encoding has not been decoded, so the tab lists the fields without values.',
  );
}

function renderSettings(panel: HTMLElement): void {
  if (state.image !== null) {
    const c = add(panel, el('div', 'card', ''));
    add(c, el('h2', '', 'Config head 0x0000–0x002F'));
    add(c, el('div', 'mono', hex(state.image, 0x00, 0x30)));
    add(c, el('p', 'note', 'image[0] = 0x07 is the capacity marker; image[1..4] is the PIN.'));
  }
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
  if (state.image === null && state.regions === null) {
    note(panel, 'No image and no region table yet.');
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

async function writeDevice(): Promise<void> {
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
todoButton('Zdarzenia (other path)');
todoButton('Internet');

/** Initial paint: the vendor's first tab, like the original app opens. */
showPanel('abonents');

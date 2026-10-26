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
import { ABONENT_SLOTS, readAbonents, readAdminInfo, countAbonents } from '../src/abonents.ts';
import type { Transport } from '../src/transport.ts';
import type { Frame, Status } from '../src/protocol.ts';

// ---------------------------------------------------------------- state

interface State {
  image: Uint8Array | null;
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
  status: null,
  regions: null,
  pushes: [],
  devices: [],
  source: 'No image loaded.',
  error: null,
  live: false,
};

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

function renderAbonents(panel: HTMLElement): void {
  const n = state.image === null ? 0 : countAbonents(state.image);
  const kpi = el('div', 'card', '');
  add(kpi, el('h2', '', 'abonenci'));
  add(kpi, el('div', 'kpi', `${n}/${ABONENT_SLOTS}`));
  add(panel, kpi);

  if (state.image === null) {
    note(panel, 'No image — read the gate or open a .bme file.');
    return;
  }

  const rows = readAbonents(state.image);
  const wrap = add(panel, el('div', 'table', ''));
  const table = add(wrap, el('table', '', ''));
  add(table, el('caption', '', 'Uzytkownicy reakcja na CLIP:'));
  const head = add(table, el('thead', '', ''));
  row(head, 'th', [['th', 'Poz.'], ['th', 'Telefon'], ['th', 'Nazwa'], ['th', 'Wyjście 1'], ['th', 'Wyjście 2']]);
  const body = add(table, el('tbody', '', ''));
  for (const a of rows) {
    row(body, 'td', [
      ['td.num', String(a.poz)],
      ['td.phone', a.phone],
      ['td', a.name],
      [a.wyj1 ? 'td.flagOn' : 'td.flagOff', a.wyj1 ? '✓' : ''],
      [a.wyj2 ? 'td.flagOn' : 'td.flagOff', a.wyj2 ? '✓' : ''],
    ]);
  }
  note(
    panel,
    'Wyjście 1 / Wyjście 2 are bit 0 and bit 1 of the flag byte at 0x001F + poz − 1, one of a ' +
      'contiguous thousand-byte array that ends right where the phone table begins at 0x0407.',
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
    state.source = 'Odczytano z sterownika.';
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
    setState('write', 'Device written');
  } catch (e) {
    fail(e instanceof PageRejected ? `Page at 0x${e.addr.toString(16)} rejected` : String(e));
  }
}

async function loadFile(): Promise<void> {
  // A file input's `value` is a `File` at runtime, not the declared `string`.
  const picked = fileInput.value as unknown as File;
  try {
    const bytes = new Uint8Array(await picked.arrayBuffer());
    state.image = decodeBme(assertImageSize(bytes));
    state.source = `Odczytano z pliku. (${picked.name})`;
    state.error = null;
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
function showPanel(id: string): void {
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

/** Footer strip, mirroring the vendor's „Odczytano z pliku." + counters. */
function renderFooter(): void {
  const src = document.getElementById('source');
  if (src !== null) {
    src.textContent = state.error ?? state.source;
    src.setAttribute('class', state.error === null ? 'src' : 'bad');
  }
  const ab = document.getElementById('abonents');
  if (ab !== null) {
    const n = state.image === null ? '–' : String(countAbonents(state.image));
    ab.textContent = `abonenci: ${n}/${ABONENT_SLOTS}`;
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

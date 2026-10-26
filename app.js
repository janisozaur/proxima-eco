// src/protocol.ts
var REPORT_LEN = 64;
var IMAGE_LEN = 131072;
var CHUNK_LEN = 56;
var WINDOW_START = 1;
var WINDOW_END = 55230;
var FLUSH_ADDR = 131072;
var LOGIN_MAX_LEN = 8;
var CMD_STATUS = 1;
var CMD_REGIONS = 3;
var CMD_READ = 6;
var CMD_LIVE = 12;
var CMD_LOGIN = 15;
var CMD_WRITE = 134;
var CMD_PUSH = 144;
function responseOf(request) {
  return request | 128;
}
function isResponseOf(request, response) {
  return response === (request | 128);
}
function encodeFrame(opcode, body = new Uint8Array(0)) {
  if (opcode < 0 || opcode > 255) {
    throw new RangeError(`opcode out of range: 0x${opcode.toString(16)}`);
  }
  if (body.length > REPORT_LEN - 1) {
    throw new RangeError(`body too long: ${body.length} > ${REPORT_LEN - 1}`);
  }
  const out = new Uint8Array(REPORT_LEN);
  out[0] = opcode;
  for (let i = 0; i < body.length; i++) {
    out[1 + i] = body[i];
  }
  return out;
}
function decodeFrame(bytes) {
  if (bytes.length !== REPORT_LEN) {
    throw new RangeError(`report must be ${REPORT_LEN} bytes, got ${bytes.length}`);
  }
  return { opcode: bytes[0], body: bytes.subarray(1), raw: bytes };
}
function put24(target, at, value) {
  if (value < 0 || value > 16777215) {
    throw new RangeError(`address out of 24-bit range: 0x${value.toString(16)}`);
  }
  target[at] = value & 255;
  target[at + 1] = value >> 8 & 255;
  target[at + 2] = value >> 16 & 255;
}
function get24(source, at) {
  return source[at] | source[at + 1] << 8 | source[at + 2] << 16;
}
function encodePage(addr, count, data) {
  if (count > CHUNK_LEN) {
    throw new RangeError(`page count exceeds the measured maximum: ${count} > ${CHUNK_LEN}`);
  }
  if (data && data.length < count) {
    throw new RangeError(`data shorter than declared count: ${data.length} < ${count}`);
  }
  const out = new Uint8Array(4 + count);
  put24(out, 0, addr);
  out[3] = count;
  if (data) {
    for (let i = 0; i < count; i++) {
      out[4 + i] = data[i];
    }
  }
  return out;
}
function decodePage(body) {
  const addr = get24(body, 0);
  const count = body[3];
  return { addr, count, data: body.subarray(4, 4 + count) };
}
function readPlan(start = WINDOW_START, end = WINDOW_END) {
  const addrs = [];
  for (let addr = start; addr < end; addr += CHUNK_LEN) {
    addrs.push(addr);
  }
  return addrs;
}
function writeCount(addr, end = WINDOW_END) {
  return Math.min(CHUNK_LEN, end - addr);
}
var REGION_TABLE_DWORDS = 21;
function decodeRegions(f) {
  const out = [];
  for (let i = 0; i < REGION_TABLE_DWORDS; i++) {
    out.push(get24(f.raw, 1 + 3 * i));
  }
  return out;
}
function decodeStatus(f) {
  const frame = f.raw;
  return {
    raw: frame,
    stateFlag: frame[1],
    liveFlag: frame[4],
    adminPin: ascii(frame, 9, 4),
    counterA: frame[19] | frame[20] << 8,
    counterB: frame[22] | frame[23] << 8,
    fixedField: frame[24] | frame[25] << 8,
    imageHead: frame[34]
  };
}
function encodeLoginBody(password) {
  const bytes = new Uint8Array(LOGIN_MAX_LEN);
  let n = 0;
  for (const ch of password) {
    const code = ch.charCodeAt(0);
    if (code > 255) {
      throw new RangeError(`login password must be 8-bit: ${JSON.stringify(password)}`);
    }
    if (n >= LOGIN_MAX_LEN) {
      throw new RangeError(`login password longer than ${LOGIN_MAX_LEN} characters`);
    }
    bytes[n++] = code;
  }
  return bytes;
}
function loginAccepted(f) {
  return f.raw[1] !== 0;
}
function encodeLiveBody(subscribe) {
  return new Uint8Array([subscribe ? 1 : 0]);
}
function copyInto(target, at, src) {
  const n = Math.min(src.length, target.length - at);
  for (let i = 0; i < n; i++) {
    target[at + i] = src[i];
  }
}
function ascii(frame, at, len) {
  let s = "";
  for (let i = at; i < at + len; i++) {
    s += String.fromCharCode(frame[i]);
  }
  return s;
}

// src/session.ts
var SERVICE_PASSWORD = "SERWIS75";
var PageRejected = class extends Error {
  addr;
  constructor(addr) {
    super();
    this.addr = addr;
    this.message = `page at 0x${addr.toString(16)} was rejected (read-back did not match)`;
  }
};
var Session = class {
  t;
  constructor(t) {
    this.t = t;
  }
  /** Returns true when the gate accepts. `SERVICE_PASSWORD` never contacts the gate. */
  async login(password) {
    if (password === SERVICE_PASSWORD) {
      return true;
    }
    const f = await this.t.request(CMD_LOGIN, encodeLoginBody(password));
    expect(f, CMD_LOGIN);
    return loginAccepted(f);
  }
  async status() {
    const f = await this.t.request(CMD_STATUS);
    expect(f, CMD_STATUS);
    return decodeStatus(f);
  }
  async regions() {
    const f = await this.t.request(CMD_REGIONS);
    expect(f, CMD_REGIONS);
    return decodeRegions(f);
  }
  /**
   * Bulk read. The measured loop always requests a full page, so the final page overshoots the
   * window end; the device clamps it and echoes the requested address back. `onPage` is called
   * after each page lands, which is what lets the UI draw the vendor's „Odczytano %s %3.0f%s"
   * progress bar.
   */
  async readWindow(onPage) {
    const image = new Uint8Array(IMAGE_LEN);
    const plan = readPlan();
    for (let i = 0; i < plan.length; i++) {
      const addr = plan[i];
      const f = await this.t.request(CMD_READ, encodePage(addr, CHUNK_LEN));
      expect(f, CMD_READ);
      const p = decodePage(f.body);
      if (p.addr !== addr) {
        throw new Error(
          `read reply echoed 0x${p.addr.toString(16)} for page 0x${addr.toString(16)}`
        );
      }
      copyInto(image, addr, p.data);
      onPage?.(i + 1, plan.length);
    }
    return image;
  }
  /**
   * Bulk write. Measured order is write page → read-back verify, per page, then the end-of-image
   * marker. A page whose read-back differs was rejected by the firmware.
   */
  async writeWindow(image, onPage) {
    const plan = readPlan();
    for (let i = 0; i < plan.length; i++) {
      const addr = plan[i];
      const count = writeCount(addr);
      const data = image.subarray(addr, addr + count);
      const w = await this.t.request(CMD_WRITE, encodePage(addr, count, data));
      expect(w, CMD_WRITE);
      const r = await this.t.request(CMD_READ, encodePage(addr, count));
      expect(r, CMD_READ);
      const p = decodePage(r.body);
      for (let k = 0; k < count; k++) {
        if (p.data[k] !== data[k]) {
          throw new PageRejected(addr);
        }
      }
      onPage?.(i + 1, plan.length);
    }
    const marker = await this.t.request(CMD_WRITE, encodePage(FLUSH_ADDR, 0));
    expect(marker, CMD_WRITE);
  }
  async subscribeLive(handler) {
    this.t.onPush({ handle: handler });
    const f = await this.t.request(CMD_LIVE, encodeLiveBody(true));
    expect(f, CMD_LIVE);
  }
  async unsubscribeLive() {
    const f = await this.t.request(CMD_LIVE, encodeLiveBody(false));
    expect(f, CMD_LIVE);
  }
};
function expect(f, request) {
  if (!isResponseOf(request, f.opcode)) {
    throw new Error(
      `expected response 0x${responseOf(request).toString(16)}, got 0x${f.opcode.toString(16)}`
    );
  }
}

// src/webhid.ts
var NO_REPORT_ID = 0;
var WebHidTransport = class {
  device;
  handlers = [];
  constructor(device2) {
    this.device = device2;
  }
  request(opcode, body) {
    return this.exchange(opcode, body ?? new Uint8Array(0));
  }
  async exchange(opcode, body) {
    this.device.send(NO_REPORT_ID, encodeFrame(opcode, body));
    for (; ; ) {
      const f = decodeFrame(await this.device.receive());
      if (f.opcode === CMD_PUSH) {
        for (const h of this.handlers) {
          h.handle(f);
        }
        continue;
      }
      if (!isResponseOf(opcode, f.opcode)) {
        throw new Error(
          `unexpected response 0x${f.opcode.toString(16)} for 0x${opcode.toString(16)}`
        );
      }
      return f;
    }
  }
  onPush(handler) {
    this.handlers.push(handler);
  }
  /** Which device this transport is open on, so the app can show its VID:PID. */
  get identity() {
    return {
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      maxMessageSize: this.device.maxMessageSize,
      maxReportsCount: this.device.maxReportsCount
    };
  }
  close() {
    this.device.close();
  }
};
var PINNED_FILTERS = [];
async function connectWebHid(options = {}) {
  const hid = navigator.hid;
  if (hid === void 0) {
    throw new Error("WebHID is not available in this browser");
  }
  const filters = options.filters ?? PINNED_FILTERS;
  const devices = await hid.requestDevice({ filters });
  if (devices.length === 0) {
    throw new Error("no HID device matched");
  }
  const gate = devices.find((d) => d.maxMessageSize === REPORT_LEN) ?? devices[0];
  return new WebHidTransport(gate);
}
async function describeDevices() {
  const hid = navigator.hid;
  if (hid === void 0) {
    return [];
  }
  const devices = await hid.requestDevice({ filters: [] });
  return devices.map((d) => ({
    vendorId: d.vendorId,
    productId: d.productId,
    maxMessageSize: d.maxMessageSize,
    maxReportsCount: d.maxReportsCount
  }));
}
function formatIdentity(d) {
  return `VID 0x${hex4(d.vendorId)} (${d.vendorId}) \xB7 PID 0x${hex4(d.productId)} (${d.productId}) \xB7 ${d.maxMessageSize}-byte reports`;
}
function filterLiteral(d) {
  return `{ vendorId: 0x${hex4(d.vendorId)}, productId: 0x${hex4(d.productId)} }`;
}
function hex4(n) {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

// src/capability.ts
function webHidAvailable() {
  const nav2 = typeof navigator === "undefined" ? void 0 : navigator;
  return nav2?.hid != null;
}

// src/bme.ts
var KEY = [74, 204, 150, 158];
function keyIndex(plainByte) {
  return plainByte & 1 | (plainByte & 32) >> 4;
}
function rotl(x, n) {
  return (x << n | x >> 8 - n) & 255;
}
function rotr(x, n) {
  return (x >> n | x << 8 - n) & 255;
}
function encodeBme(image) {
  const out = new Uint8Array(image.length);
  for (let i = 0; i < image.length; i++) {
    const p = image[i];
    out[i] = rotl(p ^ KEY[keyIndex(p)], 1);
  }
  return out;
}
function decodeBme(file) {
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
function assertImageSize(bytes) {
  if (bytes.length !== IMAGE_LEN) {
    throw new RangeError(`expected ${IMAGE_LEN} bytes, got ${bytes.length}`);
  }
  return bytes;
}

// src/cp1250.ts
var HIGH = "\u20AC\uFFFD\u201A\uFFFD\u201E\u2026\u2020\u2021\uFFFD\u2030\u0160\u2039\u015A\u0164\u017D\u0179\uFFFD\u2018\u2019\u201C\u201D\u2022\u2013\u2014\uFFFD\u2122\u0161\u203A\u015B\u0165\u017E\u017A\xA0\u02C7\u02D8\u0141\xA4\u0104\xA6\xA7\xA8\xA9\u015E\xAB\xAC\xAD\xAE\u017B\xB0\xB1\u02DB\u0142\xB4\xB5\xB6\xB7\xB8\u0105\u015F\xBB\u013D\u02DD\u013E\u017C\u0154\xC1\xC2\u0102\xC4\u0139\u0106\xC7\u010C\xC9\u0118\xCB\u011A\xCD\xCE\u010E\u0110\u0143\u0147\xD3\xD4\u0150\xD6\xD7\u0158\u016E\xDA\u0170\xDC\xDD\u0162\xDF\u0155\xE1\xE2\u0103\xE4\u013A\u0107\xE7\u010D\xE9\u0119\xEB\u011B\xED\xEE\u010F\u0111\u0144\u0148\xF3\xF4\u0151\xF6\xF7\u0159\u016F\xFA\u0171\xFC\xFD\u0163\u02D9";
function decodeByte(byte) {
  if (byte < 128) {
    return String.fromCharCode(byte);
  }
  const ch = HIGH[byte - 128];
  return ch === "\uFFFD" ? "\uFFFD" : ch;
}
function decodeCp1250(bytes, at, limit) {
  let out = "";
  for (let i = at; i < at + limit && i < bytes.length && bytes[i] !== 0; i++) {
    out += decodeByte(bytes[i]);
  }
  return out;
}
var HIGH_CODE = [...HIGH].map((ch) => ch.charCodeAt(0));
function encodeByte(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) {
    return code;
  }
  const i = HIGH_CODE.indexOf(code);
  return i < 0 ? 63 : i + 128;
}
function unencodable(text) {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 128 && HIGH_CODE.indexOf(code) < 0) {
      return ch;
    }
  }
  return "";
}
function encodeCp1250(bytes, at, limit, text) {
  let n = 0;
  for (; n < limit && n < text.length; n++) {
    bytes[at + n] = encodeByte(text[n]);
  }
  for (let i = n; i < limit; i++) {
    bytes[at + i] = 0;
  }
  return n;
}

// src/abonents.ts
var FLAG_BASE = 31;
var ABONENT_SLOTS = 1e3;
var PHONE_BASE = 1031;
var PHONE_SLOT = 19;
var PHONE_MAX = 18;
var NAME_BASE = 20031;
var NAME_SLOT = 16;
var NAME_MAX = 15;
var WYJ1_BIT = 1;
var WYJ2_BIT = 2;
var ADMIN_SLOTS = 16;
var TOTAL_COUNT_AT = 15;
function readTotal(image) {
  return image[TOTAL_COUNT_AT] | image[TOTAL_COUNT_AT + 1] << 8;
}
function countGroups(image) {
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
  return { admins, users };
}
function readAbonents(image) {
  const out = [];
  for (let k = 0; k < ABONENT_SLOTS; k++) {
    const phone = decodeCp1250(image, PHONE_BASE + k * PHONE_SLOT, PHONE_MAX);
    if (phone === "") {
      continue;
    }
    const flag = image[FLAG_BASE + k];
    out.push({
      poz: k + 1,
      phone,
      name: decodeCp1250(image, NAME_BASE + k * NAME_SLOT, NAME_MAX),
      wyj1: (flag & WYJ1_BIT) !== 0,
      wyj2: (flag & WYJ2_BIT) !== 0,
      admin: k < ADMIN_SLOTS
    });
  }
  return out;
}
function writeAbonentPhone(image, poz, phone) {
  encodeCp1250(image, PHONE_BASE + (poz - 1) * PHONE_SLOT, PHONE_MAX, phone);
}
function writeAbonentName(image, poz, name) {
  encodeCp1250(image, NAME_BASE + (poz - 1) * NAME_SLOT, NAME_MAX, name);
}
function clearAbonent(image, poz) {
  writeAbonentPhone(image, poz, "");
  writeAbonentName(image, poz, "");
  image[FLAG_BASE + (poz - 1)] = 0;
}
function lastOccupied(image) {
  for (let k = ABONENT_SLOTS; k >= 1; k--) {
    if (image[PHONE_BASE + (k - 1) * PHONE_SLOT] !== 0) {
      return k;
    }
  }
  return 0;
}
function writeTotal(image, total) {
  image[TOTAL_COUNT_AT] = total & 255;
  image[TOTAL_COUNT_AT + 1] = total >> 8 & 255;
}
function countGaps(image) {
  const total = Math.min(ABONENT_SLOTS, readTotal(image));
  let gaps = 0;
  for (let k = ADMIN_SLOTS + 1; k <= total; k++) {
    if (image[PHONE_BASE + (k - 1) * PHONE_SLOT] === 0) {
      gaps += 1;
    }
  }
  return gaps;
}
function compactAbonents(image) {
  const total = Math.min(ABONENT_SLOTS, readTotal(image));
  const kept = [];
  for (let k = ADMIN_SLOTS + 1; k <= total; k++) {
    if (image[PHONE_BASE + (k - 1) * PHONE_SLOT] !== 0) {
      kept.push(k);
    }
  }
  const gaps = total - ADMIN_SLOTS - kept.length;
  if (gaps === 0) {
    return 0;
  }
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
function copySlot(image, at, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    image[at + i] = bytes[i];
  }
}
function countAbonents(image) {
  let n = 0;
  for (let k = 0; k < ABONENT_SLOTS; k++) {
    if (image[PHONE_BASE + k * PHONE_SLOT] !== 0) {
      n++;
    }
  }
  return n;
}
var PIN_AT = 1;
var PIN_LEN = 4;
var PC_AT = 17;
var PC_LEN = 5;
var SMS_AT = 22;
var SMS_LEN = 9;
var ADMIN_FIELDS = [
  { label: "PIN (gate)", at: PIN_AT, limit: PIN_LEN },
  { label: "Has\u0142o komputer PC:", at: PC_AT, limit: PC_LEN },
  { label: "Has\u0142o SMS:", at: SMS_AT, limit: SMS_LEN }
];
var OUT1_AT = 10;
var OUT2_AT = 12;
var OUT_TENTHS_MAX = 32767;
var OUT_BISTABILNY = 32768;
function outTenths(image, n) {
  const at = n === 1 ? OUT1_AT : OUT2_AT;
  return (image[at] | image[at + 1] << 8) & OUT_TENTHS_MAX;
}
function outBistabilny(image, n) {
  const at = n === 1 ? OUT1_AT : OUT2_AT;
  return (image[at + 1] & OUT_BISTABILNY >> 8) !== 0;
}
function writeOut(image, n, tenths, bistabilny) {
  const at = n === 1 ? OUT1_AT : OUT2_AT;
  const t = tenths < 0 ? 0 : tenths > OUT_TENTHS_MAX ? OUT_TENTHS_MAX : tenths;
  image[at] = t & 255;
  image[at + 1] = t >> 8 & 127 | (bistabilny ? 128 : 0);
}
var CLIP_AT = 36031;
var CLIP_ROWS = 300;
var CLIP_ROW = 64;
var CLIP_TEXT_AT = 5;
var CLIP_TEXT_LEN = 59;
function readClipRows(image) {
  const out = [];
  for (let r = 0; r < CLIP_ROWS; r++) {
    const at = CLIP_AT + r * CLIP_ROW;
    const group = image[at + 3] | image[at + 4] << 8;
    if (group === 0 || group === 65535) {
      continue;
    }
    out.push({
      poz: r + 1,
      at,
      a: image[at] | image[at + 1] << 8,
      b: image[at + 2],
      group,
      text: decodeCp1250(image, at + CLIP_TEXT_AT, CLIP_TEXT_LEN)
    });
  }
  return out;
}
function clipTextAt(poz) {
  return CLIP_AT + (poz - 1) * CLIP_ROW + CLIP_TEXT_AT;
}
var EVENT_INPUT_KINDS = [
  "Podanie masy na wej\u015Bcie %d",
  "Podanie plusa na wej\u015Bcie %d",
  "Zanik masy na wej\u015Bciu %d",
  "Zanik plusa na wej\u015Bciu %d",
  "Zmiana z masy na plusa na wej\u015Bciu %d",
  "Zmiana z plusa na mas\u0119 na wej\u015Bciu %d"
];
function eventCaption(image, id) {
  if (id === 1) {
    return "Reset modu\u0142u GSM";
  }
  if (id >= 2 && id <= 13) {
    const kind = EVENT_INPUT_KINDS[(id - 2) % 6];
    return kind.replace("%d", String(1 + Math.floor((id - 2) / 6)));
  }
  if (id === 14 || id === 15) {
    return `Wci\u015Bni\u0119cie przycisku ${id - 13}`;
  }
  if (id === 16 || id === 17) {
    return `Zwolnienie przycisku ${id - 15}`;
  }
  if (id === 18) {
    return "Obcy SMS - sms nie od u\u017Cytkownika i administratora";
  }
  if (id === 19) {
    return "Autotest 24 godzinny";
  }
  if (id >= 20 && id <= 1019) {
    const slot = id - 19;
    const phone = decodeCp1250(image, PHONE_BASE + (slot - 1) * PHONE_SLOT, PHONE_MAX);
    return `CLIP abonenta ${phone}`;
  }
  if (id === 1020) {
    return "CLIP dowolnego abonenta";
  }
  if (id === 1024) {
    return "Powrot sygna\u0142u GSM";
  }
  if (id === 1025) {
    return "Zanik sygna\u0142u GSM";
  }
  return "";
}
function reactionCaption(b) {
  if (b === 5) {
    return "Wy\u0142anie CLIP-u";
  }
  if (b === 6) {
    return "Wy\u0142anie SMS-a";
  }
  return "";
}
function eventProperty(image, row2) {
  if (row2.b === 5) {
    const tenths = image[row2.at + CLIP_TEXT_AT];
    return `Tclip=${Math.trunc(tenths / 10)}.${tenths % 10} sek.`;
  }
  return row2.text;
}
function textProblem(text, limit, phone) {
  if (text.length > limit) {
    return `too long: the slot holds ${limit} characters`;
  }
  const bad = unencodable(text);
  if (bad !== "") {
    return `CP-1250 has no byte for ${bad}`;
  }
  if (!phone) {
    return "";
  }
  if (text === "") {
    return "";
  }
  if (text[0] !== "+") {
    return "must start with + for the country code";
  }
  for (let i = 1; i < text.length; i++) {
    if (text[i] < "0" || text[i] > "9") {
      return "only digits after the +";
    }
  }
  return "";
}

// web/main.ts
var state = {
  image: null,
  origin: null,
  status: null,
  regions: null,
  pushes: [],
  devices: [],
  connected: null,
  source: "No image loaded.",
  error: null,
  live: false
};
function edited() {
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
var session = null;
var device = null;
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls !== "") {
    e.className = cls;
  }
  if (text !== "") {
    e.textContent = text;
  }
  return e;
}
function add(parent, child) {
  parent.appendChild(child);
  return child;
}
function row(parent, fallbackCls, cells) {
  const tr = add(parent, el("tr", "", ""));
  for (const [cls, text] of cells) {
    const effective = cls === "" ? fallbackCls : cls;
    const tag = effective.split(".")[0];
    add(tr, el(tag, effective, text));
  }
  return tr;
}
function card(title, pairs) {
  const c = el("div", "card", "");
  add(c, el("h2", "", title));
  const dl = add(c, el("dl", "dl", ""));
  for (const [k, v] of pairs) {
    add(dl, el("dt", "", k));
    add(dl, el("dd", "", v));
  }
  return c;
}
function note(parent, text) {
  add(parent, el("p", "note", text));
}
function hex(bytes, at, len) {
  let s = "";
  for (let i = at; i < at + len && i < bytes.length; i++) {
    s += ` ${bytes[i].toString(16).padStart(2, "0")}`;
  }
  return s.trim();
}
function addr24(value) {
  return `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
}
var LANDMARKS = {
  1: "transfer window start",
  8: "first subscriber slot",
  9: "names table",
  10: "TEST record",
  11: "window end / event log start",
  16: "image end"
};
var CELL_SLOTS = /* @__PURE__ */ new Map();
var FLAG_CELLS = /* @__PURE__ */ new Map();
var OUT_CELLS = /* @__PURE__ */ new Map();
var TIME_ROWS = /* @__PURE__ */ new Map();
var READ_CELLS = /* @__PURE__ */ new Map();
function paintFlag(cell, on) {
  cell.className = on ? "td.flagOn" : "td.flagOff";
  cell.textContent = on ? "\u2713" : "";
}
function markCell(cell, on) {
  const parts = [];
  for (const cls of cell.className.split(" ")) {
    if (cls !== "dirty" && cls !== "") {
      parts.push(cls);
    }
  }
  if (on) {
    parts.push("dirty");
  }
  cell.className = parts.join(" ");
}
function originText(at, limit) {
  const o = state.origin;
  return o === null ? "" : decodeCp1250(o, at, limit);
}
function originFlag(at, bit) {
  const o = state.origin;
  return o !== null && (o[at] & bit) !== 0;
}
var paintObservers = [];
function beginPaint() {
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
function rejectCell(cell, why) {
  const parts = [];
  for (const cls of cell.className.split(" ")) {
    if (cls !== "reject" && cls !== "") {
      parts.push(cls);
    }
  }
  if (why !== "") {
    parts.push("reject");
  }
  cell.className = parts.join(" ");
  if (why === "") {
    cell.removeAttribute("title");
  } else {
    cell.setAttribute("title", why);
  }
}
function cellMutations(ms) {
  const img = state.image;
  if (img === null) {
    return;
  }
  let touched = false;
  let removed = false;
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
    if (slot === void 0) {
      continue;
    }
    const draft = cell.textContent;
    const problem = textProblem(draft, slot.limit, slot.phone);
    if (problem !== "") {
      rejectCell(cell, problem);
      continue;
    }
    rejectCell(cell, "");
    const before = decodeCp1250(img, slot.at, slot.limit);
    encodeCp1250(img, slot.at, slot.limit, draft);
    const stored = decodeCp1250(img, slot.at, slot.limit);
    touched = true;
    markCell(cell, stored !== originText(slot.at, slot.limit));
    if (slot.phone && before !== "" && stored === "") {
      clearAbonent(img, slot.poz);
      syncBound(img, slot.poz);
      removed = true;
    } else if (slot.phone && before === "" && stored !== "") {
      syncBound(img, slot.poz);
    }
  }
  if (removed) {
    repaint();
    return;
  }
  if (touched) {
    renderFooter();
  }
}
function watchCells(roots, handle) {
  const obs = new MutationObserver(handle);
  const watch = { childList: true, characterData: true, subtree: true };
  for (const r of roots) {
    obs.observe(r, watch);
  }
  paintObservers.push(obs);
}
function outMutations(ms) {
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
    if (f === void 0) {
      continue;
    }
    if (cell.className.split(" ").includes("off")) {
      continue;
    }
    const draft = cell.textContent;
    const why = tenthsProblem(draft);
    if (why !== "") {
      rejectCell(cell, why);
      continue;
    }
    rejectCell(cell, "");
    const tenths = parseTenths(draft);
    writeOut(img, f.n, tenths, outBistabilny(img, f.n));
    paintTimeRow(f.n, img);
    touched = true;
    markCell(cell, tenths !== originTenths(f.n));
  }
  if (touched) {
    renderFooter();
  }
}
function tenthsProblem(text) {
  if (text === "") {
    return "type a time like 5.0";
  }
  if (!/^[0-9]{1,4}([.,][0-9]?)?$/.test(text)) {
    return "up to 4 digits, one point and one decimal";
  }
  if (parseTenths(text) > OUT_TENTHS_MAX) {
    return "the word holds at most 3276.7 s";
  }
  return "";
}
function cellState(cell, want) {
  const parts = [];
  for (const cls of cell.className.split(" ")) {
    if (cls !== "off" && cls !== "edit" && cls !== "") {
      parts.push(cls);
    }
  }
  for (const w of want) {
    parts.push(w);
  }
  cell.className = parts.join(" ");
}
function paintTimeRow(n, img) {
  const row2 = TIME_ROWS.get(n);
  if (row2 === void 0) {
    return;
  }
  const off = outBistabilny(img, n);
  const [dt, time, read] = row2;
  cellState(dt, off ? ["off"] : []);
  cellState(time, off ? ["off"] : ["edit"]);
  cellState(read, off ? ["off"] : []);
  if (off) {
    time.removeAttribute("contenteditable");
  } else {
    time.setAttribute("contenteditable", "true");
  }
  const tenths = outTenths(img, n);
  if (off) {
    time.textContent = showTenths(tenths);
  }
  const clock = showClock(tenths);
  if (read.textContent !== clock) {
    read.textContent = clock;
  }
}
function parseTenths(text) {
  let whole = "";
  let tenth = "";
  let after = false;
  for (const ch of text.replace(",", ".")) {
    if (ch === ".") {
      after = true;
    } else if (ch >= "0" && ch <= "9") {
      if (!after) {
        whole += ch;
      } else if (tenth === "") {
        tenth = ch;
      }
    }
  }
  const w = whole === "" ? 0 : Number(whole);
  return w * 10 + (tenth === "" ? 0 : Number(tenth));
}
function showTenths(tenths) {
  const t = tenths < 0 ? 0 : tenths > OUT_TENTHS_MAX ? OUT_TENTHS_MAX : tenths;
  return `${String(Math.trunc(t / 10)).padStart(4, "0")}.${t % 10}`;
}
function showClock(tenths) {
  const t = tenths < 0 ? 0 : tenths > OUT_TENTHS_MAX ? OUT_TENTHS_MAX : tenths;
  const rest = t % 36e3;
  return `${Math.trunc(t / 36e3)}h ${Math.trunc(rest / 600)}min. ${Math.trunc(rest % 600 / 10)}.${rest % 10}sek.`;
}
function originTenths(n) {
  const o = state.origin;
  return o === null ? 0 : outTenths(o, n);
}
function originBistabilny(n) {
  const o = state.origin;
  return o !== null && outBistabilny(o, n);
}
function phoneAt(image, poz) {
  return decodeCp1250(image, PHONE_BASE + (poz - 1) * PHONE_SLOT, PHONE_MAX);
}
function adminSlots() {
  const out = [];
  for (let k = 1; k <= ADMIN_SLOTS; k++) {
    out.push(k);
  }
  return out;
}
function userSlots(image) {
  const total = Math.min(ABONENT_SLOTS, readTotal(image));
  const out = [];
  for (let k = ADMIN_SLOTS + 1; k <= total; k++) {
    out.push(k);
  }
  return out;
}
function syncBound(image, poz) {
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
function resetCell(cell, at, limit, phone, poz) {
  const img = state.image;
  if (img === null) {
    return;
  }
  const back = originText(at, limit);
  const before = decodeCp1250(img, at, limit);
  encodeCp1250(img, at, limit, back);
  cell.textContent = back;
  markCell(cell, false);
  if (phone && before === "" !== (back === "")) {
    if (back === "") {
      clearAbonent(img, poz);
    }
    syncBound(img, poz);
    repaint();
    return;
  }
  renderFooter();
}
var gridScroll = [];
function restoreScroll(wrap, index) {
  const span = wrap.scrollHeight - wrap.clientHeight;
  if (index < gridScroll.length && span > 0) {
    wrap.scrollTop = Math.round(gridScroll[index] * span);
  }
}
function renderAbonents(panel) {
  const image = state.image;
  if (image === null) {
    note(panel, "No image \u2014 read the gate or open a .bme file.");
    return;
  }
  const grids = add(panel, el("div", "grids", ""));
  const groups = [
    {
      title: "Abonenci - administratorzy - reakcja na CLIP :",
      slots: adminSlots(),
      addLabel: ""
    },
    {
      title: "Abonenci - u\u0141ytkownicy reakcja na CLIP:",
      slots: userSlots(image),
      addLabel: "Dodaj nwego abonenta"
    }
  ];
  const bodies = [];
  let column = 0;
  for (const g of groups) {
    const col = add(grids, el("div", "grid", ""));
    const wrap = add(col, el("div", "table", ""));
    const table = add(wrap, el("table", "", ""));
    add(table, el("caption", "", g.title));
    const head = add(table, el("thead", "", ""));
    row(
      head,
      "th",
      [
        ["th", "Poz."],
        ["th", "Telefon"],
        ["th", "Nazwa"],
        ["th", "Wyj\u015Bcie 1"],
        ["th", "Wyj\u015Bcie 2"],
        ["th", "Del"]
      ]
    );
    const body = add(table, el("tbody", "", ""));
    bodies.push(body);
    for (const poz of g.slots) {
      const tr = add(body, el("tr", "", ""));
      add(tr, el("td", "num", String(poz).padStart(4, "0")));
      const phone = add(tr, el("td", "phone", phoneAt(image, poz)));
      const name = add(tr, el("td", "edit", decodeCp1250(image, NAME_BASE + (poz - 1) * NAME_SLOT, NAME_MAX)));
      const textCells = [
        {
          cell: phone,
          at: PHONE_BASE + (poz - 1) * PHONE_SLOT,
          limit: PHONE_MAX,
          phone: true
        },
        {
          cell: name,
          at: NAME_BASE + (poz - 1) * NAME_SLOT,
          limit: NAME_MAX,
          phone: false
        }
      ];
      for (const t of textCells) {
        const at = t.at;
        const limit = t.limit;
        t.cell.setAttribute("contenteditable", "true");
        t.cell.setAttribute("spellcheck", "false");
        CELL_SLOTS.set(t.cell, { at, limit, phone: t.phone, poz });
        markCell(t.cell, decodeCp1250(image, at, limit) !== originText(at, limit));
        t.cell.addEventListener("dblclick", () => {
          resetCell(t.cell, at, limit, t.phone, poz);
        });
      }
      const flagAt = FLAG_BASE + (poz - 1);
      const flag = image[flagAt];
      const bits = [[WYJ1_BIT, (flag & WYJ1_BIT) !== 0], [WYJ2_BIT, (flag & WYJ2_BIT) !== 0]];
      for (const [bit, on] of bits) {
        const cell = add(tr, el("td", "flagOff", ""));
        paintFlag(cell, on);
        FLAG_CELLS.set(cell, { at: flagAt, bit });
        markCell(cell, on !== originFlag(flagAt, bit));
        cell.addEventListener("click", () => {
          const img = state.image;
          if (img === null) {
            return;
          }
          const now = (img[flagAt] & bit) === 0;
          img[flagAt] = (now ? img[flagAt] | bit : img[flagAt] & ~bit) & 255;
          paintFlag(cell, now);
          markCell(cell, now !== originFlag(flagAt, bit));
          renderFooter();
        });
        cell.addEventListener("dblclick", () => {
          const img = state.image;
          if (img === null) {
            return;
          }
          const want = originFlag(flagAt, bit);
          img[flagAt] = (want ? img[flagAt] | bit : img[flagAt] & ~bit) & 255;
          paintFlag(cell, want);
          markCell(cell, false);
          renderFooter();
        });
      }
      const del = add(tr, el("td", "del", "\u2715"));
      del.addEventListener("click", () => {
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
    if (g.addLabel !== "") {
      const bar = add(col, el("div", "addbar", ""));
      const addButton = add(bar, el("button", "act add", g.addLabel));
      addButton.addEventListener("click", addAbonent);
    }
  }
  watchCells(bodies, cellMutations);
  note(
    panel,
    'Type in a Telefon / Nazwa cell to change it, click a Wyj\u015Bcie cell to toggle it, double-click a marked cell to put the loaded value back. \u201EZapis to device" or \u201ESave .bme" carries the change.'
  );
  note(
    panel,
    "Typing is checked against the slot before it reaches the image: a Telefon holds 18 characters and must start with + because the gate needs the country code, a Nazwa holds 15, and CP-1250 has no byte for an alphabet it does not cover. A value that does not fit is underlined in amber with the reason in its tooltip, and the image keeps the last value that did fit - the draft you are typing is never rewritten, so the caret stays where you left it."
  );
  note(
    panel,
    'Add / remove: the \u2715 cell at the end of a row removes that entry \u2014 its Nazwa and both Wyj\u015Bcie switches go with it, and clearing the last occupied slot lowers the bound. Typing a phone into an empty row adds an entry, in either grid. \u201EDodaj nwego abonenta" under the users grid only moves the bound, so the new row is blank and you type into it. \u201ECleanup gaps" closes the blank rows the users grid shows.'
  );
  const total = readTotal(image);
  const gaps = countGaps(image);
  note(
    panel,
    `The phone book is two fixed regions: 0001\u2026${String(ADMIN_SLOTS).padStart(4, "0")} are the \u201Eadministratorzy" slots and 0017\u2026${String(total).padStart(4, "0")} \u201Eu\u0141ytkownicy" \u2014 the head keeps that bound ${total} at 0x000F. The users region has ${gaps} empty slot${gaps === 1 ? "" : "s"} inside the bound, shown as blank rows; \u201ECleanup gaps" moves the entries down so there are none and lowers the bound. The vendor's own grid skips empty administratorzy slots; this client draws all 16 so there is somewhere to type an administrator into.`
  );
}
function renderAdmin(panel) {
  const image = state.image;
  if (image === null) {
    note(panel, "No image \u2014 the administratorzy region and the event rows are both in the image.");
    return;
  }
  const c = add(panel, el("div", "card", ""));
  add(c, el("h2", "", "Info admin."));
  const dl = add(c, el("dl", "dl", ""));
  add(dl, el("dt", "", "Administratorzy:"));
  const abonents = readAbonents(image);
  const admins = [];
  for (let i = 0; i < abonents.length; i++) {
    if (abonents[i].admin) {
      admins.push({ ord: i + 1, phone: abonents[i].phone, name: abonents[i].name });
    }
  }
  const pick = add(dl, el("dd", "pick", admins.length === 0 ? "" : `${admins[0].phone} ${admins[0].name}`.trim()));
  pick.setAttribute("title", "Wyb\xF3r administratora do dodania zdarze");
  const bar = add(c, el("div", "pickbar", ""));
  const rows = readClipRows(image);
  let body = null;
  const paint = (ord) => {
    if (body === null) {
      body = renderEventGrid(panel, image, "(Informacje przekazywane administratorom:", rows.filter((r) => r.group === ord));
      return;
    }
    paintEventRows(body, image, rows.filter((r) => r.group === ord));
  };
  for (const admin of admins) {
    const label = `${admin.phone} ${admin.name}`.trim();
    const b = add(bar, el("button", "pick", label));
    b.addEventListener("click", () => {
      pick.textContent = label;
      markCell(pick, false);
      paint(admin.ord);
    });
  }
  const btn = add(c, el("button", "act", "Dodaj zdarzenie"));
  btn.setAttribute("data-todo", "");
  if (admins.length > 0) {
    paint(admins[0].ord);
  } else {
    body = renderEventGrid(panel, image, "(Informacje przekazywane administratorom:", []);
  }
  note(
    panel,
    `The dropdown is the vendor's CB_Administrator, a csDropDownList filled with the ${admins.length} occupied administratorzy slots as \u201Ephone name" like its own screenshot shows; clicking one selects it and repaints the grid below with only that administrator's events. The row's u16 at +3 is who owns it: it is the 1-based position of the abonent among the occupied slots, so in the sample LANDA is 1 and michal is 4 \u2014 the fourth occupied slot, not slot 5. Some administrators own no row at all and their grid is empty, exactly as the vendor shows it. \u201EDodaj zdarzenie" is the vendor's BT_DodajZdarzenieAdmin, whose action sends the new event to the gate rather than editing the image, so this client draws it as a pending action.`
  );
}
function renderReakcje(panel) {
  const image = state.image;
  if (image === null) {
    note(panel, "No image \u2014 the output settings live in the config head at 0x000A.");
    return;
  }
  const c = add(panel, el("div", "card", ""));
  add(c, el("h2", "", "Reakcje wyj\u015B\u0107 na CLIP:"));
  const dl = add(c, el("dl", "dl out", ""));
  for (const n of [1, 2]) {
    add(dl, el("dt", "", `Tryb pracy wyj\u015Bcia ${n}:`));
    const mode = add(dl, el("dd", "mode", outBistabilny(image, n) ? "bistabilny" : "monostabilny"));
    add(dl, el("dd", "", ""));
    const dt = add(dl, el("dt", "", `Czas monostabilnej pracy ${n}:`));
    const time = add(dl, el("dd", "time", showTenths(outTenths(image, n))));
    time.spellcheck = false;
    const read = add(dl, el("dd", "read", showClock(outTenths(image, n))));
    TIME_ROWS.set(n, [dt, time, read]);
    READ_CELLS.set(n, read);
    OUT_CELLS.set(time, { n });
    paintTimeRow(n, image);
    markCell(time, outTenths(image, n) !== originTenths(n));
    mode.addEventListener("click", () => {
      const img = state.image;
      if (img === null) {
        return;
      }
      const now = !outBistabilny(img, n);
      writeOut(img, n, outTenths(img, n), now);
      mode.textContent = now ? "bistabilny" : "monostabilny";
      markCell(mode, now !== originBistabilny(n));
      paintTimeRow(n, img);
      renderFooter();
    });
    mode.addEventListener("dblclick", () => {
      const img = state.image;
      if (img === null) {
        return;
      }
      const want = originBistabilny(n);
      writeOut(img, n, outTenths(img, n), want);
      mode.textContent = want ? "bistabilny" : "monostabilny";
      markCell(mode, false);
      paintTimeRow(n, img);
      renderFooter();
    });
    time.addEventListener("dblclick", () => {
      const img = state.image;
      if (img === null || outBistabilny(img, n)) {
        return;
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
    "Click a Tryb cell to flip it between bistabilny and monostabilny; type in a Czas cell to change the time, in seconds with one decimal \u2014 it is stored as tenths, so 5.0 s is 50. Double-click either to put the loaded value back. Both halves of a word are written together, so flipping the mode never disturbs the time and vice versa. A bistabilny output has no time, so its Czas row is greyed out and cannot be typed into; the vendor takes that field out of the form altogether, which makes its own card change height, while this one keeps the row in place so the layout never moves. The dimmed value is still what the image holds \u2014 only the gate ignores it while the output is bistabilny \u2014 and the dim text beside a time is the vendor's own read-out of the same value."
  );
  renderEventGrid(panel, image, "Reakcja wyj\u015B\u0107 na zdarzenia od wej\u015B\u0107 i przycisk\xF3w:", readClipRows(image));
}
function renderEventGrid(panel, image, caption, rows) {
  const wrap = add(panel, el("div", "table", ""));
  const table = add(wrap, el("table", "", ""));
  add(table, el("caption", "", caption));
  const head = add(table, el("thead", "", ""));
  row(
    head,
    "th",
    [["th", "Lp."], ["th", "Zdarzenie"], ["th", "Reakcja"], ["th", "W\u0142a\u015Bciwo\u015Bci"]]
  );
  const body = add(table, el("tbody", "", ""));
  paintEventRows(body, image, rows);
  watchCells([body], cellMutations);
  return body;
}
function paintEventRows(body, image, rows) {
  body.replaceChildren();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tr = add(body, el("tr", "", ""));
    add(tr, el("td", "num", String(i + 1).padStart(4, "0")));
    const what = eventCaption(image, r.a);
    add(tr, el("td", what === "" ? "raw" : "", what === "" ? String(r.a) : what));
    const how = reactionCaption(r.b);
    add(tr, el("td", how === "" ? "raw" : "", how === "" ? String(r.b) : how));
    if (r.b === 6) {
      const at = clipTextAt(r.poz);
      const text = add(tr, el("td", "edit", r.text));
      text.setAttribute("contenteditable", "true");
      text.spellcheck = false;
      CELL_SLOTS.set(text, { at, limit: CLIP_TEXT_LEN, phone: false, poz: 0 });
      text.addEventListener("dblclick", () => resetCell(text, at, CLIP_TEXT_LEN, false, 0));
    } else {
      add(tr, el("td", "raw", eventProperty(image, r)));
    }
  }
}
var AUTOTEST_CAPTION = "Reset czasu autotestu,\npowinie odby\u0107 sie, po zamontowaniu sterownika na obiekcie o godznie, o kt\xF3rej mamy zamiar dostawa\u0107 informacja o autote\u015Bcie. Jest to przybli\u017Cona godzina odliczana co 24 godziny, poniewa\u017C stwerownik nie mosiada w\u0142asnego zeara czasu rzeczywistego.";
function renderSettings(panel) {
  const image = state.image;
  if (image === null) {
    note(panel, "No image \u2014 the two hasles and the PIN live in the config head at 0x0000.");
    return;
  }
  const pair = add(panel, el("div", "grids", ""));
  const hasla = add(pair, el("div", "card", ""));
  add(hasla, el("h2", "", "Has\u0142a:"));
  const dl = add(hasla, el("dl", "dl", ""));
  for (const f of ADMIN_FIELDS) {
    if (f.at === PIN_AT) {
      continue;
    }
    add(dl, el("dt", "", f.label));
    const dd = add(dl, el("dd", "edit", decodeCp1250(image, f.at, f.limit)));
    const at = f.at;
    const limit = f.limit;
    dd.setAttribute("contenteditable", "true");
    dd.spellcheck = false;
    CELL_SLOTS.set(dd, { at, limit, phone: false, poz: 0 });
    dd.addEventListener("dblclick", () => resetCell(dd, at, limit, false, 0));
    markCell(dd, decodeCp1250(image, at, limit) !== originText(at, limit));
  }
  watchCells([dl], cellMutations);
  note(
    hasla,
    "Type in a value to change it: the PC hasle is 5 bytes at 0x0011 and the SMS one 9 at 0x0016, which is the capacity of the vendor's own TEdit controls, so longer text is cut to fit. Double-click a marked value to put the loaded one back."
  );
  const auto = add(pair, el("div", "card", ""));
  add(auto, el("h2", "", "Ustawianie autotestu"));
  const btn = add(auto, el("button", "act", "Reset czasu autotestu"));
  btn.setAttribute("data-todo", "");
  add(auto, el("p", "quote", AUTOTEST_CAPTION));
  note(
    auto,
    "The button is the vendor's BT_ResetCzasuAutotestu: it sends the gate a new autotest anchor rather than changing a byte in the image, so this client has not implemented it. The text above is the vendor's own label, kept verbatim including its misspellings."
  );
  const c = add(panel, el("div", "card", ""));
  add(c, el("h2", "", "Config head 0x0000\u20130x002F"));
  add(c, el("div", "mono", hex(image, 0, 48)));
  add(c, el("p", "note", "image[0] is the capacity marker; the PIN the gate authenticates against is image[1..4], which the vendor has no control for \u2014 it is editable here because it is still a field of the image."));
  const pinDl = add(c, el("dl", "dl", ""));
  add(pinDl, el("dt", "", "PIN (gate):"));
  const pin = add(pinDl, el("dd", "edit", decodeCp1250(image, PIN_AT, PIN_LEN)));
  pin.setAttribute("contenteditable", "true");
  pin.spellcheck = false;
  CELL_SLOTS.set(pin, { at: PIN_AT, limit: PIN_LEN, phone: false, poz: 0 });
  pin.addEventListener("dblclick", () => resetCell(pin, PIN_AT, PIN_LEN, false, 0));
  markCell(pin, decodeCp1250(image, PIN_AT, PIN_LEN) !== originText(PIN_AT, PIN_LEN));
  watchCells([pinDl], cellMutations);
  if (state.regions !== null) {
    const wrap = add(panel, el("div", "table", ""));
    const table = add(wrap, el("table", "", ""));
    add(table, el("caption", "", "0x83 region table \u2014 21 \xD7 24-bit little-endian dwords"));
    const head = add(table, el("thead", "", ""));
    row(head, "th", [["th", "#"], ["th", "Value"], ["th", "Known landmark"]]);
    const body = add(table, el("tbody", "", ""));
    for (let i = 0; i < REGION_TABLE_DWORDS && i < state.regions.length; i++) {
      row(body, "td", [
        ["td.num", String(i)],
        ["td", addr24(state.regions[i])],
        ["td", LANDMARKS[i] ?? ""]
      ]);
    }
  }
}
function renderEvents(panel) {
  add(panel, card("zdarze", [["count", "not readable over this window"]]));
  note(
    panel,
    "The event/SMS log sits at 0xD7BE\u20130xDFFF, outside the transfer window [0x0001, 0xD7BE). The vendor reaches it through another path; this client has not implemented that, so the table stays empty."
  );
}
function renderGsm(panel) {
  if (state.status === null) {
    note(panel, "No 0x81 status block yet \u2014 connect and read.");
    return;
  }
  const s = state.status;
  add(panel, card("Status block 0x81", [
    ["stateFlag", `0x${s.stateFlag.toString(16)}`],
    ["liveFlag", `0x${s.liveFlag.toString(16)}`],
    ["adminPin", s.adminPin],
    ["counter A", String(s.counterA)],
    ["counter B", String(s.counterB)],
    ["fixed field", addr24(s.fixedField)],
    ["image head", `0x${s.imageHead.toString(16)} (= image[0])`]
  ]));
  note(
    panel,
    "Only these byte positions ever change across captures. The vendor tab also shows modem state (PIN SIM, USSD, time sync) driven by the 0x90 push fields, which are not decoded yet \u2014 those rows are omitted rather than invented."
  );
}
function renderMonitoring(panel) {
  const kpi = el("div", "card", "");
  add(kpi, el("h2", "", "live pushes"));
  add(kpi, el("div", "kpi", String(state.pushes.length)));
  add(kpi, el("div", "kpi small", "every 2.000 s while subscribed"));
  add(panel, kpi);
  if (state.pushes.length > 0) {
    const c = add(panel, el("div", "card", ""));
    add(c, el("h2", "", "0x90 push log (newest first)"));
    for (const f of state.pushes.slice(-12).reverse()) {
      add(c, el("div", "mono", hex(f.raw, 0, 16)));
    }
  }
  note(panel, "Bytes 1,2,3,4,6 vary across pushes; the field layout is not decoded, so pushes are shown raw.");
}
function renderNet(panel) {
  add(panel, card("Internet", [["NET/Winsock transport", "not implemented"]]));
  note(
    panel,
    "The second transport in the vendor client is a Winsock/TCP path whose framing additions were captured. Until they are known, this tab cannot be implemented honestly."
  );
}
function renderSerwis(panel) {
  add(panel, card("Serwis", [
    ["WebHID", webHidAvailable() ? "available" : "not available in this browser"],
    ["device", session === null ? "not connected" : "connected"],
    ["image", state.image === null ? "\u2014" : `${IMAGE_LEN} bytes`]
  ]));
  note(panel, "Discovered HID devices. The first line is what the browser reports; the second is the literal that pins this device into PINNED_FILTERS in src/webhid.ts.");
  for (const d of state.devices) {
    add(panel, el("div", "mono", formatIdentity(d)));
    add(panel, el("div", "mono", filterLiteral(d)));
  }
}
var PANELS = {
  abonents: renderAbonents,
  admin: renderAdmin,
  reakcje: renderReakcje,
  settings: renderSettings,
  events: renderEvents,
  gsm: renderGsm,
  monitoring: renderMonitoring,
  net: renderNet,
  serwis: renderSerwis
};
var actions = document.getElementById("actions");
var progressFill = add(add(actions, el("div", "progress", "")), el("i", "", ""));
function actionButton(label, handler) {
  const b = el("button", "act", label);
  b.addEventListener("click", handler);
  add(actions, b);
}
function todoButton(label) {
  add(actions, el("button", "act", label)).setAttribute("data-todo", "");
}
var fileInput = document.createElement("input");
fileInput.className = "file";
fileInput.setAttribute("type", "file");
fileInput.setAttribute("accept", ".bme");
add(actions, fileInput);
fileInput.addEventListener("change", () => {
  void loadFile();
});
function setProgress(fraction) {
  progressFill.style.width = `${Math.round(fraction * 100)}%`;
  const src = document.getElementById("source");
  if (src !== null && fraction < 1) {
    src.textContent = `${progressLabel} \u2026 ${Math.round(fraction * 100)}%`;
  }
}
var progressLabel = "Odczytano";
async function scanDevices() {
  state.error = null;
  setState("read", "Scanning HID devices...");
  state.devices = await describeDevices();
  if (state.devices.length === 0) {
    fail("No HID device found: connect the gate and allow the HID prompt.");
    setState("error", "Not connected");
    return;
  }
  setState("idle", `${state.devices.length} HID device(s) found`);
  renderFooter();
}
async function readDevice() {
  state.error = null;
  state.devices = await describeDevices();
  setState("read", "Connecting\u2026");
  try {
    const t = await connectWebHid();
    const s = new Session(t);
    device = t;
    session = s;
    state.connected = t.identity;
    setState("read", "Connected");
    if (!s.login(SERVICE_PASSWORD)) {
      fail("The gate rejected the session.");
      return;
    }
    state.status = await s.status();
    state.regions = await s.regions();
    progressLabel = "Odczytano";
    setState("read", "Reading\u2026");
    state.image = await s.readWindow(setProgress);
    state.origin = Uint8Array.from(state.image);
    state.source = "Odczytano z sterownika.";
    repaint();
    setState("read", "Device read");
  } catch (e) {
    fail(String(e));
  }
}
var pendingSave = () => {
};
function hidePrompt() {
  const host = document.getElementById("prompt");
  if (host !== null) {
    host.hidden = true;
    host.replaceChildren();
  }
}
function askCleanup(action) {
  const host = document.getElementById("prompt");
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
    `The users region has ${gaps} empty slot${gaps === 1 ? "" : "s"} inside the entry bound, which writes as a blank row. Cleanup moves the entries down so there are no gaps and lowers the bound at 0x000F.`
  );
  const clean = el("button", "act", "Cleanup and save");
  clean.addEventListener("click", () => {
    const go = pendingSave;
    hidePrompt();
    if (state.image !== null) {
      compactAbonents(state.image);
    }
    repaint();
    go();
  });
  const asIs = el("button", "act", "Save as is");
  asIs.addEventListener("click", () => {
    const go = pendingSave;
    hidePrompt();
    go();
  });
  add(host, clean);
  add(host, asIs);
}
async function writeDevice() {
  const s = session;
  const img = state.image;
  if (s === null || img === null) {
    fail("Nothing to write \u2014 read an image first.");
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
async function writeDeviceRaw() {
  const s = session;
  if (s === null || state.image === null) {
    fail("Nothing to write \u2014 read an image first.");
    return;
  }
  state.error = null;
  progressLabel = "Zapisano";
  setState("write", "Writing\u2026");
  try {
    await s.writeWindow(state.image, setProgress);
    state.source = "Zapisano to sterownika.";
    if (state.image !== null) {
      state.origin = Uint8Array.from(state.image);
    }
    repaint();
    setState("write", "Device written");
  } catch (e) {
    fail(e instanceof PageRejected ? `Page at 0x${e.addr.toString(16)} rejected` : String(e));
  }
}
async function loadFile() {
  const [picked] = fileInput.files;
  if (picked === void 0) {
    fail("No file selected.");
    return;
  }
  try {
    const bytes = new Uint8Array(await picked.arrayBuffer());
    state.image = decodeBme(assertImageSize(bytes));
    state.origin = Uint8Array.from(state.image);
    state.source = `Odczytano z pliku. (${picked.name})`;
    state.error = null;
    repaint();
  } catch (e) {
    fail(String(e));
  }
}
function saveFile() {
  const img = state.image;
  if (img === null) {
    fail("No image to save.");
    return;
  }
  if (countGaps(img) > 0) {
    askCleanup(saveFileRaw);
    return;
  }
  saveFileRaw();
}
function saveFileRaw() {
  if (state.image === null) {
    fail("No image to save.");
    return;
  }
  const encoded = encodeBme(state.image);
  const blob = new Blob([new Uint8Array(encoded)], { type: "application/octet-stream" });
  const a = el("a", "", "brama-memdump.bme");
  a.setAttribute("href", URL.createObjectURL(blob));
  a.setAttribute("download", "brama-memdump.bme");
  add(actions, a);
}
function cleanup() {
  const img = state.image;
  if (img === null) {
    fail("No image loaded.");
    return;
  }
  compactAbonents(img);
  repaint();
}
function addAbonent() {
  const img = state.image;
  if (img === null) {
    fail("No image loaded.");
    return;
  }
  const total = readTotal(img);
  if (total >= ABONENT_SLOTS) {
    fail("The phone book is full \u2014 all 1000 slots are used.");
    return;
  }
  writeTotal(img, total + 1);
  repaint();
}
async function toggleLive() {
  const s = session;
  if (s === null) {
    fail("Connect first.");
    return;
  }
  try {
    if (state.live) {
      await s.unsubscribeLive();
      state.live = false;
      setState("read", "Feed stopped");
    } else {
      await s.subscribeLive((f) => {
        state.pushes.push(f);
      });
      state.live = true;
      setState("live", "Live feed on");
    }
  } catch (e) {
    fail(String(e));
  }
}
function disconnect() {
  const t = device;
  if (t !== null) {
    t.close();
  }
  session = null;
  device = null;
  state.connected = null;
  state.live = false;
  setState("idle", "Not connected");
}
function setState(kind, text) {
  const pill = document.querySelector(".state");
  if (pill === null) {
    return;
  }
  pill.setAttribute("data-s", kind);
  const dot = pill.querySelector("i");
  if (dot !== null) {
    dot.setAttribute("data-s", kind);
  }
  const label = pill.querySelector("span");
  if (label !== null) {
    label.textContent = text;
  }
}
function fail(message) {
  state.error = message;
  setState("error", message);
  renderFooter();
}
var currentTab = "";
function showPanel(id) {
  currentTab = id;
  const panels = document.getElementById("panels");
  if (panels === null) {
    return;
  }
  const list = panels.querySelectorAll(".panel");
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const active = p.getAttribute("data-panel") === id;
    p.hidden = !active;
    if (active) {
      beginPaint();
      gridScroll = [];
      const painted = p.querySelectorAll(".table");
      for (let k = 0; k < painted.length; k++) {
        const w = painted[k];
        const span = w.scrollHeight - w.clientHeight;
        gridScroll.push(span > 0 ? w.scrollTop / span : 0);
      }
      p.replaceChildren();
      const render = PANELS[id];
      if (render !== void 0) {
        render(p);
      }
    }
  }
  renderFooter();
}
function repaint() {
  showPanel(currentTab);
}
function renderFooter() {
  const src = document.getElementById("source");
  if (src !== null) {
    src.textContent = state.error ?? (edited() ? `${state.source} \xB7 edited` : state.source);
    src.setAttribute("class", state.error === null ? "src" : "bad");
  }
  const ab = document.getElementById("abonents");
  if (ab !== null) {
    if (state.image === null) {
      ab.textContent = `abonenci: \u2013/${ABONENT_SLOTS}`;
    } else {
      const c = countGroups(state.image);
      ab.textContent = `abonenci: ${countAbonents(state.image)}/${ABONENT_SLOTS} \xB7 administratorzy ${c.admins}/${ADMIN_SLOTS} \xB7 u\u0141ytkownicy ${c.users}`;
    }
  }
  const dev = document.getElementById("device");
  if (dev !== null) {
    const c = state.connected;
    if (c !== null) {
      dev.textContent = `device: ${formatIdentity(c)}`;
      dev.setAttribute("class", "dev on");
    } else if (state.devices.length > 0) {
      dev.textContent = `device: ${formatIdentity(state.devices[0])}`;
      dev.setAttribute("class", "dev");
    } else {
      dev.textContent = "device: not scanned";
      dev.setAttribute("class", "dev");
    }
  }
  const ev = document.getElementById("events");
  if (ev !== null) {
    ev.textContent = "zdarze: \u2013/300";
  }
}
var nav = document.querySelector(".tabs");
if (nav !== null) {
  const buttons = nav.querySelectorAll(".tab");
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    b.addEventListener("click", () => {
      for (let k = 0; k < buttons.length; k++) {
        const other = buttons[k];
        if (other === b) {
          other.setAttribute("aria-current", "true");
        } else {
          other.removeAttribute("aria-current");
        }
      }
      showPanel(b.getAttribute("data-tab") ?? "");
    });
  }
}
actionButton("Scan HID devices", () => {
  void scanDevices();
});
actionButton("Odczyt from device", () => {
  void readDevice();
});
actionButton("Zapis to device", () => {
  void writeDevice();
});
actionButton("Monitoring", () => {
  void toggleLive();
});
actionButton("Rozlacz", disconnect);
actionButton("Save .bme", saveFile);
actionButton("Cleanup gaps", cleanup);
todoButton("Zdarzenia (other path)");
todoButton("Internet");
showPanel("abonents");
//# sourceMappingURL=app.js.map

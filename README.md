# gate-web — portable client for the PROXIMA bram GSM gate

Browser (WebHID) client for the gate that `ProgramatorBramaGsmMiniKlient.exe` talks to, plus a
small TypeScript library (`src/`) implementing the wire protocol. Runs as a PWA on GitHub Pages;
no server, no data leaves the page.

**This repository contains no vendor binaries, no device dumps and no captures.** Protocol
constants were measured against a real gate; the values here are the distilled result. The
analysis that produced them lives in a separate private repository.

## Requirements

* **Node ≥ 24** — the sources are `.ts` and Node runs them natively (type stripping), so there is
  no separate "compile to run" step for tests.
* **Chrome or Edge** for the browser build. WebHID (`navigator.hid`) is not implemented by Firefox
  or Safari; `src/capability.ts` feature-detects and the UI says so explicitly rather than failing
  cryptically.
* On **Linux**, Chrome's WebHID needs the same udev rule as any native HID client (the gate is a
  HID-class interface, `bInterfaceClass = 0x03`).

## Commands

| command | what it does |
|---|---|
| `npm run check` | `tsc` type-check, no output |
| `npm test` | protocol tests, driven by a device simulator (see below) |
| `npm run build` | bundle the app + copy static assets into `dist/` |
| `npm run serve` | serve `dist/` on `http://localhost:8080` |

`http://localhost` is a *potentially trustworthy* origin, so **WebHID works locally** — you can test
against the real gate without ever deploying or obtaining a certificate.

## Why the tests are meaningful

`test/device-sim.ts` implements the device side of the protocol (image, paging, the write→read-back
verify, the flush marker, live pushes). The tests drive the real `Session` against that simulator,
so a regression in paging, clamping, verification or the `.bme` codec fails the suite. The
simulator is a protocol model, not a recording — no vendor data is involved.

## Protocol facts pinned in `src/protocol.ts`

Measured, not assumed:

* 64-byte fixed reports, **no report-ID prefix** — byte 0 of the report *is* the opcode
  (endpoint `bmAttributes = 0x03` = no-report-ID + fixed-size, and the wire agrees)
* one interface, one endpoint pair (EP #1), `wMaxPacketSize = 64` both directions, `bInterval = 1`
* strictly request → response, **no pipelining**
* bulk **read** is opcode `0x06`; bulk **write** is opcode **`0x86`** (not `0x06`)
* transfer window `[0x0001, 0xD7BE)` from the `0x83` region table, in 56-byte pages
* the write loop is **write → read-back-verify, per page**; a mismatch is a rejected page
* end-of-transfer marker is `0x86` at **address `0x20000`, count 0** — the firmware replies
  (`0x86`, all zero), it is not a write at address 0
* `0x0C [1]` subscribes to the live feed, `0x0C [0]` unsubscribes; pushes arrive as `0x90` every
  2.000 s
* passwords travel raw ASCII, NUL-padded, unhashed; `0x8F[1] != 0` means accepted

## Known unknowns (explicit in code)

| item | status |
|---|---|
| **VID:PID** | not recoverable from the captures (no `GET_DEVICE_DESCRIPTOR` was issued). `webhid.ts` discovers the device at runtime and prints the pair; pin it in `VID_PID` once known |
| opcode `0x05` | never exercised in either capture; semantics unknown, declared as `TODO` |
| `image[0] = 0x07` | never transferred (reads start at 1); sourced from the `0x81` status block |
| NET/TCP framing | the vendor client also runs a TCP listener for its network feature; not captured, and a static host cannot proxy it |

## Deploy

`.github/workflows/deploy.yml` builds `dist/` and publishes it with the GitHub Pages app.
Settings → Pages → source: **GitHub App / Actions**. The manifest is served as `manifest.json`
(`application/json`) rather than `.webmanifest`, so no MIME assumption is involved.

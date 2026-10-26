/**
 * Browser entry point. Bundled by `scripts/build.ts` into `dist/app.js`.
 *
 * The flow mirrors the vendor client: connect → login → bulk read → offer the `.bme` file.
 */

import { Session, SERVICE_PASSWORD, connectWebHid, webHidAvailable } from '../src/index.ts';
import { encodeBme } from '../bme.ts';
import { WINDOW_END, WINDOW_START, IMAGE_LEN } from '../protocol.ts';

function show(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el !== null) {
    el.textContent = text;
  }
}

async function run(password: string): Promise<void> {
  if (!webHidAvailable()) {
    show('result', 'WebHID is not available in this browser (Chrome or Edge required).');
    return;
  }
  show('result', 'Requesting the device…');
  const transport = await connectWebHid();
  const session = new Session(transport);

  const accepted = await session.login(password);
  if (!accepted) {
    show('result', 'The gate rejected that password.');
    return;
  }

  show('result', 'Reading the memory window…');
  const image = await session.readWindow();

  let nonZero = 0;
  for (let i = WINDOW_START; i < WINDOW_END; i++) {
    if (image[i] !== 0) {
      nonZero++;
    }
  }
  show(
    'result',
    `Read ${WINDOW_END - WINDOW_START} bytes of the ${IMAGE_LEN}-byte image; ` +
      `${nonZero} non-zero. The .bme file is ready.`,
  );

  const blob = new Blob([encodeBme(image)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.getElementById('download');
  if (a !== null) {
    a.setAttribute('href', url);
    a.setAttribute('download', 'brama-memdump.bme');
  }
}

/** Entry: read the typed password and run the flow. */
async function start(): Promise<void> {
  const input = document.getElementById('password');
  const password = input?.value ?? '';
  await run(password);
}

const button = document.getElementById('go');
if (button !== null) {
  button.addEventListener('click', () => {
    void start();
  });
}

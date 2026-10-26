/**
 * Static server for local testing. `http://localhost` is a potentially trustworthy origin, so
 * WebHID works here — you can test against the real gate without deploying.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const ROOT = 'dist';
const PORT = 8080;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  const raw = req.url ?? '/';
  const name = raw.split('?')[0].replace(/^\//, '');
  const file = name === '' ? 'index.html' : name;
  try {
    const body = await readFile(`${ROOT}/${file}`);
    const ext = file.slice(file.lastIndexOf('.'));
    res.setHeader('content-type', TYPES[ext] ?? 'application/octet-stream');
    await res.end(body);
  } catch {
    res.statusCode = 404;
    await res.end('not found');
  }
});

server.listen(PORT);
console.log(`serving ${ROOT} at http://localhost:${PORT}`);

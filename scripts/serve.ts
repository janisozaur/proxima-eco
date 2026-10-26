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
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url;
  const name = path.split('?')[0].replace(/^\//, '');
  try {
    const body = await readFile(`${ROOT}/${name}`);
    const ext = name.slice(name.lastIndexOf('.'));
    res.setHeader('content-type', TYPES[ext] ?? 'application/octet-stream');
    await res.end(body);
  } catch {
    res.statusCode = 404;
    await res.end('not found');
  }
});

server.listen(PORT);
console.log(`serving ${ROOT} at http://localhost:${PORT}`);

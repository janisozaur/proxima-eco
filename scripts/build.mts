/**
 * Build: bundle the app with esbuild, then copy the static assets into dist/.
 *
 * Written as a Node script rather than shell in package.json so the same command works on Windows
 * and Linux.
 */

import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

const OUT = 'dist';

await mkdir(OUT, { recursive: true });

await build({
  entryPoints: ['web/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: `${OUT}/app.js`,
  sourcemap: true,
});

for (const name of ['index.html', 'app.css', 'manifest.json', 'sw.js', 'icon.svg']) {
  await copyFile(`web/${name}`, `${OUT}/${name}`);
}

// GitHub Pages custom-domain marker, if one is configured.
try {
  await copyFile('web/CNAME', `${OUT}/CNAME`);
} catch {
  // no custom domain — omit the file
}

console.log(`built ${OUT}`);

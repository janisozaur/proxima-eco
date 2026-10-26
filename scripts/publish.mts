/**
 * Publish: push `dist/` to the `gh-pages` branch, which GitHub Pages serves at the site root.
 *
 * A branch is the publishing source here, not a CI job: a commit pushed by a workflow that uses
 * `GITHUB_TOKEN` does not trigger a Pages build, so the built tree is pushed as a normal commit
 * instead. The branch holds only build output, so each publish replaces it with a fresh
 * single-commit tree force-pushed to the ref — the same shape the gh-pages tooling uses.
 *
 * The commit carries the repository's own git identity, so the push is made by the account that
 * owns the repo rather than by a bot.
 *
 * Usage: npm run publish
 */

import { spawnSync } from 'node:child_process';
import { mkdir, cp, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SITE = 'dist';
const BRANCH = 'gh-pages';

function run(args: string[], cwd: string): string {
  const got = spawnSync(args[0], args.slice(1), {cwd, encoding: 'utf8', shell: false});
  if (got.code !== 0) {
    const err = (got.stderr ?? '').trim();
    throw new Error(`${args.join(' ')} failed with ${got.code}: ${err}`);
  }
  return (got.stdout ?? '').trim();
}

// build first, so publishing cannot ship a stale dist
run(['node', 'scripts/build.mts'], '.');

const where = join(tmpdir(), 'gate-web-pages');
const site = join(where, 'site');
await rm(where, {recursive: true, force: true});
await mkdir(site, {recursive: true});

for (const name of await readdir(SITE)) {
  await cp(join(SITE, name), join(site, name), {recursive: true});
}

// the site is static output, so Jekyll must not touch it
await writeFile(join(site, '.nojekyll'), '');

const url = run(['git', 'remote', 'get-url', 'origin'], '.');
const name = run(['git', 'config', 'user.name'], '.');
const email = run(['git', 'config', 'user.email'], '.');

run(['git', 'init', '-q', '-b', 'publish'], site);
run(['git', 'add', '-A'], site);
run(['git', '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', 'publish build'], site);
run(['git', 'push', '-q', '--force', url, `publish:${BRANCH}`], site);

await rm(where, {recursive: true, force: true});

console.log(`published ${SITE} to ${BRANCH} at ${url}`);

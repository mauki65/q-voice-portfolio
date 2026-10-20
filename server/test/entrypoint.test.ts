import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `tsconfig.json` sets rootDir to ".", so src/index.ts emits to
 * dist/src/index.js — not dist/index.js. package.json pointed at the latter and
 * `npm start` died with MODULE_NOT_FOUND. The unit tests never caught it
 * because they import the source, not the entry point.
 */
const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  main: string;
  scripts: Record<string, string>;
};

test('package.json main points at a file the build actually emits', () => {
  assert.ok(fs.existsSync(path.join(root, pkg.main)), `${pkg.main} does not exist after a build`);
});

test('start and dev launch the same emitted entry point', () => {
  for (const script of ['start', 'dev'] as const) {
    // Skip node's own flags (--env-file-if-exists=.env and friends) and take
    // the first bare argument, which is the script being run.
    const after = pkg.scripts[script].split(/\bnode\b/)[1] ?? '';
    const entry = after.trim().split(/\s+/).find((token) => !token.startsWith('-'));
    assert.ok(entry, `${script} does not run a node script`);
    assert.ok(
      fs.existsSync(path.join(root, entry)),
      `npm run ${script} points at ${entry}, which does not exist`
    );
  }
});

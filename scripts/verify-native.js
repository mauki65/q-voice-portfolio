/**
 * Confirms the packaged artifact actually ships the uiohook native binary.
 * Native-module breakage almost always shows up only in the built app, so run
 * this after `npm run dist` and before shipping an installer.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const unpackedRoot = path.join(root, 'release', 'win-unpacked');
const asarUnpacked = path.join(unpackedRoot, 'resources', 'app.asar.unpacked');

function fail(msg) {
  console.error('FAIL  ' + msg);
  process.exitCode = 1;
}
function pass(msg) {
  console.log('ok    ' + msg);
}

function findNodeBinaries(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findNodeBinaries(full, acc);
    else if (entry.name.endsWith('.node')) acc.push(full);
  }
  return acc;
}

if (!fs.existsSync(unpackedRoot)) {
  fail('release/win-unpacked not found. Run `npm run dist` first.');
  return;
}
pass('found release/win-unpacked');

if (!fs.existsSync(asarUnpacked)) {
  fail('app.asar.unpacked missing — asarUnpack did not run. Check electron-builder.yml.');
} else {
  pass('found app.asar.unpacked');
}

const binaries = findNodeBinaries(path.join(asarUnpacked, 'node_modules', 'uiohook-napi'));
if (binaries.length === 0) {
  fail('no .node binary for uiohook-napi inside app.asar.unpacked. The app will throw on startup.');
} else {
  for (const bin of binaries) {
    const buf = Buffer.alloc(2);
    const fd = fs.openSync(bin, 'r');
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    const isPE = buf.toString('latin1') === 'MZ';
    const size = fs.statSync(bin).size;
    if (!isPE) {
      fail(`${path.relative(unpackedRoot, bin)} is not a Windows PE binary (wrong platform build)`);
    } else {
      pass(`${path.relative(unpackedRoot, bin)} (${size} bytes, PE)`);
    }
  }
}

// The installer itself
const releaseDir = path.join(root, 'release');
const installer = fs.readdirSync(releaseDir).find((f) => f.endsWith('.exe') && f.includes('Setup'));
if (installer) pass(`installer present: ${installer}`);
else fail('no NSIS installer found in release/');

if (process.exitCode) {
  console.error('\nPackaged artifact is NOT safe to ship.');
} else {
  console.log('\nPackaged artifact contains the native hook.');
}

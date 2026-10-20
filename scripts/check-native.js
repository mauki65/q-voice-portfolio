/**
 * uiohook-napi ships prebuilt N-API binaries (`prebuildify --napi`). N-API is
 * ABI-stable, so the SAME .node works under Node and under any Electron version
 * — there is normally nothing to rebuild. Forcing `electron-rebuild -f` here
 * would throw the working prebuild away and require a full MSVC/node-gyp
 * toolchain, which is the usual way this breaks.
 *
 * So: verify the binary loads, and only fall back to `npm run rebuild:native`
 * if it does not.
 */
const fs = require('fs');
const path = require('path');

const pkgDir = path.join(__dirname, '..', 'node_modules', 'uiohook-napi');

try {
  const nodeGypBuild = require(path.join(pkgDir, 'node_modules', 'node-gyp-build'));
  const resolved = nodeGypBuild.path
    ? nodeGypBuild.path(pkgDir)
    : require.resolve(path.join(pkgDir, 'prebuilds'));
  console.log(`[check-native] uiohook binary: ${path.relative(process.cwd(), resolved)}`);
} catch {
  try {
    const resolved = require('node-gyp-build').path(pkgDir);
    console.log(`[check-native] uiohook binary: ${path.relative(process.cwd(), resolved)}`);
  } catch (err) {
    console.warn(
      `[check-native] could not resolve a prebuilt uiohook binary (${err.message}).\n` +
        `[check-native] run: npm run rebuild:native`
    );
  }
}


/**
 * Electron's binary is downloaded by its own postinstall script, and newer npm
 * blocks install scripts by default (`npm warn allow-scripts`). When that
 * happens the package is present, the binary is not, npm reports "up to date"
 * on every later install, and the only symptom is Electron failing to start
 * much later with a confusing error. Say it here instead.
 */
const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const marker = path.join(electronDir, 'path.txt');
if (fs.existsSync(electronDir) && !fs.existsSync(marker)) {
  console.warn(
    '\n[check-native] Electron is installed but its binary was never downloaded.\n' +
      '[check-native] npm blocked the postinstall script. Fix it with:\n' +
      '[check-native]\n' +
      '[check-native]     node node_modules/electron/install.js\n' +
      '[check-native]\n' +
      '[check-native] Run that on the machine you will run the app on: the download\n' +
      '[check-native] is platform-specific.\n'
  );
}

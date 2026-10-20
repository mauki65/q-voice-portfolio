const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'dist', 'renderer');
fs.mkdirSync(out, { recursive: true });
for (const file of fs.readdirSync(src)) {
  if (file.endsWith('.html') || file.endsWith('.css')) {
    fs.copyFileSync(path.join(src, file), path.join(out, file));
  }
}

// assets (tray icon) live next to the compiled main process
const assetsSrc = path.join(root, 'src', 'assets');
const assetsOut = path.join(root, 'dist', 'assets');
fs.mkdirSync(assetsOut, { recursive: true });
for (const file of fs.readdirSync(assetsSrc)) {
  fs.copyFileSync(path.join(assetsSrc, file), path.join(assetsOut, file));
}

// livekit-client's UMD build is copied in rather than bundled: the renderer has
// no build step, and the page's CSP is script-src 'self', so it cannot come from
// a CDN. One file, one <script> tag, no bundler.
const lk = path.join(root, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');
if (!fs.existsSync(lk)) {
  console.error('[copy-static] livekit-client UMD build missing — run npm install');
  process.exit(1);
}
fs.copyFileSync(lk, path.join(out, 'livekit-client.umd.js'));

console.log('[copy-static] renderer + assets + livekit copied');

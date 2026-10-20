const fs = require('fs');
const path = require('path');
for (const dir of ['dist']) {
  fs.rmSync(path.join(__dirname, '..', dir), { recursive: true, force: true });
}

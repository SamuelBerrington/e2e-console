'use strict';
// Screenshot against a baseline: the share of pixels that differ, and a diff image.
const fs = require('node:fs');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

function read(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

// → { mismatch: 0..1, sizeDiffers, width, height }
function compare(actualFile, baselineFile, diffFile, { threshold = 0.1, ignore = [] } = {}) {
  const a = read(actualFile), b = read(baselineFile);
  if (a.width !== b.width || a.height !== b.height) return { mismatch: 1, sizeDiffers: true, width: a.width, height: a.height, baselineWidth: b.width, baselineHeight: b.height };
  // ignored rectangles (status bar, clocks): painted the same on both sides
  for (const r of ignore) {
    const [x1, y1, x2, y2] = r.map(Number);
    for (let y = Math.max(0, y1); y < Math.min(a.height, y2); y++) {
      for (let x = Math.max(0, x1); x < Math.min(a.width, x2); x++) {
        const i = (y * a.width + x) * 4;
        a.data[i] = b.data[i]; a.data[i + 1] = b.data[i + 1]; a.data[i + 2] = b.data[i + 2]; a.data[i + 3] = b.data[i + 3];
      }
    }
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const bad = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold, includeAA: true });
  if (diffFile) fs.writeFileSync(diffFile, PNG.sync.write(diff));
  return { mismatch: bad / (a.width * a.height), sizeDiffers: false, width: a.width, height: a.height, pixels: bad };
}

module.exports = { compare };

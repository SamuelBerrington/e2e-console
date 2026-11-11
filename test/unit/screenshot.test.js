'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const { compare } = require('../../lib/screenshot');

function png(file, w, h, paint) {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const [r, g, b] = paint(x, y);
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(img));
}

test('screenshot.compare: identical images match, a changed area is its share of pixels, ignore masks it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-unit-png-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base.png'), same = path.join(dir, 'same.png'), changed = path.join(dir, 'changed.png'), diff = path.join(dir, 'diff.png');
  const white = () => [255, 255, 255];
  png(base, 10, 10, white);
  png(same, 10, 10, white);
  // a 2×5 black block in the top-left corner: 10 of 100 pixels
  png(changed, 10, 10, (x, y) => (x < 2 && y < 5 ? [0, 0, 0] : [255, 255, 255]));
  assert.deepEqual(compare(same, base, null), { mismatch: 0, sizeDiffers: false, width: 10, height: 10, pixels: 0 });
  const r = compare(changed, base, diff);
  assert.equal(r.pixels, 10);
  assert.equal(r.mismatch, 0.1);
  assert.ok(fs.existsSync(diff));
  assert.equal(PNG.sync.read(fs.readFileSync(diff)).width, 10);
  assert.equal(compare(changed, base, null, { ignore: [[0, 0, 2, 5]] }).mismatch, 0);
  assert.equal(compare(changed, base, null, { ignore: [[0, 0, 1, 5]] }).pixels, 5);
});

test('screenshot.compare: a different size is a full mismatch', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-unit-png-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.png'), b = path.join(dir, 'b.png');
  png(a, 4, 4, () => [0, 0, 0]);
  png(b, 4, 5, () => [0, 0, 0]);
  assert.deepEqual(compare(a, b, null), { mismatch: 1, sizeDiffers: true, width: 4, height: 4, baselineWidth: 4, baselineHeight: 5 });
});

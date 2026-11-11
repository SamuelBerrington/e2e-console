'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { zip } = require('../../lib/zip');

// reads a store-only zip back: central directory → entries
function unzip(buf) {
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(off), 0x04034b50);
    const lnameLen = buf.readUInt16LE(off + 26);
    const data = buf.slice(off + 30 + lnameLen, off + 30 + lnameLen + size);
    out.push({ name, crc, data });
    p += 46 + nameLen;
  }
  return out;
}

test('zip writes a readable store-only archive with correct CRCs and UTF-8 names', () => {
  const bin = Buffer.from([0, 1, 2, 255]);
  const buf = zip([{ name: 'flow.yaml', content: 'hello' }, { name: 'scripts/01-проверка.js', content: 'var x = 1;\n' }, { name: 'b.bin', content: bin }]);
  const entries = unzip(buf);
  assert.deepEqual(entries.map((e) => e.name), ['flow.yaml', 'scripts/01-проверка.js', 'b.bin']);
  assert.equal(entries[0].data.toString(), 'hello');
  assert.equal(entries[0].crc, 0x3610a686);
  assert.deepEqual(entries[2].data, bin);
  if (typeof zlib.crc32 === 'function') for (const e of entries) assert.equal(e.crc, zlib.crc32(e.data));
});

test('zip of no files is an empty archive', () => {
  const buf = zip([]);
  assert.equal(buf.length, 22);
  assert.deepEqual(unzip(buf), []);
});

'use strict';
// JSON files written so that a crash mid-write never leaves half a file: the text goes to a temp file next to the
// target, then replaces it in one rename. A file that exists but does not parse is an error, never "empty".
const fs = require('node:fs');
const path = require('node:path');

function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text);
  // Windows refuses the rename while another process (an antivirus, an indexer) holds the target for a moment
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1)); // a short synchronous pause
    }
  }
}

function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2));
}

// missing → fallback; unreadable or not JSON → throws (the caller decides; nothing is silently replaced)
function readJsonStrict(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(text); } catch (e) {
    const err = new Error(`${path.basename(file)} is damaged (${e.message}). Fix it by hand or restore it from a copy; the console will not overwrite it.`);
    err.status = 500;
    err.code = 'E2E_DAMAGED_JSON';
    throw err;
  }
}

// lenient: missing or unreadable → fallback (for files that are many and disposable, like one run.json in a list)
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

module.exports = { writeAtomic, writeJson, readJson, readJsonStrict };

'use strict';
// Runs Flashlight's profiler (@perf-profiler/profiler) in its own process: it shells out to the `adb` on
// PATH for the device in ANDROID_SERIAL, pushes its C++ sampler to /data/local/tmp and streams CPU per
// thread, FPS (atrace) and RAM every 500 ms. Kept out of the server process because the library installs
// its own signal handlers and may call process.exit.
//
// Parent → { type: 'start', pkg } | { type: 'stop' }
// Worker → { type: 'started' } | { type: 'measure', at, m } | { type: 'error', message } | { type: 'stopped' }
let polling = null;
let profiler = null;

function send(msg) {
  if (process.send) { try { process.send(msg); } catch { /* parent gone */ } }
}

function stop() {
  try { if (polling) polling.stop(); } catch { /* already stopped */ }
  polling = null;
  try { if (profiler) profiler.cleanup(); } catch { /* nothing to clean */ }
  send({ type: 'stopped' });
  setTimeout(() => process.exit(0), 300);
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'start') {
    try {
      ({ profiler } = require('@perf-profiler/profiler'));
      polling = profiler.pollPerformanceMeasures(String(msg.pkg), {
        onMeasure: (m) => send({ type: 'measure', at: Date.now(), m }),
        onStartMeasuring: () => send({ type: 'started' })
      });
    } catch (e) {
      send({ type: 'error', message: e.message });
      setTimeout(() => process.exit(1), 100);
    }
  }
  if (msg.type === 'stop') stop();
});
process.on('disconnect', stop);
process.on('uncaughtException', (e) => { send({ type: 'error', message: e.message }); stop(); });

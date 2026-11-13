# Contributing

Thanks for taking a look. Bug reports, fixes and small features are welcome.

## Setup

```bash
npm install
node server.js          # http://localhost:4777
npm test                # unit + integration, about 20 seconds
```

Node 20 or newer. The console itself needs the Android SDK (adb) only when you run scenarios on a device;
the tests need neither a device nor a backend. The browser-engine tests use an installed Chrome, Edge or
Chromium and are skipped when none is found.

To try changes without touching your own scenarios and settings, start a second console on a scratch folder:

```bash
node server.js --port 4790 --data /tmp/e2e-scratch
```

## What goes where

- `server.js` is the HTTP API and the run queue.
- `lib/` holds the engines and the logic: `runner.js` (a run), `adb.js`, `maestro.js`, `web.js` (the three screen
  engines), `compile.js` and `lint.js` (scenarios), `formats.js` (import and export), `perf.js` (measurements).
- `public/` is the web UI, plain JavaScript with no build step.
- `tools/e2e.js` is the command line.
- `test/unit` covers `lib/`; `test/integration` starts a real server on a temporary folder and a free port.

## Ground rules

- **Keep it generic.** The console knows nothing about a particular app. App-specific things (packages, hosts,
  accounts, request envelopes, scenarios) belong in settings, presets and plugins, never in the code, the
  examples or the tests. Sample data must be made up.
- **No secrets and no personal data** in code, tests, fixtures or screenshots.
- **Tests come with the change.** A bug fix needs a test that fails without it. Tests must be hermetic: temporary
  folders, free ports, no network beyond `127.0.0.1`, no dependence on the machine's paths or locale. CI runs
  them on Linux, Windows and macOS with Node 20 and 22.
- **No new dependencies** without a good reason. Open an issue first.
- **Style:** two-space indent, single quotes, `'use strict'`, semicolons. Comments are short, in English, and
  explain why rather than what.
- **Languages.** Server messages, logs and errors are English. UI strings are written in Russian in
  `public/app.js`, wrapped in `t('…')`, and every one needs an English value in `public/i18n.js`. Server texts
  shown in the Russian UI are translated by the patterns at the end of the same file.
- **Scenario language changes** (a new step type or field) touch four places: `lib/formats.js` (parsing and
  export), `lib/lint.js` (the field table), `lib/runner.js` plus the engines, and `schema/scenario.schema.json`.
  Update the README tables too.

## Pull requests

One topic per pull request, with a short description of what changed and how you checked it. Run `npm test`
before you push. If the change affects what a user sees, say so and update `README.md` (and `README.ru.md` if
you can; otherwise mention that it needs a translation).

## Reporting bugs

Please include the console version or commit, the operating system, the engine (adb, Maestro or browser), the
scenario or the step that misbehaves with app-specific names replaced, and what you expected. Remove tokens,
phone numbers and internal addresses from anything you paste: `run.json` and `settings.json` contain them.

Security problems: see [SECURITY.md](SECURITY.md).

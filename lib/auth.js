'use strict';
// API tokens for backend checks. Without a plugin the console uses the tokens written in the settings
// (`accounts.<role>.token`). With `auth.plugin` — a path to a CommonJS module, absolute or relative to
// the console folder — it asks the plugin for fresh ones before every run (`autoToken: true`).
//
// A plugin exports:
//   async freshToken({ apiBase, role, phone, otp, refreshToken, allowMint, settings })
//     → { accessToken, refreshToken? }
// role is any account name from the settings; refreshToken is what the plugin returned last time for that role and is
// saved for the next run. When a new login would sign the app out of the same account, a plugin throws
// an error with code 'MINT_NOT_ALLOWED' (and optionally `hint`, the text shown to the user) unless
// allowMint is true — it is true only for scenarios that clear the app's data and sign in again.
const path = require('node:path');

function load(settings, root) {
  const p = String((settings.auth || {}).plugin || '').trim();
  if (!p) return null;
  const file = path.isAbsolute(p) ? p : path.resolve(root, p);
  // re-read on every run, so editing the plugin needs no restart
  delete require.cache[require.resolve(file)];
  const mod = require(file);
  if (!mod || typeof mod.freshToken !== 'function') throw new Error(`${file}: the login plugin must export freshToken()`);
  return mod;
}

async function freshToken(settings, { root, role, phone, otp, refreshToken, allowMint }) {
  const plugin = load(settings, root);
  if (!plugin) throw new Error('auth.plugin is not set');
  const t = await plugin.freshToken({ apiBase: settings.apiBase, role, phone, otp, refreshToken, allowMint, settings });
  if (!t || !t.accessToken) throw new Error('the plugin returned no accessToken');
  return t;
}

module.exports = { freshToken, load };

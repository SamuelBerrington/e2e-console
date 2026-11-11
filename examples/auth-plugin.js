'use strict';
// Пример плагина входа (settings → auth.plugin = examples/auth-plugin.js, autoToken: true).
// Консоль вызывает freshToken перед каждым прогоном: для 'buyer' и, если в сценарии есть шаги
// «от имени продавца», для 'seller'. Возвращённый refreshToken сохраняется и придёт в следующий раз.
// Здесь — обычный OAuth2 refresh; вход с нуля (по номеру, паролю, OTP) пишется так же.
async function freshToken({ apiBase, role, phone, otp, refreshToken, allowMint }) {
  if (refreshToken) {
    const r = await fetch(apiBase.replace(/\/$/, '') + '/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
    });
    if (r.ok) {
      const j = await r.json();
      return { accessToken: j.access_token, refreshToken: j.refresh_token || refreshToken };
    }
  }
  // Новый вход выкинул бы приложение из того же аккаунта — консоль разрешает его только сценариям,
  // которые сами очищают данные приложения и входят заново.
  if (!allowMint) {
    const e = new Error('refresh-токен истёк');
    e.code = 'MINT_NOT_ALLOWED';
    e.hint = 'Токен истёк: запусти сценарий входа (запуск с очисткой данных), он войдёт и в приложение, и в консоль.';
    throw e;
  }
  throw new Error(`вход с нуля для ${role} (${phone || 'без номера'}) в этом примере не реализован`);
}

module.exports = { freshToken };

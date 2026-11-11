// Проверка бэкенда из Maestro: корзина покупателя не пуста.
// Консоль передаёт API_BASE и BUYER_TOKEN сама; в чистом Maestro: -e API_BASE=… -e BUYER_TOKEN=…
var r = http.request(API_BASE + '/api/v1/cart', { method: 'GET', headers: { authorization: 'Bearer ' + BUYER_TOKEN } });
if (r.status >= 400) throw new Error('HTTP ' + r.status + ' ' + r.body);
var items = json(r.body).items || [];
if (!items.length) throw new Error('корзина пуста');
output.cartLines = items.length;

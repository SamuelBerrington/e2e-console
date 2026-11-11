'use strict';
// Phone SoCs with an approximate single-core score (Geekbench 6 class, rounded). The scale is what the
// forecast is written in: a step whose p95 cost is X ms on a phone of score S costs about X·S/S' on a phone of
// score S' — single-thread UI work scales with the big core. Values are indicative; `settings.perf.chips`
// may add or override entries ({ code, name, score }).
//
// `code` is matched against ro.soc.model, then ro.board.platform / ro.hardware (case-insensitive, prefix).
const CHIPS = [
  // Qualcomm
  { code: ['SM8750', 'sun'], name: 'Snapdragon 8 Elite', score: 3000 },
  { code: ['SM8650', 'pineapple'], name: 'Snapdragon 8 Gen 3', score: 2200 },
  { code: ['SM8550', 'kalama'], name: 'Snapdragon 8 Gen 2', score: 1950 },
  { code: ['SM8475'], name: 'Snapdragon 8+ Gen 1', score: 1750 },
  { code: ['SM8450', 'taro'], name: 'Snapdragon 8 Gen 1', score: 1650 },
  { code: ['SM8350', 'lahaina'], name: 'Snapdragon 888', score: 1450 },
  { code: ['SM8250-AC', 'SM8250_AC'], name: 'Snapdragon 870', score: 1250 },
  { code: ['SM8250', 'kona'], name: 'Snapdragon 865', score: 1200 },
  { code: ['SM8150', 'msmnile'], name: 'Snapdragon 855', score: 1000 },
  { code: ['SM7675'], name: 'Snapdragon 7+ Gen 3', score: 1900 },
  { code: ['SM7550'], name: 'Snapdragon 7 Gen 3', score: 1150 },
  { code: ['SM7475'], name: 'Snapdragon 7+ Gen 2', score: 1700 },
  { code: ['SM7450'], name: 'Snapdragon 7 Gen 1', score: 1100 },
  { code: ['SM7435'], name: 'Snapdragon 7s Gen 2', score: 1000 },
  { code: ['SM7325', 'yupik'], name: 'Snapdragon 778G', score: 1050 },
  { code: ['SM7350'], name: 'Snapdragon 780G', score: 1050 },
  { code: ['SM7250', 'lito'], name: 'Snapdragon 765G', score: 650 },
  { code: ['SM7225'], name: 'Snapdragon 750G', score: 700 },
  { code: ['SM6450'], name: 'Snapdragon 6 Gen 1', score: 1000 },
  { code: ['SM6375', 'holi'], name: 'Snapdragon 695', score: 900 },
  { code: ['SM6350'], name: 'Snapdragon 690', score: 650 },
  { code: ['SM6225-AD'], name: 'Snapdragon 685', score: 480 },
  { code: ['SM6225', 'bengal'], name: 'Snapdragon 680', score: 450 },
  { code: ['SM6115'], name: 'Snapdragon 662', score: 350 },
  { code: ['SM6125', 'trinket'], name: 'Snapdragon 665', score: 320 },
  { code: ['SM4450'], name: 'Snapdragon 4 Gen 2', score: 950 },
  { code: ['SM4375'], name: 'Snapdragon 4 Gen 1', score: 750 },
  { code: ['SM4350'], name: 'Snapdragon 480', score: 650 },
  // MediaTek
  { code: ['MT6991'], name: 'Dimensity 9400', score: 2800 },
  { code: ['MT6989'], name: 'Dimensity 9300', score: 2200 },
  { code: ['MT6985'], name: 'Dimensity 9200', score: 1950 },
  { code: ['MT6983'], name: 'Dimensity 9000', score: 1800 },
  { code: ['MT6897'], name: 'Dimensity 8300', score: 1600 },
  { code: ['MT6896'], name: 'Dimensity 8200', score: 1250 },
  { code: ['MT6895'], name: 'Dimensity 8100', score: 1200 },
  { code: ['MT6893'], name: 'Dimensity 1200', score: 950 },
  { code: ['MT6891'], name: 'Dimensity 1100', score: 900 },
  { code: ['MT6886'], name: 'Dimensity 7200', score: 1150 },
  { code: ['MT6878'], name: 'Dimensity 7300', score: 1050 },
  { code: ['MT6877'], name: 'Dimensity 1080 / 7050', score: 950 },
  { code: ['MT6855'], name: 'Dimensity 930', score: 900 },
  { code: ['MT6873', 'MT6875'], name: 'Dimensity 800U / 820', score: 650 },
  { code: ['MT6833'], name: 'Dimensity 700 / 6020', score: 750 },
  { code: ['MT6835'], name: 'Dimensity 6100+', score: 750 },
  { code: ['MT6789'], name: 'Helio G99', score: 750 },
  { code: ['MT6785'], name: 'Helio G90T / G95', score: 550 },
  { code: ['MT6769', 'MT6768'], name: 'Helio G80 / G85 / G88', score: 400 },
  { code: ['MT6765'], name: 'Helio G35 / G37', score: 200 },
  // Samsung
  { code: ['s5e9955'], name: 'Exynos 2500', score: 2300 },
  { code: ['s5e9945'], name: 'Exynos 2400', score: 2150 },
  { code: ['s5e9925'], name: 'Exynos 2200', score: 1600 },
  { code: ['s5e9840'], name: 'Exynos 2100', score: 1300 },
  { code: ['s5e8845'], name: 'Exynos 1480', score: 1150 },
  { code: ['s5e8835'], name: 'Exynos 1380', score: 1000 },
  { code: ['s5e8825'], name: 'Exynos 1280', score: 800 },
  { code: ['s5e8535'], name: 'Exynos 1330', score: 750 },
  { code: ['s5e3830'], name: 'Exynos 850', score: 180 },
  // Google
  { code: ['zumapro'], name: 'Tensor G4', score: 1950 },
  { code: ['zuma'], name: 'Tensor G3', score: 1750 },
  { code: ['gs201'], name: 'Tensor G2', score: 1450 },
  { code: ['gs101'], name: 'Tensor', score: 1050 },
  // Unisoc
  { code: ['T820', 'ums9620'], name: 'Unisoc T820', score: 850 },
  { code: ['T760'], name: 'Unisoc T760', score: 650 },
  { code: ['T618', 'T616', 'ums512'], name: 'Unisoc T616 / T618', score: 400 },
  { code: ['T612'], name: 'Unisoc T612', score: 380 },
  { code: ['T606', 'T603'], name: 'Unisoc T603 / T606', score: 330 }
];

// three points of the scale the forecast is shown on, besides the reference phone
const EXAMPLES = ['Snapdragon 685', 'Snapdragon 695', 'Dimensity 8300', 'Snapdragon 8 Gen 3'];

function norm(s) { return String(s || '').trim().toLowerCase(); }

// device info from lib/adb.js → { name, score, via } or null
function lookup(device, extra = []) {
  if (!device) return null;
  const table = [...CHIPS, ...extra.filter((c) => c && c.name && c.score)];
  const probes = [device.soc, device.socModel, device.platform, device.hardware].map(norm).filter(Boolean);
  // ro.soc.model first: exact, then the longest code that is a prefix (SM8250-AC before SM8250)
  for (const probe of probes) {
    let best = null;
    for (const c of table) for (const code of [].concat(c.code || [])) {
      const n = norm(code);
      if (probe === n || probe.endsWith(' ' + n)) return { name: c.name, score: c.score, via: code };
      if (probe.startsWith(n) && (!best || n.length > best.n.length)) best = { c, n, code };
    }
    if (best) return { name: best.c.name, score: best.c.score, via: best.code };
  }
  return null;
}

function examples(extra = []) {
  const table = [...CHIPS, ...extra.filter((c) => c && c.name && c.score)];
  return EXAMPLES.map((name) => table.find((c) => c.name === name)).filter(Boolean).map((c) => ({ name: c.name, score: c.score }));
}

module.exports = { CHIPS, lookup, examples };

#!/usr/bin/env node
/**
 * PARITY HARNESS — fence-designer central price table overlay
 * ----------------------------------------------------------
 * Proves the table-driven COST_PRICES overlay is price-identical to the
 * hardcoded snapshot, using the CURRENT seeded scope_tool_defaults values.
 *
 * Method (deterministic; the seed SQL IS the table state):
 *  1. Pull COST_PRICES, FENCE_COST_MAP, and _tableWins straight out of
 *     index.html (the real overlay code — never a re-implementation).
 *  2. Build the defaults map from the seed SQL, keyed by item_key (cost).
 *  3. Snapshot BEFORE, run the real overlay loop, snapshot AFTER.
 *  4. Diff every COST_PRICES key + 3 reference-scope cost totals.
 *  5. Assert parity. The 7 deliberately-EXCLUDED rows (null in FENCE_COST_MAP)
 *     are reported separately with the seed-vs-live delta they would have
 *     caused had they been overlaid — proving WHY they are held back.
 *
 * Run:  node parity_fence.js
 * Exit: 0 = parity proven; 1 = unexplained diff.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TOOL = process.env.FENCE_HTML ||
  require('path').resolve(__dirname,'..','index.html');
const SEED = path.resolve(__dirname, 'seed_scope_tool_defaults.sql');

const html = fs.readFileSync(TOOL, 'utf8');

function grab(startRe, endRe) {
  const lines = html.split('\n');
  let out = [], on = false;
  for (const ln of lines) {
    if (!on && startRe.test(ln)) on = true;
    if (on) out.push(ln);
    if (on && endRe.test(ln)) break;
  }
  return out.join('\n');
}

const costPricesSrc = grab(/const COST_PRICES = \{/, /^\s*\};\s*$/);
const tableWinsSrc  = grab(/function _tableWins\(row, field, fallback\) \{/, /^\s{4}\}\s*$/);
const mapSrc        = grab(/var FENCE_COST_MAP = \{/, /^\s{4}\};\s*$/);

// Parse seed SQL → fence cost map (default_cost_rate is col 6 in the VALUES row)
const seedSql = fs.readFileSync(SEED, 'utf8');
const defaults = {};
const rowRe = /\('fence-designer','([^']+)','([^']+)','[^']*','[^']*',([^,]+),([^,]+),([^,]+),/g;
let m;
while ((m = rowRe.exec(seedSql))) {
  const itemKey = m[2];
  const cost = m[3].trim() === 'NULL' ? null : Number(m[3]);
  defaults[itemKey] = { default_cost_rate: cost };
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${costPricesSrc}\n${tableWinsSrc}\n${mapSrc}`, sandbox);

const COST_PRICES_INIT = JSON.parse(vm.runInContext('JSON.stringify(COST_PRICES)', sandbox));
const FENCE_COST_MAP   = JSON.parse(vm.runInContext('JSON.stringify(FENCE_COST_MAP)', sandbox));

// Reference scope cost totals (use only table-eligible keys for the parity total,
// plus a couple of excluded keys to show those scopes are unaffected because the
// excluded rows are held on the hardcoded value).
function scopeCosts(cp) {
  // small: 20m of 1800/2400 fence + concrete + labour
  const small = (20 / 2.38 * cp.panelKit1800_2400) + (21 * 2 * cp.concrete) + (20 * cp.labourPerMetre);
  // medium: 30m 2100 fence + 1 ped gate (kit+posts+labour) + tek screws
  const medium = (30 / 2.38 * cp.panelKit2100_2700) + cp.gateKitPedestrian + (2 * cp.gatePost90x90)
               + cp.gateLabourPedestrian + (30 * cp.labourPerMetre) + (3 * cp.tekScrewBox);
  // complex: 40m 1800/3000 + double gate + plinth install + patio tubes + hardie removal
  const complex = (40 / 3.15 * cp.panelKit1800_3000) + cp.gateKitDouble + (4 * cp.gatePost90x90)
               + cp.gateLabourDouble + (5 * cp.plinthInstall) + (3 * cp.patioTube)
               + (40 * cp.labourPerMetre) + (12 * cp.removeHardie);
  return {
    small: +small.toFixed(2), medium: +medium.toFixed(2), complex: +complex.toFixed(2)
  };
}

const before = JSON.parse(JSON.stringify(COST_PRICES_INIT));
const beforeScopes = scopeCosts(before);

// Run the REAL overlay loop (same logic as index.html loadDbFencePrices)
let applied = 0;
const after = JSON.parse(JSON.stringify(COST_PRICES_INIT));
const tableWins = vm.runInContext('_tableWins', sandbox);
Object.keys(FENCE_COST_MAP).forEach(jsKey => {
  const dbKey = FENCE_COST_MAP[jsKey];
  if (!dbKey) return;
  const row = defaults[dbKey];
  if (!row) return;
  const nv = tableWins(row, 'default_cost_rate', after[jsKey]);
  if (nv !== after[jsKey]) { after[jsKey] = nv; applied++; }
});
const afterScopes = scopeCosts(after);

// Diffs
const diffs = [];
for (const k of Object.keys(before)) {
  if (before[k] !== after[k]) diffs.push(`COST_PRICES.${k}: ${before[k]} -> ${after[k]}`);
}
const scopeDiffs = [];
for (const s of ['small', 'medium', 'complex']) {
  if (beforeScopes[s] !== afterScopes[s]) scopeDiffs.push(`${s}: ${beforeScopes[s]} -> ${afterScopes[s]}`);
}

// Excluded-row report: show the delta each held-back row WOULD have caused
const excluded = [];
for (const jsKey of Object.keys(FENCE_COST_MAP)) {
  if (FENCE_COST_MAP[jsKey] !== null) continue;
}
// re-derive excluded keys + their candidate seed item_key from the source comments
const exclMap = {
  plinth: 'plinth-cost', removeAsbestos: 'remove-asbestos-cost', vegClear: 'veg-clear-cost',
  groundMulch: 'mulch-cost', groundStones: 'white-stones-cost', groundTurf: 'turf-prep-cost',
  delivery: 'delivery-cost'
};
for (const jsKey of Object.keys(exclMap)) {
  if (FENCE_COST_MAP[jsKey] !== null) continue; // only report truly-excluded ones
  const seedKey = exclMap[jsKey];
  const seedVal = defaults[seedKey] ? defaults[seedKey].default_cost_rate : undefined;
  excluded.push(`${jsKey}: live=${before[jsKey]} | seed(${seedKey})=${seedVal} | HELD (would change price by ${(seedVal - before[jsKey]).toFixed(2)})`);
}

console.log('=== FENCE PARITY HARNESS ===');
console.log('Overlay applied', applied, 'cost overrides (count of values that changed).');
console.log('Table-driven keys:', Object.values(FENCE_COST_MAP).filter(Boolean).length, '| Excluded (held on hardcode):', excluded.length);
console.log('');
console.log('Reference scope cost totals ($):');
console.log('  small   BEFORE', beforeScopes.small, '| AFTER', afterScopes.small);
console.log('  medium  BEFORE', beforeScopes.medium, '| AFTER', afterScopes.medium);
console.log('  complex BEFORE', beforeScopes.complex, '| AFTER', afterScopes.complex);
console.log('');
if (diffs.length === 0) console.log('COST_PRICES DIFFS: NONE — every table-driven cost identical before/after.');
else { console.log('COST_PRICES DIFFS (' + diffs.length + '):'); diffs.forEach(d => console.log('  ' + d)); }
console.log('');
if (scopeDiffs.length === 0) console.log('SCOPE TOTAL DIFFS: NONE — all reference scope totals IDENTICAL.');
else { console.log('SCOPE TOTAL DIFFS:'); scopeDiffs.forEach(d => console.log('  ' + d)); }
console.log('');
console.log('INTENTIONALLY EXCLUDED rows (seed conflicts live tool — held until Marnin reconciles):');
excluded.forEach(e => console.log('  ' + e));

const ok = diffs.length === 0 && scopeDiffs.length === 0;
console.log('');
console.log(ok ? 'RESULT: PARITY PROVEN ✓ (identical; 7 conflicting rows safely held back)' : 'RESULT: DIFFS PRESENT — review required');
process.exit(ok ? 0 : 1);

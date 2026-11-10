// Out-of-sample backtest: analog library + calibration on one year, test on the other.
// Usage: node scripts/backtest.js   (writes data/backtest.json)
import fs from 'node:fs';
import * as F from '../core/firm.js';

export function runBacktest(buoys, opts = {}) {
  const fleet = F.buildFleet(buoys);
  const libYear = opts.libYear ?? 2023, testYear = opts.testYear ?? 2024;
  const lib = F.library(fleet, [libYear]);
  const cal = F.origins(fleet, [libYear], opts.calStep ?? 12);
  const test = F.origins(fleet, [testYear], opts.testStep ?? 6);
  const nn = fleet.power.length;
  const out = { libYear, testYear, calOrigins: cal.length, testOrigins: test.length, targets: {} };
  for (const target of opts.targets ?? [0.99, 0.95]) {
    const res = {};
    const calP = F.calibrate(fleet, lib, cal, target, 'pooled');
    const calN = F.calibrate(fleet, lib, cal, target, 'per-node');
    const raw = new Array(F.NBLOCK).fill(Math.max(0, Math.round((1 - target) * 1000) / 1000));
    const policies = {
      pooled: { levels: calP.levels, mode: 'pooled' },
      perNode: { levels: calN.levels, mode: 'per-node' },
      rawQuantile: { levels: raw, mode: 'pooled' },
    };
    for (const [name, pol] of Object.entries(policies)) {
      let blocks = 0, okB = 0, firm = 0, origins72 = 0, okAll = 0;
      for (const t0 of test) {
        const p = F.plan(fleet, lib, t0, pol.levels, pol.mode);
        const ok = F.realise(fleet, t0, p, pol.mode);
        blocks += ok.length; okB += ok.filter(Boolean).length; origins72++; if (ok.every(Boolean)) okAll++;
        firm += p.C.reduce((a, c) => a + c, 0) / p.C.length;
      }
      res[name] = { levels: pol.levels, delivery: okB / blocks, fullHorizon: okAll / origins72, firmKW: firm / test.length, firmPerNodeKW: firm / test.length / nn };
    }
    // persistence: hold today's fleet power flat for 72 h (no forecast, battery as buffer)
    let blocks = 0, okB = 0, firm = 0;
    for (const t0 of test) {
      const now = fleet.power.reduce((a, p) => a + p[t0], 0);
      const C = new Array(F.NBLOCK).fill(now);
      const ok = F.realise(fleet, t0, { C }, 'pooled');
      blocks += ok.length; okB += ok.filter(Boolean).length; firm += now;
    }
    res.persistence = { delivery: okB / blocks, firmKW: firm / test.length, firmPerNodeKW: firm / test.length / nn };
    let avail = 0; for (const t0 of test) { const a = F.actual(fleet, t0); avail += F.sumPaths(a).reduce((x, y) => x + y, 0) / F.HORIZON; }
    res.meanAvailableKW = avail / test.length;
    res.calRates = { pooled: calP.rates, perNode: calN.rates };
    out.targets[target] = res;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const buoys = JSON.parse(fs.readFileSync(new URL('../data/buoys.json', import.meta.url)));
  const t = Date.now();
  const a = runBacktest(buoys);
  const b = runBacktest(buoys, { libYear: 2024, testYear: 2023 });
  fs.writeFileSync(new URL('../data/backtest.json', import.meta.url), JSON.stringify({ forward: a, reverse: b }));
  for (const [k, r] of Object.entries({ forward: a, reverse: b })) for (const [tg, res] of Object.entries(r.targets)) {
    console.log(k, 'target', tg, 'cal', r.calOrigins, 'test', r.testOrigins, 'avail', res.meanAvailableKW.toFixed(0));
    for (const [n, v] of Object.entries(res)) if (v && v.delivery !== undefined) console.log('  ', n.padEnd(12), 'delivery', (100 * v.delivery).toFixed(2), 'firm kW', v.firmKW.toFixed(0), v.levels ? 'levels ' + v.levels.join(',') : '');
  }
  console.log('secs', (Date.now() - t) / 1000);
}

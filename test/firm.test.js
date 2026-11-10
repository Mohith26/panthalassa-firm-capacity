import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as F from '../core/firm.js';

test('wave flux matches the deep-water formula', () => {
  // rho g^2 / (64 pi) = 1025 * 9.81^2 / (64 pi) W/m per m^2 s = 0.49 kW
  const k = 1025 * 9.81 * 9.81 / (64 * Math.PI) / 1000;
  assert.ok(Math.abs(k - 0.49) < 0.005);
  assert.ok(Math.abs(F.waveFluxKWm(2, 8) - 0.49 * 4 * 9.6) < 1e-9);
});

test('node power is capped at rating and net of hotel load', () => {
  assert.equal(F.itPowerKW(10, 12), F.NODE.ratedKW - F.NODE.hotelKW);
  assert.equal(F.itPowerKW(0.1, 4), 0);
  assert.equal(F.itPowerKW(null, 8), null);
});

test('battery covers a short lull but not a long one', () => {
  const batt = { kwh: 1000, kw: 250, eta: 1, soc0: 500 };
  const path = new Array(F.HORIZON).fill(300);
  for (let h = 6; h < 8; h++) path[h] = 100;        // 2 h at 100 kW
  const C = new Array(F.NBLOCK).fill(300);
  const r = F.simulate(path, C, batt);
  assert.ok(r.ok[1]);                              // 2 x 200 kWh = 400 < 500 stored
  for (let h = 12; h < 18; h++) path[h] = 0;       // 6 h at 0 kW needs 1800 kWh and >250 kW
  assert.equal(F.simulate(path, C, batt).ok[2], false);
});

test('commitment is monotone in conservativeness and feasible for the required share', () => {
  const rnd = (() => { let a = 7; return () => ((a = (a * 16807) % 2147483647) / 2147483647); })();
  const paths = Array.from({ length: 40 }, () => Array.from({ length: F.HORIZON }, () => 200 + 300 * rnd()));
  const batt = { kwh: 1000, kw: 250, eta: 0.95, soc0: 500 };
  let prev = Infinity;
  for (const lvl of F.LADDER) {
    const c = F.commitBlock(paths, paths.map(() => batt.soc0), 0, lvl, batt);
    assert.ok(c <= prev + 1e-6, `level ${lvl}`); prev = c;
    if (lvl >= 0) {
      const ok = paths.filter((p) => F.stepBlock(p, 0, c, batt.soc0, batt).ok).length / paths.length;
      assert.ok(ok >= 1 - lvl - 1e-9);
    }
  }
  assert.equal(F.commitBlock(paths, paths.map(() => batt.soc0), 0, -1, batt), 0);
});

test('pooling never sells less than the sum of per-node commitments at the same level', () => {
  const rnd = (() => { let a = 11; return () => ((a = (a * 16807) % 2147483647) / 2147483647); })();
  const sc = Array.from({ length: 30 }, () => [0, 1, 2].map(() => Array.from({ length: F.HORIZON }, () => 100 + 380 * rnd())));
  const levels = new Array(F.NBLOCK).fill(0);
  const pooled = F.commit(sc.map((s) => F.sumPaths(s)), levels, F.fleetBattery(F.NODE, 3));
  const per = [0, 1, 2].map((k) => F.commit(sc.map((s) => s[k]), levels, F.nodeBattery(F.NODE)));
  assert.ok(pooled[0] + 1e-6 >= per.reduce((a, c) => a + c[0], 0));
});

test('analog scenarios on real buoy data: shape and continuity', () => {
  const buoys = JSON.parse(fs.readFileSync(new URL('../data/buoys.json', import.meta.url)));
  const fleet = F.buildFleet(buoys);
  const lib = F.library(fleet, [2023]);
  const t0 = F.origins(fleet, [2023], 24)[40];
  const sc = F.scenarios(fleet, lib, t0, 20);
  assert.equal(sc.length, 20);
  assert.equal(sc[0].length, fleet.ids.length);
  assert.equal(sc[0][0].length, F.HORIZON);
  // first hour stays near the current power because the analog offset is blended in
  const now = fleet.power[0][t0];
  const firstMed = sc.map((s) => s[0][0]).sort((a, b) => a - b)[10];
  assert.ok(Math.abs(firstMed - now) < 120, `${firstMed} vs ${now}`);
});

test('calibration hits its target in-sample on the calibration origins', () => {
  const buoys = JSON.parse(fs.readFileSync(new URL('../data/buoys.json', import.meta.url)));
  const fleet = F.buildFleet(buoys);
  const lib = F.library(fleet, [2023]);
  const cal = F.origins(fleet, [2023], 48);
  const r = F.calibrate(fleet, lib, cal, 0.95, 'pooled');
  assert.equal(r.levels.length, F.NBLOCK);
  r.rates.forEach((x, b) => assert.ok(x >= r.need - 1e-9 || r.levels[b] === -1, `block ${b} rate ${x}`));
});

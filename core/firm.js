// Firm compute capacity for a fleet of wave-powered compute nodes.
// Wave state (NOAA buoy Hs, mean period) -> node power -> analog-ensemble scenarios
// for the next 72 h -> battery-aware firm commitments per 6 h block, with the
// conservativeness of each block calibrated so realised delivery meets a target.

export const NODE = {
  ratedKW: 500,      // electrical cap (illustrative; public range is 200 kW to 1 MW per node)
  captureM: 8,       // effective capture width x wave-to-wire efficiency, metres
  hotelKW: 20,       // control, comms (Starlink), cooling pumps
  battKWh: 1000,     // onboard storage (assumed)
  battKW: 250,       // max charge/discharge power
  eta: 0.95,         // one-way battery efficiency
};
export const HORIZON = 72, BLOCK = 6, NBLOCK = HORIZON / BLOCK;

// Deep-water wave energy flux J = rho g^2 Hs^2 Te / (64 pi) ~= 0.49 Hs^2 Te kW/m,
// with energy period Te ~= 1.2 x mean zero-crossing period (Pierson-Moskowitz).
export function waveFluxKWm(hs, apd) { return 0.49 * hs * hs * 1.2 * apd; }
export function itPowerKW(hs, apd, n = NODE) {
  if (hs == null || apd == null) return null;
  const pe = Math.min(n.ratedKW, n.captureM * waveFluxKWm(hs, apd));
  return Math.max(0, pe - n.hotelKW);
}

// Build per-node hourly IT power arrays from the buoy file.
export function buildFleet(buoys, n = NODE) {
  const ids = Object.keys(buoys.buoys);
  const H = buoys.hours;
  const power = ids.map((id) => { const b = buoys.buoys[id]; return Array.from({ length: H }, (_, t) => itPowerKW(b.hs[t], b.apd[t], n)); });
  const hs = ids.map((id) => buoys.buoys[id].hs);
  const t0 = Date.parse(buoys.start);
  return { ids, names: ids.map((id) => buoys.buoys[id].name), H, power, hs, startMs: t0 };
}

const valid = (fleet, t) => t >= 24 && t < fleet.H && fleet.power.every((p) => p[t] != null && p[t - 6] != null && p[t - 24] != null);
export function futureValid(fleet, t) {
  if (t + HORIZON >= fleet.H) return false;
  for (const p of fleet.power) for (let h = 1; h <= HORIZON; h++) if (p[t + h] == null) return false;
  return true;
}
export function features(fleet, t) {
  const f = [];
  fleet.power.forEach((p, k) => {
    let m = 0, c = 0; for (let s = t - 24; s <= t; s++) if (p[s] != null) { m += p[s]; c++; }
    f.push(p[t], p[t] - p[t - 6], m / c, fleet.hs[k][t]);
  });
  const doy = ((fleet.startMs + t * 3600e3 - Date.UTC(new Date(fleet.startMs + t * 3600e3).getUTCFullYear(), 0, 1)) / 86400e3) / 365.25;
  f.push(Math.cos(2 * Math.PI * doy), Math.sin(2 * Math.PI * doy));
  return f;
}
export const FEATURE_W = [1.0, 0.5, 0.8, 0.5]; // per node, on standardised features: power, 6 h trend, 24 h mean, Hs

export function yearOf(fleet, t) { return new Date(fleet.startMs + t * 3600e3).getUTCFullYear(); }

// Library of candidate analog times in the given years.
export function library(fleet, years) {
  const out = [];
  for (let t = 24; t < fleet.H - HORIZON - 1; t++) if (years.includes(yearOf(fleet, t)) && valid(fleet, t) && futureValid(fleet, t)) out.push({ t, f: features(fleet, t) });
  const D = out[0].f.length;
  out.std = Array.from({ length: D }, (_, j) => { let m = 0; for (const c of out) m += c.f[j]; m /= out.length; let v = 0; for (const c of out) v += (c.f[j] - m) ** 2; return Math.sqrt(v / out.length) || 1; });
  return out;
}

// Analog ensemble: K nearest past states (all nodes jointly, so storms keep their
// spatial correlation); each analog's actual next 72 h becomes a scenario, with its
// starting offset blended out over ~12 h.
export function scenarios(fleet, lib, t0, K = 40, exclude = 240) {
  const f0 = features(fleet, t0);
  const nn = fleet.power.length;
  const w = []; for (let k = 0; k < nn; k++) w.push(...FEATURE_W); w.push(0.5, 0.5);
  const sd = lib.std;
  const d = [];
  for (const c of lib) {
    if (Math.abs(c.t - t0) < exclude) continue;
    let s = 0; for (let j = 0; j < f0.length; j++) { const e = (c.f[j] - f0[j]) / sd[j]; s += w[j] * e * e; }
    d.push([s, c.t]);
  }
  d.sort((a, b) => a[0] - b[0]);
  const picks = d.slice(0, K).map((x) => x[1]);
  return picks.map((tau) => fleet.power.map((p, k) => {
    const off = p[t0] - p[tau];
    return Array.from({ length: HORIZON }, (_, h) => Math.max(0, p[tau + h + 1] + off * Math.exp(-(h + 1) / 12)));
  }));
}

export function actual(fleet, t0) { return fleet.power.map((p) => Array.from({ length: HORIZON }, (_, h) => p[t0 + h + 1])); }

// Does a power path (kW, hourly) serve commitments C[b] with the battery? Returns
// per-block ok flags and the SOC trace.
export function simulate(path, C, batt) {
  let soc = batt.soc0;
  const ok = new Array(NBLOCK).fill(true);
  const socTrace = [];
  for (let h = 0; h < HORIZON; h++) {
    const b = Math.floor(h / BLOCK);
    const surplus = path[h] - C[b];
    if (surplus >= 0) soc = Math.min(batt.kwh, soc + Math.min(surplus, batt.kw) * batt.eta);
    else {
      const need = -surplus;
      if (need <= batt.kw + 1e-9 && soc >= need / batt.eta - 1e-9) soc -= need / batt.eta;
      else { ok[b] = false; soc = Math.max(0, soc - Math.min(need, batt.kw) / batt.eta); }
    }
    socTrace.push(soc);
  }
  return { ok, socTrace };
}

// Conservativeness ladder: scenario quantiles, then haircuts below the worst scenario.
export const LADDER = [0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0, -0.1, -0.2, -0.35, -0.5, -0.65, -0.8, -0.9, -1];
export const ladderName = (l) => (l >= 0 ? (l === 0 ? 'worst scenario' : `P${Math.round(l * 100)} scenario`) : l <= -1 ? 'no firm commitment' : `worst x ${(1 + l).toFixed(2)}`);

// One 6 h block: can a path serve commitment c starting from battery state soc?
export function stepBlock(path, b, c, soc, batt) {
  let ok = true;
  for (let h = b * BLOCK; h < (b + 1) * BLOCK; h++) {
    const surplus = path[h] - c;
    if (surplus >= 0) soc = Math.min(batt.kwh, soc + Math.min(surplus, batt.kw) * batt.eta);
    else {
      const need = -surplus;
      if (need <= batt.kw + 1e-9 && soc >= need / batt.eta - 1e-9) soc -= need / batt.eta;
      else { ok = false; soc = Math.max(0, soc - Math.min(need, batt.kw) / batt.eta); }
    }
  }
  return { ok, soc };
}

// Largest commitment for block b that the ladder level allows, given each scenario's
// battery state at the start of the block.
export function commitBlock(paths, socs, b, lvl, batt) {
  const S = paths.length;
  const need = lvl >= 0 ? 1 - lvl : 1;
  const frac = (c) => { let ok = 0; for (let s = 0; s < S; s++) if (stepBlock(paths[s], b, c, socs[s], batt).ok) ok++; return ok / S; };
  if (frac(0) < need - 1e-12) return 0;
  let lo = 0, hi = batt.kw;
  for (const p of paths) for (let h = b * BLOCK; h < (b + 1) * BLOCK; h++) hi = Math.max(hi, p[h] + batt.kw);
  for (let it = 0; it < 22; it++) { const mid = (lo + hi) / 2; if (frac(mid) >= need - 1e-12) lo = mid; else hi = mid; }
  return lvl < 0 ? lo * (1 + lvl) : lo;
}

// Commit all blocks in order (battery state carries over per scenario).
export function commit(paths, levels, batt) {
  const C = new Array(NBLOCK).fill(0);
  let socs = paths.map(() => batt.soc0);
  for (let b = 0; b < NBLOCK; b++) {
    C[b] = commitBlock(paths, socs, b, levels[b], batt);
    socs = paths.map((p, s) => stepBlock(p, b, C[b], socs[s], batt).soc);
  }
  return C;
}

// Aggregate scenarios / paths across nodes (pooled fleet: inference requests can be
// routed to any node over Starlink, so surplus at one node covers a deficit at another).
export const sumPaths = (paths) => paths[0].map((_, h) => paths.reduce((a, p) => a + p[h], 0));
export function fleetBattery(n, nodes, socFrac = 0.5) { return { kwh: n.battKWh * nodes, kw: n.battKW * nodes, eta: n.eta, soc0: n.battKWh * nodes * socFrac }; }
export function nodeBattery(n, socFrac = 0.5) { return fleetBattery(n, 1, socFrac); }

// Plan for one origin. mode: 'pooled' or 'per-node'. levels: ladder values per block.
export function plan(fleet, lib, t0, levels, mode = 'pooled', n = NODE, K = 40) {
  const sc = scenarios(fleet, lib, t0, K);
  const nn = fleet.power.length;
  if (mode === 'pooled') {
    const pooled = sc.map((s) => sumPaths(s));
    return { C: commit(pooled, levels, fleetBattery(n, nn)), sc, pooled };
  }
  const per = [];
  for (let k = 0; k < nn; k++) per.push(commit(sc.map((s) => s[k]), levels, nodeBattery(n)));
  const C = new Array(NBLOCK).fill(0).map((_, b) => per.reduce((a, c) => a + c[b], 0));
  return { C, per, sc };
}

// Realised delivery of a plan against what the ocean actually did.
export function realise(fleet, t0, planned, mode = 'pooled', n = NODE) {
  const act = actual(fleet, t0);
  if (mode === 'pooled') return simulate(sumPaths(act), planned.C, fleetBattery(n, fleet.power.length)).ok;
  const oks = planned.per.map((c, k) => simulate(act[k], c, nodeBattery(n)).ok);
  return oks[0].map((_, b) => oks.every((o) => o[b]));
}

export function origins(fleet, years, step = 6) {
  const out = [];
  for (let t = 24; t < fleet.H - HORIZON - 1; t += step) if (years.includes(yearOf(fleet, t)) && valid(fleet, t) && futureValid(fleet, t)) out.push(t);
  return out;
}

// Calibrate one ladder level per block on calibration origins: the least conservative
// level whose realised delivery rate is at least the target. Blocks are calibrated in
// order (battery state couples them), carrying each origin's scenario and actual
// battery states forward with the chosen level.
export function calibrate(fleet, lib, calOrigins, target, mode = 'pooled', n = NODE, K = 40) {
  const nn = fleet.power.length;
  const units = mode === 'pooled' ? [null] : fleet.power.map((_, k) => k);
  const batt = mode === 'pooled' ? fleetBattery(n, nn) : nodeBattery(n);
  // per origin, per unit: scenario paths, actual path, states
  const st = calOrigins.map((t0) => {
    const sc = scenarios(fleet, lib, t0, K), act = actual(fleet, t0);
    return units.map((k) => {
      const paths = k === null ? sc.map((s) => sumPaths(s)) : sc.map((s) => s[k]);
      const a = k === null ? sumPaths(act) : act[k];
      return { paths, a, socs: paths.map(() => batt.soc0), asoc: batt.soc0 };
    });
  });
  // split-conformal finite-sample correction: need ceil((n+1) * target) successes of n
  const nCal = st.length;
  const need = Math.min(1, Math.ceil((nCal + 1) * target) / nCal);
  const levels = [], rates = [];
  for (let b = 0; b < NBLOCK; b++) {
    let chosen = LADDER[LADDER.length - 1], rate = 0, chosenC = null;
    for (const lvl of LADDER) {
      let ok = 0; const Cs = [];
      for (const o of st) {
        let all = true; const cs = [];
        for (const u of o) { const c = commitBlock(u.paths, u.socs, b, lvl, batt); cs.push(c); if (!stepBlock(u.a, b, c, u.asoc, batt).ok) all = false; }
        Cs.push(cs); if (all) ok++;
      }
      rate = ok / st.length; chosen = lvl; chosenC = Cs;
      if (rate >= need - 1e-12) break;
    }
    levels.push(chosen); rates.push(rate);
    st.forEach((o, i) => o.forEach((u, j) => {
      const c = chosenC[i][j];
      u.socs = u.paths.map((p, s) => stepBlock(p, b, c, u.socs[s], batt).soc);
      u.asoc = stepBlock(u.a, b, c, u.asoc, batt).soc;
    }));
  }
  return { levels, rates, need };
}

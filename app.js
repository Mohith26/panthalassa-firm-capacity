import * as F from './core/firm.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
const pct = (v, d = 1) => (100 * v).toFixed(d);
const GPU_KW = 1.0; // kW per GPU-equivalent incl. host share (illustrative)

const [buoys, bt] = await Promise.all(['data/buoys.json', 'data/backtest.json'].map((u) => fetch(u).then((r) => r.json())));
const fleet = F.buildFleet(buoys);
const FWD = bt.forward;
const lib = F.library(fleet, [FWD.libYear]);
const test = F.origins(fleet, [FWD.testYear], 6);
const state = { target: '0.99', mode: 'pooled', i: 0 };

// default origin: the test origin where the fleet's real power fell the most over the next 72 h
let best = -1;
test.forEach((t0, i) => { const a = F.sumPaths(F.actual(fleet, t0)); const now = fleet.power.reduce((s, p) => s + p[t0], 0); const drop = now - Math.min(...a); if (drop > best) { best = drop; state.i = i; } });
$('origin').max = test.length - 1; $('origin').value = state.i;

const fmtDate = (t) => new Date(fleet.startMs + t * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const quant = (arr, q) => { const s = [...arr].sort((a, b) => a - b); const x = q * (s.length - 1); const lo = Math.floor(x), hi = Math.ceil(x); return s[lo] + (s[hi] - s[lo]) * (x - lo); };

function compute() {
  const t0 = test[state.i];
  const res = FWD.targets[state.target];
  const pooled = F.plan(fleet, lib, t0, res.pooled.levels, 'pooled');
  const per = F.plan(fleet, lib, t0, res.perNode.levels, 'per-node');
  const raw = F.plan(fleet, lib, t0, res.rawQuantile.levels, 'pooled');
  const cur = state.mode === 'pooled' ? pooled : per;
  const levels = state.mode === 'pooled' ? res.pooled.levels : res.perNode.levels;
  const ok = F.realise(fleet, t0, cur, state.mode);
  return { t0, res, pooled, per, raw, cur, levels, ok };
}

function renderKpis(c) {
  const r = c.res, m = state.mode === 'pooled' ? r.pooled : r.perNode;
  const firmAvg = c.cur.C.reduce((a, b) => a + b, 0) / c.cur.C.length;
  const cards = [
    ['Firm for the next 72 h', `${firmAvg.toFixed(0)}`, 'kW', `≈ ${Math.round(firmAvg / GPU_KW)} GPU-equivalents across ${fleet.ids.length} nodes`],
    [`Delivered in ${FWD.testYear} backtest`, pct(m.delivery), '%', `target ${pct(+state.target, 0)}% · ${state.mode === 'pooled' ? 'pooled' : 'per node'}, calibrated on ${FWD.libYear}`, 'y'],
    ['Raw forecast, same target', pct(r.rawQuantile.delivery), '%', `uncalibrated P${pct(1 - +state.target, 0)} of the ensemble`],
    ['Pooling gain', `${(r.pooled.firmKW / r.perNode.firmKW).toFixed(1)}×`, '', `firm kW pooled vs per node (${r.pooled.firmKW.toFixed(0)} vs ${r.perNode.firmKW.toFixed(0)})`],
  ];
  $('kpis').innerHTML = cards.map(([l, v, u, s, cls]) => `<div class="kpi ${cls || ''}"><div class="lab">${l}</div><div class="val">${v}<small>${u}</small></div><div class="sub">${s}</div></div>`).join('');
}

function renderChart(c) {
  const svg = $('chart'); svg.innerHTML = '';
  const W = 1240, H = 360, L = 56, R = 14, T = 16, B = 34;
  const pooledSc = c.pooled.sc.map((s) => F.sumPaths(s));
  const act = F.sumPaths(F.actual(fleet, c.t0));
  const now = fleet.power.reduce((s, p) => s + p[c.t0], 0);
  const p10 = [], p50 = [], p90 = [];
  for (let h = 0; h < F.HORIZON; h++) { const v = pooledSc.map((s) => s[h]); p10.push(quant(v, 0.1)); p50.push(quant(v, 0.5)); p90.push(quant(v, 0.9)); }
  const ymax = Math.max(400, ...p90, ...act, now) * 1.08;
  const X = (h) => L + (h / F.HORIZON) * (W - L - R), Y = (v) => T + (1 - v / ymax) * (H - T - B);
  const step = ymax > 1200 ? 400 : 200;
  const topTick = Math.floor(ymax / step) * step;
  for (let v = 0; v <= ymax; v += step) { el('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: '#d8e1ea' }, svg); el('text', { x: L - 8, y: Y(v) + 4, 'font-size': 12, fill: '#6b6f78', 'text-anchor': 'end' }, svg).textContent = v === topTick ? `${v} kW` : `${v}`; }
    for (let h = 0; h <= 72; h += 6) { el('line', { x1: X(h), x2: X(h), y1: T, y2: H - B, stroke: h % 24 === 0 ? '#cdc9c5' : '#eef1f4' }, svg); el('text', { x: X(h), y: H - B + 18, 'font-size': 12, fill: '#6b6f78', 'text-anchor': 'middle' }, svg).textContent = h === 0 ? 'now' : `+${h}h`; }
  const area = p90.map((v, h) => `${X(h + 1)},${Y(v)}`).concat(p10.map((v, h) => `${X(h + 1)},${Y(v)}`).reverse()).join(' ');
  el('polygon', { points: `${X(0)},${Y(now)} ${area} ${X(0)},${Y(now)}`, fill: 'rgba(114,146,170,.28)' }, svg);
  el('polyline', { points: `${X(0)},${Y(now)} ` + p50.map((v, h) => `${X(h + 1)},${Y(v)}`).join(' '), fill: 'none', stroke: '#7292aa', 'stroke-width': 2 }, svg);
  el('polyline', { points: `${X(0)},${Y(now)} ` + act.map((v, h) => `${X(h + 1)},${Y(v)}`).join(' '), fill: 'none', stroke: '#1c2c33', 'stroke-width': 2, 'stroke-dasharray': '5 4' }, svg);
  // firm commitment steps
  let d = '';
  c.cur.C.forEach((v, b) => { d += `${b === 0 ? 'M' : 'L'}${X(b * 6)},${Y(v)} L${X(b * 6 + 6)},${Y(v)} `; });
  el('path', { d: d + `L${X(72)},${Y(0)} L${X(0)},${Y(0)} Z`, fill: 'rgba(253,184,2,.16)' }, svg);
  el('path', { d, fill: 'none', stroke: '#fdb802', 'stroke-width': 3.5 }, svg);
  c.ok.forEach((ok, b) => { if (!ok) el('rect', { x: X(b * 6), y: T, width: X(6) - X(0), height: H - T - B, fill: 'rgba(253,184,2,.12)', stroke: '#fdb802', 'stroke-dasharray': '3 3' }, svg); });
  el('circle', { cx: X(0), cy: Y(now), r: 5, fill: '#1c2c33' }, svg);
  el('text', { x: X(0) + 9, y: Y(now) - 8, 'font-size': 13, fill: '#1c2c33', 'font-weight': 500 }, svg).textContent = `${now.toFixed(0)} kW now`;
  // blocks
  $('blocks').innerHTML = c.cur.C.map((v, b) => `<div class="blk ${c.ok[b] ? '' : 'miss'}"><b>${v.toFixed(0)}</b>${c.ok[b] ? 'kept' : 'missed'}<div class="lv">${F.ladderName(c.levels[b])}</div></div>`).join('');
}

function renderNodes(c) {
  const act = F.actual(fleet, c.t0);
  $('nodes').innerHTML = '';
  fleet.ids.forEach((id, k) => {
    const div = document.createElement('div'); div.className = 'node';
    const now = fleet.power[k][c.t0], hs = fleet.hs[k][c.t0];
    const firmK = c.per.per[k].reduce((a, b) => a + b, 0) / F.NBLOCK;
    const mean72 = act[k].reduce((a, b) => a + b, 0) / F.HORIZON;
    div.innerHTML = `<h3>Node ${String.fromCharCode(65 + k)} · station ${id}</h3><div class="loc">${fleet.names[k]}</div>
      <div class="stats"><div><b>${hs.toFixed(1)} m</b>Hs now</div><div><b>${now.toFixed(0)} kW</b>IT power now</div><div><b>${firmK.toFixed(0)} kW</b>firm alone</div></div>`;
    const s = el('svg', { viewBox: '0 0 400 70', preserveAspectRatio: 'none' });
    const sc = c.pooled.sc.map((x) => x[k]);
    const lo = [], hi = [];
    for (let h = 0; h < F.HORIZON; h++) { const v = sc.map((x) => x[h]); lo.push(quant(v, 0.1)); hi.push(quant(v, 0.9)); }
    const X = (h) => (h / (F.HORIZON - 1)) * 400, Y = (v) => 66 - (v / (F.NODE.ratedKW - F.NODE.hotelKW)) * 62;
    el('polygon', { points: hi.map((v, h) => `${X(h)},${Y(v)}`).concat(lo.map((v, h) => `${X(h)},${Y(v)}`).reverse()).join(' '), fill: 'rgba(114,146,170,.4)' }, s);
    el('polyline', { points: act[k].map((v, h) => `${X(h)},${Y(v)}`).join(' '), fill: 'none', stroke: '#fcfbf9', 'stroke-width': 1.6, 'stroke-dasharray': '4 3' }, s);
    el('line', { x1: 0, x2: 400, y1: Y(firmK), y2: Y(firmK), stroke: '#fdb802', 'stroke-width': 2 }, s);
    div.appendChild(s);
    const foot = document.createElement('div'); foot.className = 'loc'; foot.style.margin = '6px 0 0'; foot.textContent = `Next 72 h actual mean ${mean72.toFixed(0)} kW · yellow = firm if committed alone`;
    div.appendChild(foot);
    $('nodes').appendChild(div);
  });
}

function renderBacktest() {
  const t99 = FWD.targets['0.99'], t95 = FWD.targets['0.95'];
  const row = (name, a, b, hl) => `<tr class="${hl ? 'hl' : ''}"><td>${name}</td><td>${pct(a.delivery)}%</td><td>${a.firmKW.toFixed(0)} kW</td><td>${pct(b.delivery)}%</td><td>${b.firmKW.toFixed(0)} kW</td></tr>`;
  $('btNote').textContent = `${FWD.testOrigins} forecast origins in ${FWD.testYear}, every 6 h · analogs and calibration from ${FWD.libYear} only`;
  $('btTable').innerHTML = `<table class="bt"><tr><th>Policy (fleet of ${fleet.ids.length})</th><th>Delivered @ 99% target</th><th>Firm sold</th><th>Delivered @ 95% target</th><th>Firm sold</th></tr>
    ${row('Pooled, calibrated (this feature)', t99.pooled, t95.pooled, true)}
    ${row('Per node, calibrated', t99.perNode, t95.perNode)}
    ${row('Pooled, raw forecast quantile', t99.rawQuantile, t95.rawQuantile)}
    ${row('Persistence (hold current power)', t99.persistence, t95.persistence)}</table>`;
  const rv = bt.reverse.targets['0.99'];
  $('btFoot').textContent = `Mean available fleet IT power in ${FWD.testYear}: ${t99.meanAvailableKW.toFixed(0)} kW. Reverse split (analogs and calibration from ${bt.reverse.libYear}, tested on ${bt.reverse.testYear}) at 99%: pooled ${pct(rv.pooled.delivery)}% delivered with ${rv.pooled.firmKW.toFixed(0)} kW firm, per node ${pct(rv.perNode.delivery)}% with ${rv.perNode.firmKW.toFixed(0)} kW, raw quantile ${pct(rv.rawQuantile.delivery)}%. Out-of-sample delivery can land slightly under target when the test year's sea states differ from the calibration year.`;
}

function render() {
  const c = compute();
  $('originLabel').textContent = fmtDate(c.t0);
  $('bandSub').textContent = `Ocean-3 pilot fleet · ${fleet.ids.length} nodes holding station near NOAA buoys ${fleet.ids.join(', ')} · battery ${F.NODE.battKWh / 1000} MWh per node`;
  renderKpis(c); renderChart(c); renderNodes(c);
}
$('origin').addEventListener('input', (e) => { state.i = +e.target.value; render(); });
$('targetSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.target = b.dataset.t; $('targetSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); render(); }));
$('modeSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.m; $('modeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); render(); }));
renderBacktest(); render();
window.__ready = true;

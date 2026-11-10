# Firm Capacity (concept for Panthalassa's compute fleet)

**Live demo:** https://mohith26.github.io/panthalassa-firm-capacity/

Wave power is cheap but it moves. This page answers the question a compute customer will ask: **how much inference capacity can you promise me for each of the next 72 hours, and how often will you actually keep that promise?**

It is an unofficial concept page for a Panthalassa fleet console, built on **real NOAA buoy data**.

## How it works

1. **Ocean to kilowatts.** Hourly significant wave height and mean period from three deep-water NOAA NDBC buoys (46005 off Washington, 46006 Southeast Papa, 46059 off California) become wave energy flux, J ≈ 0.49 Hs² Te kW/m with Te ≈ 1.2 × mean period. An illustrative node power curve then gives IT power: effective capture width 8 m, 500 kW cap, 20 kW hotel load. Each node is assumed to hold station near one buoy.
2. **Analog-ensemble forecast.** For a forecast origin, it finds the 40 most similar past states of the *whole fleet* from a library year. Similarity uses each node's power, 6 h trend, 24 h mean, wave height and season. Each analog's real next 72 hours becomes a scenario, so storms keep their spatial correlation across nodes. The analog's starting offset is blended out over about 12 h.
3. **Battery-aware firm commitments.** For each 6 h block it finds the largest firm load the chosen share of scenarios can serve, tracking each scenario's battery state from block to block (1 MWh / 250 kW per node, assumed). In **pooled** mode, requests can be routed to any node over Starlink, so one node's surplus covers another's lull.
4. **Calibration.** The raw ensemble is overconfident. For each block, a calibration year picks the least conservative rung of a ladder (scenario quantiles, then haircuts below the worst scenario, then no firm commitment) whose realised delivery meets the target. That uses the split-conformal finite-sample rule ⌈(n+1)·target⌉/n. Blocks are calibrated in order because battery state couples them.

Every number on the page is computed in the browser from `data/buoys.json` by `core/firm.js`. The per-block calibrated levels and the backtest table come from `scripts/backtest.js`, which runs the same module.

## Results (out of sample)

Analog library and calibration use 2023; tests use 730 origins in 2024, every 6 h. The reverse split is in brackets.

| Policy (3 nodes) | Delivered @ 99% target | Firm sold | Delivered @ 95% | Firm sold |
|---|---|---|---|---|
| Pooled, calibrated | 98.6% [99.7%] | 245 kW [250] | 95.1% | 335 kW |
| Per node, calibrated | 99.7% [99.2%] | 103 kW [154] | 93.7% | 222 kW |
| Pooled, raw ensemble quantile | 92.4% [93.5%] | 387 kW | 88.7% | 441 kW |
| Persistence (hold current power) | 66.6% | 712 kW | 66.6% | 712 kW |

Mean available fleet IT power in 2024 was 704 kW.

- **The raw forecast is overconfident.** Its own 1-in-100 low was kept only 92.4% of the time. Calibrated, the pooled plan kept 98.6%.
- **Pooling is worth about 2.4×** (1.6× in the reverse split) in firm compute versus committing each node alone, because storms and lulls don't line up across nodes hundreds of miles apart.
- **Honest caveat:** out of sample, the pooled plan landed slightly under its 99% target (98.6%) in the forward split and over it (99.7%) in the reverse. Calibration only guarantees the target when the test year's sea states look like the calibration year's, so a production version should recalibrate on a rolling window.

## Run it

```
python3 scripts/fetch_ndbc.py    # downloads NDBC history (~4 MB) and writes data/buoys.json
node --test test/*.test.js       # 7 tests: wave-flux constant, power curve, battery, monotone ladder, pooling >= per-node, analogs on real data, calibration
node scripts/backtest.js         # ~20 s, writes data/backtest.json
```

## Limitations

- **The node model is illustrative.** Public statements put a node at 200 kW to 1 MW (nominal about 400 kW). The capture width, cap, hotel load and battery here are my assumptions, not Panthalassa specs.
- **The forecast uses analogs from buoy history.** That's because archived wave *forecasts* (e.g. NOAA WaveWatch III) are not easy to pull for a backtest. A production version should condition on WW3 forecasts, which should tighten the intervals and raise firm capacity.
- **Nodes are pinned to buoy locations.** Real nodes move, and repositioning ahead of a lull is a lever this ignores.
- **Pooling assumes stateless inference that can be rerouted instantly across nodes.** Long-running or stateful jobs would need migration cost modelled.
- Only two years have joint coverage across the three buoys, so each split calibrates on one year.

## Novelty note

I checked Panthalassa's site, press (Series B May 2026, NAVER investment Aug 2026, Vancouver factory Nov 2026), the Latitude Media and TBPN interviews, and job posts. None of them describe capacity-commitment tooling. Renewable-aware data-center scheduling for wind and solar is a mature research area, e.g. workload shaping (IEEE CLOUD 2014), wind-park data centers (Applied Energy 2026) and renewable-colocated AI data centers (arXiv 2507.08011). What's new here is off-grid, wave-powered firm-capacity commitments with battery-aware, conformally calibrated delivery, and a measured pooling benefit across a fleet on real buoy data.

Unofficial concept demo by Mohith Gajjela. Not affiliated with Panthalassa. Public data from NOAA National Data Buoy Center.

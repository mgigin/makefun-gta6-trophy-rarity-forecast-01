// gta6-trophy-rarity-forecast-01 entry v2: counts-anchored trend forecaster (Node 22+, standard library only).
//
// A trophy's printed rate is a count ratio: earners / tracked players, rounded to 2 decimals. Earners are
// cumulative integers (they never decrease); tracked players jump upward at Exophase refreshes. So this
// program forecasts the two counts separately and divides, but unlike a plain whole-history trend fit it:
//
//   * recovers integer earners from each read (round(rate/100 * players)) instead of fitting noisy rates;
//   * fits log-count trends against log(1 + hours since the first read) on a recent window only (last 72h),
//     so the frozen launch-night segment does not flatten the slopes that matter for the final's horizon;
//   * anchors every forecast at the last observed count and applies the (tier-shrunk) slope over the
//     remaining log-time gap, so shrinkage cannot bias the level away from the latest read;
//   * never lets earners fall below their last count, and caps them at the players forecast;
//   * sizes the logit-scale spread from three parts: a base term, pooled fit residuals, a horizon term
//     growing with sqrt(days), and a count-noise term ~ 1/sqrt(earners + 1) so rare trophies (a handful
//     of earners) get honestly wider quantiles than common ones.
//
// Deterministic: same input bytes, same output bytes. No network, no clock, no randomness.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const Z = [-1.645, -0.674, 0, 0.674, 1.645];

interface Trophy { id: number; tier: string; points: number; secret: boolean }
interface Read { slot: string; players_tracked: number; rates: Array<number | null> }
interface Case {
  at: string;
  target: string;
  horizon_minutes: number;
  trophies: Trophy[];
  history: Read[];
}

const clampRate = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clampRate(pct) / (100 - clampRate(pct)));
const invLogit = (x: number): number => 100 / (1 + Math.exp(-x));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

interface Fit { b: number; resid: number; n: number }

/** Slope and residual sd of y ~ a + b*x by least squares (level is re-anchored later, so `a` is unused). */
function slopeFit(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  if (n < 2) return { b: 0, resid: 0, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i] - (a + b * xs[i])) ** 2;
  return { b, resid: n > 2 ? Math.sqrt(ss / (n - 2)) : 0, n };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();

for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const reads = c.history;
  if (reads.length === 0) throw new Error(`${file} has no history`);

  const t0 = Date.parse(reads[0].slot);
  const hours = reads.map((r) => Math.max(0, (Date.parse(r.slot) - t0) / 3_600_000));
  const xOf = (h: number): number => Math.log1p(h);
  const xLast = xOf(hours[hours.length - 1]);
  const xTarget = xOf(Math.max(0, (Date.parse(c.target) - t0) / 3_600_000));
  const dx = Math.max(0, xTarget - xLast);
  const horizonDays = Math.max(0, c.horizon_minutes / 1440);

  // Recent window for slope fits: reads from the last 72 hours before the checkpoint, all reads if sparse.
  const atMs = Date.parse(c.at);
  let winStart = 0;
  for (let j = 0; j < reads.length; j++) {
    if (Date.parse(reads[j].slot) >= atMs - 72 * 3_600_000) { winStart = j; break; }
    winStart = j;
  }
  if (reads.length - winStart < 8) winStart = 0;

  // Tracked players: recent log-trend, anchored at the last read, never shrinking.
  const pXs: number[] = [];
  const pYs: number[] = [];
  for (let j = winStart; j < reads.length; j++) {
    pXs.push(xOf(hours[j]));
    pYs.push(Math.log(Math.max(1, reads[j].players_tracked)));
  }
  const pFit = slopeFit(pXs, pYs);
  const playersNow = Math.max(1, reads[reads.length - 1].players_tracked);
  const playersForecast = clamp(
    playersNow * Math.exp(clamp(pFit.b, 0, 3) * dx),
    playersNow,
    playersNow * 40,
  );

  // Per-trophy integer earners and recent log-trend slopes.
  const fits: Fit[] = [];
  const lastEarners: number[] = [];
  const lastRates: number[] = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const xs: number[] = [];
    const ys: number[] = [];
    let lastEarn = 0;
    let lastRate = 0;
    for (let j = 0; j < reads.length; j++) {
      const rate = reads[j].rates[i];
      if (rate === null || rate === undefined) continue;
      const earners = Math.round((rate / 100) * Math.max(1, reads[j].players_tracked));
      if (j >= winStart) {
        xs.push(xOf(hours[j]));
        ys.push(Math.log1p(earners));
      }
      lastEarn = earners;
      lastRate = rate;
    }
    fits.push(slopeFit(xs, ys));
    lastEarners.push(lastEarn);
    lastRates.push(lastRate);
  }

  const tierSlope = new Map<string, { sum: number; n: number }>();
  c.trophies.forEach((t, i) => {
    if (fits[i].n < 4) return;
    const cur = tierSlope.get(t.tier) ?? { sum: 0, n: 0 };
    cur.sum += fits[i].b;
    cur.n += 1;
    tierSlope.set(t.tier, cur);
  });

  // Pooled residual scale from the recent earners fits (log-count residuals track logit residuals at low rates).
  const residPool = fits.filter((f) => f.n >= 4).map((f) => f.resid);
  const pooled = residPool.length > 0 ? residPool.reduce((s, v) => s + v, 0) / residPool.length : 0.25;
  const horizonTerm = 0.32 * Math.sqrt(horizonDays);

  const trophies = c.trophies.map((t, i) => {
    const fit = fits[i];
    const tier = tierSlope.get(t.tier);
    const tierB = tier && tier.n > 0 ? tier.sum / tier.n : fit.b;
    const w = fit.n / (fit.n + 10);
    const slope = clamp(w * fit.b + (1 - w) * tierB, -0.3, 3.5);
    const eLast = lastEarners[i];
    let earnersForecast = Math.expm1(Math.log1p(eLast) + slope * dx);
    earnersForecast = Math.max(earnersForecast, eLast); // earners are cumulative: never decrease
    earnersForecast = Math.min(earnersForecast, playersForecast);
    if (eLast === 0) earnersForecast = 0.25; // nobody yet: expect a fraction of one earner

    let median = (100 * earnersForecast) / playersForecast;
    if (lastRates[i] >= 99.99) median = 99.95; // the everyone-has-it trophy stays at the top
    median = clampRate(median);

    const countNoise = 0.85 / Math.sqrt(eLast + 1);
    const sigma = clamp(
      Math.sqrt(0.22 ** 2 + 0.5 * pooled ** 2 + horizonTerm ** 2 + countNoise ** 2),
      0.25,
      1.7,
    );
    const l = logit(median);
    const q = Z.map((z) => round4(Math.min(100, Math.max(0, invLogit(l + z * sigma)))));
    for (let k = 1; k < q.length; k++) if (q[k] < q[k - 1]) q[k] = q[k - 1];
    return { id: t.id, q };
  });

  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}

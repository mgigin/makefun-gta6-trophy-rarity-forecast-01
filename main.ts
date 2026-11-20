// gta6-trophy-rarity-forecast-01 entry: earners-and-players trend forecaster (Node 22+, standard library only).
//
// Idea: a trophy's rarity rate is earners / tracked players. The two move for different reasons in the first
// week after launch — the tracked-player count jumps in steps as the tracker refreshes, while earners climb
// smoothly as players progress. So instead of extrapolating the rate directly, this program models the two
// parts separately and divides:
//
//   * players(t):  log players against log(1 + hours since the first read), one global fit over all reads.
//   * earners_i(t): log(1 + earners) against log(1 + hours) per trophy, with the slope shrunk toward the
//     average slope of the trophy's tier (bronze/silver/gold/platinum) when the trophy has few reads or a
//     noisy fit. Earners are recovered from each read as rate/100 * players_tracked.
//
// The median forecast is earners(target) / players(target). Uncertainty is put on the logit scale: a pooled
// residual scale from the per-trophy fits, grown with sqrt(horizon in days) and floored so flat practice
// histories do not produce overconfident quantiles. Quantiles use the standard normal's z at the five levels
// the contest scores (0.05, 0.25, 0.5, 0.75, 0.95).
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

interface Fit { a: number; b: number; resid: number; n: number }

/** Ordinary least squares y ~ a + b*x; resid is the residual standard deviation (0 with <3 points). */
function ols(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  if (n === 0) return { a: 0, b: 0, resid: 0, n: 0 };
  if (n === 1) return { a: ys[0], b: 0, resid: 0, n: 1 };
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
  return { a, b, resid: n > 2 ? Math.sqrt(ss / (n - 2)) : 0, n };
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
  const targetHours = Math.max(0, (Date.parse(c.target) - t0) / 3_600_000);
  const xTarget = xOf(targetHours);
  const horizonDays = Math.max(0, c.horizon_minutes / 1440);

  // Global tracked-players curve.
  const pFit = ols(hours.map(xOf), reads.map((r) => Math.log(Math.max(1, r.players_tracked))));
  const playersNow = Math.max(1, reads[reads.length - 1].players_tracked);
  // Cap the players forecast: at most a doubling per day of horizon, never below the last read's count.
  const playersForecast = Math.min(
    Math.max(playersNow, Math.exp(pFit.a + pFit.b * xTarget)),
    playersNow * Math.pow(2, Math.max(1, horizonDays)),
  );

  // Per-trophy earners fits, then tier-average slopes for shrinkage.
  const fits: Fit[] = [];
  const lastRates: number[] = [];
  const lastEarners: number[] = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const xs: number[] = [];
    const ys: number[] = [];
    let lastRate = 0;
    let lastEarn = 0;
    for (let j = 0; j < reads.length; j++) {
      const rate = reads[j].rates[i];
      if (rate === null || rate === undefined) continue;
      const earners = (rate / 100) * Math.max(1, reads[j].players_tracked);
      xs.push(xOf(hours[j]));
      ys.push(Math.log1p(earners));
      lastRate = rate;
      lastEarn = earners;
    }
    fits.push(ols(xs, ys));
    lastRates.push(lastRate);
    lastEarners.push(lastEarn);
  }

  const tierSlope = new Map<string, { sum: number; n: number }>();
  c.trophies.forEach((t, i) => {
    if (fits[i].n < 3) return;
    const cur = tierSlope.get(t.tier) ?? { sum: 0, n: 0 };
    cur.sum += fits[i].b;
    cur.n += 1;
    tierSlope.set(t.tier, cur);
  });

  // Pooled residual scale on the logit scale (converted from log-earners residuals, roughly 1:1 at low rates).
  const residPool = fits.filter((f) => f.n >= 3).map((f) => f.resid);
  const pooled = residPool.length > 0 ? residPool.reduce((s, v) => s + v, 0) / residPool.length : 0.2;
  const sigma = Math.min(1.2, Math.max(0.18, pooled) + 0.42 * Math.sqrt(horizonDays));

  const trophies = c.trophies.map((t, i) => {
    const fit = fits[i];
    const tier = tierSlope.get(t.tier);
    const tierB = tier && tier.n > 0 ? tier.sum / tier.n : fit.b;
    // Shrinkage weight: more reads, less shrinkage. Clamp the slope so a short noisy history
    // cannot extrapolate into an explosive earners curve over a multi-day horizon.
    const w = Math.min(1, fit.n / 12);
    const slope = Math.min(3, Math.max(-0.5, w * fit.b + (1 - w) * tierB));
    const earnersForecast = Math.max(
      lastEarners[i],
      Math.expm1(fit.a + slope * xTarget),
    );
    let median = (100 * earnersForecast) / playersForecast;
    // A trophy nobody has earned yet stays near zero; give it a small tier-based ceiling instead of a trend.
    if (lastEarners[i] < 0.5) median = Math.min(median, 100 / playersForecast);
    median = clampRate(median);
    const l = logit(median);
    const q = Z.map((z) => round4(Math.min(100, Math.max(0, invLogit(l + z * sigma)))));
    // Enforce non-decreasing after rounding.
    for (let k = 1; k < q.length; k++) if (q[k] < q[k - 1]) q[k] = q[k - 1];
    return { id: t.id, q };
  });

  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}

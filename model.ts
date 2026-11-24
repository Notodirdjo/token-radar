// Token Launch Radar, model radar-3: the sealed snapshot in, a ranked board out.
//
// What the model claims. A protocol that records no token may issue one one
// day; this radar prices that possibility from the snapshot's own figures and
// tells a reader how to farm it. It never predicts whether or when a token
// launches, and it never special-cases a protocol by name: one function scores
// every row, and every number below is fitted from the snapshot at run time.
//
//   Value.  On the traded comps (protocols with a market cap, outside the
//           excluded categories), fit ln(mcap) = a + b*ln(TVL) plus a sector
//           effect per category, shrunk toward zero by n/(n+10) so a category
//           with one or two comps cannot hijack the board. Candidate extra
//           terms (log age, 7-day growth) are kept only when they lower the
//           held-out miss in BOTH leave-one-out and walk-forward splits; on
//           this snapshot both are dropped. Held-out miss is the geometric
//           mean of max(pred/actual, actual/pred), reported as xN.N.
//   Odds.   P(token) per protocol from a logistic fit on all 758 protocols
//           (outcome: the record carries a token), against an age-bucket
//           table; the winner is picked on 10-fold CV Brier and walk-forward
//           Brier, and must beat the base rate on both.
//   Implied value = fitted market cap x P(token). Ranges come from the value
//           fit's residual quantiles (P25-P75, P10-P90).
//   Farm economics. One function E(row, deposit, dropShare, weeks) prices a
//           farm: the reader's share of the drop is their deposit over the
//           assumed active-farmer capital (5% of TVL), minus chain-aware gas
//           and the deposit's opportunity cost. Verdicts follow from net $
//           and $/hour; the dashboard's sliders recompute the same E.
//
// The board ranks every rankable pre-token protocol: no token recorded, not
// an excluded category, no version marker in the name, no wrapped/staked/
// staking whole word, no exchange prefix. That is 198 rows on this snapshot:
// the 40 watchlist rows, 138 below the floor, and 20 at or above the floor
// that the watchlist leaves out.

import { createHash } from 'node:crypto';

/** One protocol entry of the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One row of board.json: the ranked board's row, nothing more. */
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

/** One ranked row as the dashboard reads it from data.js. */
export interface RadarRow {
  slug: string;
  name: string;
  cat: string | null;
  chains: string[];
  tvl: number;
  chg: number | null;
  age: number | null;
  listed: string | null;
  wl: boolean;
  rank: number;
  implied: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  odds: number;
  mult: number;
  sector: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  net: number;
  perHour: number;
  gas: number;
  gasTx: number;
  hours: number;
  weeks: number;
  farm: string[];
}

/** One live-token protocol for the dashboard's comps tab. */
export interface LiveComp {
  slug: string;
  name: string;
  cat: string | null;
  tvl: number;
  mcap: number;
  mult: number;
}

/** Everything the dashboard renders, written to data.js as window.RADAR. */
export interface RadarData {
  meta: {
    asOf: string;
    floorUsd: number;
    model: string;
    formula: string;
    coef: { a: number; b: number; sector: Record<string, number> };
    econ: { formula: string; params: Record<string, unknown> };
    counts: { protocols: number; rankable: number; watchlist: number; live: number; farm: number; marginal: number; skip: number };
  };
  validation: {
    value: { loo: number; wf: number; flatLoo: number; flatWf: number; n: number; kept: string[]; dropped: string[] };
    odds: { brier10: number; brierWf: number; brierBase: number; n: number };
    coverage: { p2575: number; p1090: number };
  };
  accounting: { label: string; n: number }[];
  rows: RadarRow[];
  comps: LiveComp[];
  integrity: { checks: { name: string; ok: boolean; detail: string }[]; checksum: string };
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export const MODEL_VERSION = 'radar-3';

/** Categories the watchlist rule excludes: bridged, staked and CEX products. */
export const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names a rankable protocol's name must not start with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A name ending in a version marker (V2, v2, 2.0 and the like) is a pool of another protocol. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word wrapped, staked or staking marks a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Sector-effect shrinkage: a category's effect is weighted n/(n+SHRINK_K). */
const SHRINK_K = 10;

/** Walk-forward split: the oldest 70% of dated rows train, the newest 30% test. */
const WALK_FORWARD_TRAIN_SHARE = 0.7;

/** Gradient descent for the odds model: fixed steps, no randomness. */
const LOGISTIC_ITERS = 2000;
const LOGISTIC_LR = 0.5;
const LOGISTIC_L2 = 1.0;

/** Shrinkage for the category token-rate feature (pseudo-count) and the age buckets. */
const CATEGORY_RATE_SHRINK = 10;
const BUCKET_SHRINK = 20;

/** Typical cost in USD of one simple transaction on each chain; the default covers the rest. */
export const GAS_TABLE: Record<string, number> = {
  Ethereum: 4.0, Bitcoin: 2.0, Avalanche: 0.3, Starknet: 0.3, Tron: 0.3,
  Arbitrum: 0.3, Optimism: 0.25, 'zkSync Era': 0.25, Linea: 0.2, Scroll: 0.2,
  Blast: 0.2, BSC: 0.2, Binance: 0.2, Berachain: 0.2, Stacks: 0.2,
  Base: 0.15, Mantle: 0.15, Fraxtal: 0.15, Ink: 0.15, Unichain: 0.15,
  Manta: 0.15, Morph: 0.15, Hyperliquid: 0.1, Sonic: 0.1, Monad: 0.1,
  Cronos: 0.1, Mode: 0.1, Zora: 0.1, Abstract: 0.1, 'World Chain': 0.1,
  Kava: 0.1, Klaytn: 0.1, 'Plume Mainnet': 0.1, Bittensor: 0.1, RSK: 0.1,
  Polygon: 0.05, Solana: 0.05, Sui: 0.05, Aptos: 0.05, Sei: 0.05,
  Gnosis: 0.05, Fantom: 0.05, Celo: 0.05, MegaETH: 0.05, 'Hyperliquid L1': 0.05,
  Ronin: 0.05, Flare: 0.05, XION: 0.05, Noble: 0.05,
  Algorand: 0.01, Stellar: 0.01, Ripple: 0.01,
};
export const GAS_DEFAULT = 0.5;

/** Farm-economics constants: the defaults the board is priced at and the sliders start from. */
export const ECON = {
  deposit: 1000,
  dropShare: 0.05,
  weeks: 12,
  eligibleShare: 0.05,
  apy: 0.05,
  setupTx: 2,
  weeklyTx: 1,
  setupHours: 2,
  weeklyHours: 0.5,
  extraChainHours: 0.25,
  maxExtraChains: 4,
  farmNetMin: 50,
  farmPerHourMin: 10,
} as const;

/** The farm-economics formula, in words, for the dashboard and the dossier. */
export const ECON_FORMULA =
  'gross = implied * dropShare * deposit / (deposit + 0.05*TVL) * min(weeks,12)/12; ' +
  'gas = gasPerTx * (2 + weeks); opp = deposit * 0.05 * weeks/52; net = gross - gas - opp; ' +
  'hours = 2 + 0.5*weeks + 0.25*min(max(chains-1,0),4); perHour = net / hours; ' +
  'FARM if net >= $50 and perHour >= $10, MARGINAL if net > $0, else SKIP';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- parsing

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof doc.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols: SnapshotProtocol[] = doc.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new SnapshotError(`snapshot.json protocol ${i} is not an object`);
    }
    const p = entry as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
    }
    const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: numOrNull(p.change_7d),
      mcap_usd: numOrNull(p.mcap_usd),
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: doc.as_of,
    source: doc.source,
    floor_usd: doc.floor_usd,
    protocols,
    watchlist: doc.watchlist as string[],
  };
}

/** Whole days from `listedAt` to `asOf`, at least zero; null when the listing date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** Whether a protocol records no token at all: no CoinGecko id and no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** Why a pre-token protocol is not rankable, or null when it is rankable. */
export function exclusionReason(p: SnapshotProtocol): 'excluded_category' | 'versioned_name' | 'wrapped_or_staked_word' | 'exchange_prefixed' | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 'excluded_category';
  if (VERSIONED_NAME.test(p.name)) return 'versioned_name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped_or_staked_word';
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return 'exchange_prefixed';
  return null;
}

/** Whether the board may rank a protocol: pre-token and not excluded by any rule above. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && exclusionReason(p) === null;
}

// ---------------------------------------------------------------- small maths

/** The median of a non-empty list (the middle value, or the mean of the middle two). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A quantile of an already-sorted list, by linear interpolation. */
function quantile(sorted: number[], prob: number): number {
  const pos = prob * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const roundTo = (v: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(v * scale) / scale;
};

/**
 * Solve a small dense linear system by Gauss-Jordan elimination with partial
 * pivoting. The design here is at most 4 columns, so no library is needed.
 */
function solveLinear(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const aug = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row]![col]!) > Math.abs(aug[pivot]![col]!)) pivot = row;
    }
    const tmp = aug[col]!;
    aug[col] = aug[pivot]!;
    aug[pivot] = tmp;
    const scale = aug[col]![col]!;
    if (Math.abs(scale) < 1e-12) throw new Error('singular system in least squares');
    for (let j = col; j <= n; j++) aug[col]![j]! /= scale;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row]![col]!;
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) aug[row]![j]! -= factor * aug[col]![j]!;
    }
  }
  return aug.map((row) => row[n]!);
}

/** Ordinary least squares through the normal equations, with a hair of ridge for stability. */
function leastSquares(design: number[][], targets: number[]): number[] {
  const cols = design[0]!.length;
  const xtx: number[][] = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
  const xty: number[] = new Array<number>(cols).fill(0);
  for (let i = 0; i < design.length; i++) {
    const row = design[i]!;
    for (let a = 0; a < cols; a++) {
      xty[a]! += row[a]! * targets[i]!;
      for (let b = 0; b < cols; b++) xtx[a]![b]! += row[a]! * row[b]!;
    }
  }
  for (let a = 0; a < cols; a++) xtx[a]![a]! += 1e-8;
  return solveLinear(xtx, xty);
}

/** Geometric mean of max(pred/actual, actual/pred): the held-out miss, as xN.N. */
function geometricMiss(predicted: number[], actual: number[]): number {
  let total = 0;
  for (let i = 0; i < predicted.length; i++) total += Math.abs(Math.log(predicted[i]!) - Math.log(actual[i]!));
  return Math.exp(total / predicted.length);
}

/** The mean squared error of probabilities against 0/1 outcomes: the Brier score. */
function brierScore(predicted: number[], actual: number[]): number {
  let total = 0;
  for (let i = 0; i < predicted.length; i++) total += (predicted[i]! - actual[i]!) ** 2;
  return total / predicted.length;
}

// ---------------------------------------------------------------- value model

/** Candidate extra terms for the log-mcap regression, beyond log TVL. */
export type ValueTerm = 'ln_age' | 'chg7d';
const VALUE_TERM_SETS: ValueTerm[][] = [[], ['ln_age'], ['chg7d'], ['ln_age', 'chg7d']];

/** A fitted value model: coefficients, sector effects and residual quantiles (log points). */
export interface ValueFit {
  beta: number[];
  sector: Record<string, number>;
  q10: number;
  q25: number;
  q75: number;
  q90: number;
}

/** The regression's features for one protocol: log TVL, then each kept term. */
function valueFeatures(p: SnapshotProtocol, asOf: string, terms: ValueTerm[], medAge: number, medChg: number): number[] {
  const features = [Math.log(p.tvl_usd)];
  if (terms.includes('ln_age')) {
    const age = ageDays(asOf, p.listed_at);
    features.push(Math.log(age !== null && age > 0 ? age : medAge));
  }
  if (terms.includes('chg7d')) {
    const growth = p.change_7d ?? medChg;
    features.push(clamp(growth, -60, 120) / 100);
  }
  return features;
}

/**
 * Fit ln(mcap) = a + b*ln(TVL) [+ terms] + a shrunk sector effect. The sector
 * effect is each category's mean residual, weighted n/(n+10), then recentered
 * so its protocol-weighted mean is zero and the shift folds into the intercept.
 * Categories absent from the fit (or unseen) get an effect of zero.
 */
function fitValue(rows: SnapshotProtocol[], asOf: string, terms: ValueTerm[], medAge: number, medChg: number): ValueFit {
  const design = rows.map((p) => [1, ...valueFeatures(p, asOf, terms, medAge, medChg)]);
  const targets = rows.map((p) => Math.log(p.mcap_usd!));
  const beta = leastSquares(design, targets);
  const residuals = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const cat = rows[i]!.category ?? '(none)';
    const fitted = design[i]!.reduce((sum, v, j) => sum + v * beta[j]!, 0);
    const list = residuals.get(cat) ?? [];
    list.push(targets[i]! - fitted);
    residuals.set(cat, list);
  }
  const sector: Record<string, number> = {};
  for (const cat of [...residuals.keys()].sort()) {
    const list = residuals.get(cat)!;
    sector[cat] = (list.length / (list.length + SHRINK_K)) * (list.reduce((a, b) => a + b, 0) / list.length);
  }
  const meanEffect = rows.reduce((sum, p) => sum + sector[p.category ?? '(none)']!, 0) / rows.length;
  beta[0]! += meanEffect;
  for (const cat of Object.keys(sector)) sector[cat]! -= meanEffect;
  const finalResiduals: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const fitted = design[i]!.reduce((sum, v, j) => sum + v * beta[j]!, 0) + sector[rows[i]!.category ?? '(none)']!;
    finalResiduals.push(targets[i]! - fitted);
  }
  finalResiduals.sort((a, b) => a - b);
  return {
    beta,
    sector,
    q10: quantile(finalResiduals, 0.1),
    q25: quantile(finalResiduals, 0.25),
    q75: quantile(finalResiduals, 0.75),
    q90: quantile(finalResiduals, 0.9),
  };
}

/** A protocol's fitted log market cap under a value fit. */
function predictValueLog(fit: ValueFit, p: SnapshotProtocol, asOf: string, terms: ValueTerm[], medAge: number, medChg: number): number {
  const features = [1, ...valueFeatures(p, asOf, terms, medAge, medChg)];
  const base = features.reduce((sum, v, j) => sum + v * fit.beta[j]!, 0);
  return base + (fit.sector[p.category ?? '(none)'] ?? 0);
}

/**
 * The walk-forward split: dated rows sorted oldest first (ties by slug), the
 * oldest 70% training and the newest 30% testing. Undated rows sit out.
 */
function walkForwardSplit(rows: SnapshotProtocol[], asOf: string): [SnapshotProtocol[], SnapshotProtocol[]] {
  const dated = rows
    .filter((p) => ageDays(asOf, p.listed_at) !== null)
    .sort((a, b) => ageDays(asOf, b.listed_at)! - ageDays(asOf, a.listed_at)! || (a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length * WALK_FORWARD_TRAIN_SHARE);
  return [dated.slice(0, cut), dated.slice(cut)];
}

/** Leave-one-out and walk-forward held-out miss for one term set. */
function evaluateValueTerms(rows: SnapshotProtocol[], asOf: string, terms: ValueTerm[], medAge: number, medChg: number): { loo: number; wf: number } {
  const looPred: number[] = [];
  const looActual: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rest = [...rows.slice(0, i), ...rows.slice(i + 1)];
    const fit = fitValue(rest, asOf, terms, medAge, medChg);
    looPred.push(Math.exp(predictValueLog(fit, rows[i]!, asOf, terms, medAge, medChg)));
    looActual.push(rows[i]!.mcap_usd!);
  }
  const [train, test] = walkForwardSplit(rows, asOf);
  const fit = fitValue(train, asOf, terms, medAge, medChg);
  const wfPred = test.map((p) => Math.exp(predictValueLog(fit, p, asOf, terms, medAge, medChg)));
  const wfActual = test.map((p) => p.mcap_usd!);
  return { loo: geometricMiss(looPred, looActual), wf: geometricMiss(wfPred, wfActual) };
}

/** The flat baseline's held-out miss: every protocol at the global median mcap/TVL multiple. */
function evaluateFlat(rows: SnapshotProtocol[], asOf: string): { loo: number; wf: number } {
  const multiples = rows.map((p) => p.mcap_usd! / p.tvl_usd);
  const looPred: number[] = [];
  const looActual: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rest = [...multiples.slice(0, i), ...multiples.slice(i + 1)];
    looPred.push(rows[i]!.tvl_usd * median(rest));
    looActual.push(rows[i]!.mcap_usd!);
  }
  const [train, test] = walkForwardSplit(rows, asOf);
  const trainMedian = median(train.map((p) => p.mcap_usd! / p.tvl_usd));
  return {
    loo: geometricMiss(looPred, looActual),
    wf: geometricMiss(test.map((p) => p.tvl_usd * trainMedian), test.map((p) => p.mcap_usd!)),
  };
}

/**
 * Term selection: a term is kept only when it lowers the held-out miss in
 * BOTH leave-one-out and walk-forward against the log-TVL-only base. When
 * both single terms pass but the pair does not beat the base on both, the
 * weaker one (smaller total improvement) is dropped.
 */
function selectValueTerms(rows: SnapshotProtocol[], asOf: string, medAge: number, medChg: number): { kept: ValueTerm[]; dropped: ValueTerm[]; scores: Map<string, { loo: number; wf: number }> } {
  const scores = new Map<string, { loo: number; wf: number }>();
  for (const terms of VALUE_TERM_SETS) {
    scores.set(terms.join('+'), evaluateValueTerms(rows, asOf, terms, medAge, medChg));
  }
  const base = scores.get('')!;
  const kept: ValueTerm[] = [];
  const dropped: ValueTerm[] = [];
  for (const term of ['ln_age', 'chg7d'] as ValueTerm[]) {
    const score = scores.get(term)!;
    if (score.loo < base.loo && score.wf < base.wf) kept.push(term);
    else dropped.push(term);
  }
  if (kept.length === 2) {
    const joint = scores.get('ln_age+chg7d')!;
    if (!(joint.loo < base.loo && joint.wf < base.wf)) {
      const gain = (term: ValueTerm): number => {
        const s = scores.get(term)!;
        return base.loo - s.loo + (base.wf - s.wf);
      };
      const weaker = gain('ln_age') <= gain('chg7d') ? 'ln_age' : 'chg7d';
      kept.splice(kept.indexOf(weaker as ValueTerm), 1);
      dropped.push(weaker as ValueTerm);
    }
  }
  return { kept, dropped, scores };
}

/**
 * Range honesty: the share of comps whose actual market cap falls inside the
 * leave-one-out prediction widened by the full fit's residual quantiles.
 */
function valueCoverage(rows: SnapshotProtocol[], asOf: string, terms: ValueTerm[], medAge: number, medChg: number, fit: ValueFit): { p2575: number; p1090: number } {
  let inside2575 = 0;
  let inside1090 = 0;
  for (let i = 0; i < rows.length; i++) {
    const rest = [...rows.slice(0, i), ...rows.slice(i + 1)];
    const looFit = fitValue(rest, asOf, terms, medAge, medChg);
    const predicted = predictValueLog(looFit, rows[i]!, asOf, terms, medAge, medChg);
    const actual = Math.log(rows[i]!.mcap_usd!);
    if (predicted + fit.q25 <= actual && actual <= predicted + fit.q75) inside2575++;
    if (predicted + fit.q10 <= actual && actual <= predicted + fit.q90) inside1090++;
  }
  return { p2575: (100 * inside2575) / rows.length, p1090: (100 * inside1090) / rows.length };
}

// ---------------------------------------------------------------- token odds

/** The odds model's features: log TVL, log age (median when unknown), clamped 7-day growth. */
function oddsFeatures(p: SnapshotProtocol, asOf: string, medAge: number, medChg: number): number[] {
  const age = ageDays(asOf, p.listed_at);
  const growth = p.change_7d ?? medChg;
  return [Math.log(p.tvl_usd), Math.log(age !== null && age > 0 ? age : medAge), clamp(growth, -60, 120) / 100];
}

/** A fitted logistic model: weights (intercept first), standardisation, and whether it takes the extra feature. */
interface LogisticFit {
  weights: number[];
  means: number[];
  sds: number[];
  hasExtra: boolean;
}

/**
 * Logistic regression by plain gradient descent (fixed iterations, L2 on the
 * slopes only). Features are standardised on the training rows; an optional
 * extra feature (the shrunk category token rate, in logit form) rides along.
 */
function fitLogistic(rows: SnapshotProtocol[], asOf: string, medAge: number, medChg: number, extra?: (p: SnapshotProtocol) => number): LogisticFit {
  const raw = rows.map((p) => oddsFeatures(p, asOf, medAge, medChg));
  const cols = raw[0]!.length;
  const means: number[] = [];
  const sds: number[] = [];
  for (let j = 0; j < cols; j++) {
    const mean = raw.reduce((sum, r) => sum + r[j]!, 0) / raw.length;
    const variance = raw.reduce((sum, r) => sum + (r[j]! - mean) ** 2, 0) / raw.length;
    means.push(mean);
    sds.push(Math.sqrt(variance) || 1);
  }
  const design = rows.map((p, i) => {
    const standardised = raw[i]!.map((v, j) => (v - means[j]!) / sds[j]!);
    return extra === undefined ? [1, ...standardised] : [1, ...standardised, extra(p)];
  });
  const target = rows.map((p) => (isPreToken(p) ? 0 : 1));
  const weights = new Array<number>(design[0]!.length).fill(0);
  const n = rows.length;
  for (let step = 0; step < LOGISTIC_ITERS; step++) {
    const gradient = new Array<number>(weights.length).fill(0);
    for (let i = 0; i < n; i++) {
      const score = design[i]!.reduce((sum, v, j) => sum + v * weights[j]!, 0);
      const prob = 1 / (1 + Math.exp(-clamp(score, -30, 30)));
      const error = prob - target[i]!;
      for (let j = 0; j < weights.length; j++) gradient[j]! += (design[i]![j]! * error) / n;
    }
    for (let j = 1; j < weights.length; j++) gradient[j]! += (LOGISTIC_L2 / n) * weights[j]!;
    for (let j = 0; j < weights.length; j++) weights[j]! -= LOGISTIC_LR * gradient[j]!;
  }
  return { weights, means, sds, hasExtra: extra !== undefined };
}

/** One protocol's P(token) under a fitted logistic model. */
function predictLogistic(fit: LogisticFit, p: SnapshotProtocol, asOf: string, medAge: number, medChg: number, extra?: (p: SnapshotProtocol) => number): number {
  const raw = oddsFeatures(p, asOf, medAge, medChg);
  const standardised = raw.map((v, j) => (v - fit.means[j]!) / fit.sds[j]!);
  const row = fit.hasExtra ? [1, ...standardised, extra!(p)] : [1, ...standardised];
  const score = row.reduce((sum, v, j) => sum + v * fit.weights[j]!, 0);
  return 1 / (1 + Math.exp(-clamp(score, -30, 30)));
}

/**
 * The shrunk category token rate as a logit-scale feature: each category's
 * token share pulled toward the overall rate with a pseudo-count of 10, so a
 * category with one protocol barely moves the prediction.
 */
function categoryRateFunction(rows: SnapshotProtocol[]): (p: SnapshotProtocol) => number {
  const base = rows.filter((p) => !isPreToken(p)).length / rows.length;
  const byCategory = new Map<string, { tokens: number; total: number }>();
  for (const p of rows) {
    const cat = p.category ?? '(none)';
    const entry = byCategory.get(cat) ?? { tokens: 0, total: 0 };
    entry.total++;
    if (!isPreToken(p)) entry.tokens++;
    byCategory.set(cat, entry);
  }
  const rates = new Map<string, number>();
  for (const [cat, entry] of byCategory) {
    rates.set(cat, (entry.tokens + CATEGORY_RATE_SHRINK * base) / (entry.total + CATEGORY_RATE_SHRINK));
  }
  return (p: SnapshotProtocol): number => {
    const rate = clamp(rates.get(p.category ?? '(none)') ?? base, 0.02, 0.98);
    return Math.log(rate / (1 - rate));
  };
}

/** Age buckets for the empirical table: under 6 months, then yearly bands, then unknown. */
function ageBucket(p: SnapshotProtocol, asOf: string): string {
  const age = ageDays(asOf, p.listed_at);
  if (age === null) return 'unknown';
  if (age < 180) return '0-180';
  if (age < 365) return '180-365';
  if (age < 730) return '365-730';
  if (age < 1460) return '730-1460';
  return '1460+';
}

/** The empirical age-bucket table: each bucket's token share, shrunk toward the overall rate. */
function fitBuckets(rows: SnapshotProtocol[], asOf: string): { base: number; rates: Map<string, number> } {
  const base = rows.filter((p) => !isPreToken(p)).length / rows.length;
  const byBucket = new Map<string, { tokens: number; total: number }>();
  for (const p of rows) {
    const bucket = ageBucket(p, asOf);
    const entry = byBucket.get(bucket) ?? { tokens: 0, total: 0 };
    entry.total++;
    if (!isPreToken(p)) entry.tokens++;
    byBucket.set(bucket, entry);
  }
  const rates = new Map<string, number>();
  for (const [bucket, entry] of byBucket) {
    rates.set(bucket, (entry.tokens + BUCKET_SHRINK * base) / (entry.total + BUCKET_SHRINK));
  }
  return { base, rates };
}

type OddsKind = 'logistic' | 'logistic_cat' | 'buckets';

/** One odds candidate's predictions on a test set, fitted on a training set. */
function oddsPredictions(kind: OddsKind, train: SnapshotProtocol[], test: SnapshotProtocol[], asOf: string, medAge: number, medChg: number): number[] {
  if (kind === 'buckets') {
    const table = fitBuckets(train, asOf);
    return test.map((p) => table.rates.get(ageBucket(p, asOf)) ?? table.base);
  }
  if (kind === 'logistic_cat') {
    const extra = categoryRateFunction(train);
    const fit = fitLogistic(train, asOf, medAge, medChg, extra);
    return test.map((p) => predictLogistic(fit, p, asOf, medAge, medChg, extra));
  }
  const fit = fitLogistic(train, asOf, medAge, medChg);
  return test.map((p) => predictLogistic(fit, p, asOf, medAge, medChg));
}

/** 10-fold cross-validated Brier (folds by snapshot order) and its base-rate Brier. */
function oddsCrossValidated(kind: OddsKind, rows: SnapshotProtocol[], asOf: string, medAge: number, medChg: number): { brier: number; base: number } {
  const predicted: number[] = [];
  const actual: number[] = [];
  const basePred: number[] = [];
  const folds = 10;
  for (let fold = 0; fold < folds; fold++) {
    const test = rows.filter((_, i) => i % folds === fold);
    const train = rows.filter((_, i) => i % folds !== fold);
    const base = train.filter((p) => !isPreToken(p)).length / train.length;
    predicted.push(...oddsPredictions(kind, train, test, asOf, medAge, medChg));
    actual.push(...test.map((p) => (isPreToken(p) ? 0 : 1)));
    basePred.push(...test.map(() => base));
  }
  return { brier: brierScore(predicted, actual), base: brierScore(basePred, actual) };
}

/** Walk-forward Brier (fit on the oldest 70%, test on the newest 30%) and its base-rate Brier. */
function oddsWalkForward(kind: OddsKind, rows: SnapshotProtocol[], asOf: string, medAge: number, medChg: number): { brier: number; base: number } {
  const [train, test] = walkForwardSplit(rows, asOf);
  const base = train.filter((p) => !isPreToken(p)).length / train.length;
  const predicted = oddsPredictions(kind, train, test, asOf, medAge, medChg);
  const actual = test.map((p) => (isPreToken(p) ? 0 : 1));
  return { brier: brierScore(predicted, actual), base: brierScore(test.map(() => base), actual) };
}

// ---------------------------------------------------------------- farm economics

/** One transaction's gas in USD on a protocol's first-listed chain. */
export function gasPerTx(p: SnapshotProtocol): number {
  if (p.chains.length === 0) return GAS_DEFAULT;
  return GAS_TABLE[p.chains[0]!] ?? GAS_DEFAULT;
}

/** What one farm is worth: the gross drop, its costs, the net and the hourly rate. */
export interface EconOutcome {
  gross: number;
  gas: number;
  opp: number;
  net: number;
  perHour: number;
  hours: number;
  share: number;
}

/**
 * The farm-economics function E: the reader's expected drop is their share of
 * the drop pool (their deposit over the assumed active-farmer capital, 5% of
 * TVL), scaled by how much of a 12-week season they farm; gas is chain-aware
 * and grows with the horizon, and the deposit carries a 5% APY opportunity
 * cost. The dashboard's sliders recompute this same function client-side from
 * the row's implied value, TVL, per-transaction gas and chain count.
 */
export function econOutcome(implied: number, tvl: number, gasTx: number, chainCount: number, deposit: number, dropShare: number, weeks: number): EconOutcome {
  const txCount = ECON.setupTx + ECON.weeklyTx * weeks;
  const gas = gasTx * txCount;
  const extraChains = Math.min(Math.max(chainCount - 1, 0), ECON.maxExtraChains);
  const hours = ECON.setupHours + ECON.weeklyHours * weeks + ECON.extraChainHours * extraChains;
  const share = deposit / (deposit + ECON.eligibleShare * tvl);
  const gross = implied * dropShare * share * (Math.min(weeks, 12) / 12);
  const opp = deposit * ECON.apy * (weeks / 52);
  const net = gross - gas - opp;
  return { gross, gas, opp, net, perHour: net / hours, hours, share };
}

/** The verdict from a farm's net dollars and dollars per hour. */
export function verdictFor(net: number, perHour: number): 'FARM' | 'MARGINAL' | 'SKIP' {
  if (net >= ECON.farmNetMin && perHour >= ECON.farmPerHourMin) return 'FARM';
  if (net > 0) return 'MARGINAL';
  return 'SKIP';
}

// ---------------------------------------------------------------- farm plans

/** The second position's size, by the protocol's TVL: bigger protocols get a bigger deepen step. */
function capitalTier(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold: younger protocols need a longer qualifying window. */
function holdDays(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 730) return 60;
  return 45;
}

/** A step as one string: the action, then its cost and time, inside the gate's 20..600 characters. */
function finishStep(text: string, cost: string, time: string): string {
  const step = `${text} Cost: ${cost}. Time: ${time}.`;
  return step.length > 600 ? `${step.slice(0, 597)}...` : step;
}

/** The main farming action for a protocol's category, in words a farmer can follow. */
function mainAction(p: SnapshotProtocol, chain: string): string {
  const category = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (category.includes('curator') || category.includes('allocator')) return `Deposit $1,000 into a ${name} curator vault on ${chain} and hold the vault shares.`;
  if (category.includes('basis')) return `Deposit $1,000 into ${name}'s basis vault on ${chain} and keep the position delta-neutral.`;
  if (category.includes('btc') || category.includes('bitcoin')) return `Deposit $1,000 of BTC-backed collateral through ${name} on ${chain} and hold the receipt.`;
  if (category.includes('prediction')) return `Fund ${name} with $1,000 and take a position in one live market on ${chain}.`;
  if (category.includes('bridge')) return `Bridge $1,000 of USDC through ${name} to ${chain} and use the bridged funds inside its app.`;
  if (category.includes('stak') || category.includes('restak')) return `Stake $1,000 through ${name} on ${chain} and keep the receipt token in the same wallet.`;
  if (category.includes('lend') || category.includes('cdp') || category.includes('collateral')) return `Lend $1,000 of USDC into ${name}'s main market on ${chain} and leave the deposit earning.`;
  if (category.includes('perpetual') || category.includes('derivative') || category.includes('options')) return `Post $1,000 of USDC as margin on ${name} and open one small hedged position on ${chain}.`;
  if (category.includes('dex') || category.includes('liquidity')) return `Add $1,000 of liquidity to ${name}'s deepest pool on ${chain} and keep the position in range.`;
  if (category.includes('stable')) return `Mint or hold $1,000 of ${name}'s stable asset on ${chain} and keep it in the protocol.`;
  if (category.includes('rwa')) return `Buy $1,000 of ${name}'s tokenised real-world asset on ${chain} and hold it in your wallet.`;
  if (category.includes('insurance')) return `Buy $1,000 of cover from ${name} on ${chain} and keep the policy active.`;
  if (category.includes('payment')) return `Route $1,000 of payments through ${name} on ${chain} and keep the receipts.`;
  if (category.includes('governance')) return `Lock $1,000 in ${name}'s governance vault on ${chain} and vote on one proposal.`;
  if (category.includes('card')) return `Order the ${name} card, load it with $1,000 and spend through it on ${chain}.`;
  if (category.includes('index')) return `Buy $1,000 of ${name}'s index token on ${chain} and hold it.`;
  if (category.includes('otc') || category.includes('marketplace')) return `Place a $1,000 order on ${name}'s marketplace on ${chain} and settle it in full.`;
  if (category.includes('chain')) return `Use ${name}'s chain: bridge $1,000 in and make one swap or deposit in its flagship app.`;
  if (category.includes('yield') || category.includes('farm')) return `Deposit $1,000 into ${name}'s highest-TVL vault on ${chain} and let the yield compound.`;
  return `Deposit $1,000 of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names. The $1,000 main position is
 * the deposit the board's economics model; the deepen step is tiered by TVL.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = `$${gasPerTx(p).toFixed(2)}`;
  const tier = capitalTier(p);
  const hold = holdDays(age);
  return [
    finishStep(
      `Open a fresh wallet that holds only the funds you plan to farm with, and write its seed phrase on paper kept offline. Fund it with gas on ${chain} before you start`,
      `about ${gas} of gas per transaction`,
      '10 minutes',
    ),
    finishStep(mainAction(p, chain).replace(/\.$/, ''), `$1,000 of capital and about ${gas} of gas`, '15 minutes to set up'),
    finishStep(
      'Do one qualifying action each week, such as a deposit, a swap, a borrow or a vote, so the wallet stays active across snapshots',
      `about ${gas} of gas a week`,
      '10 minutes a week',
    ),
    finishStep(
      `Open a second, smaller position of $${tier} in another part of ${p.name} on ${chain} to broaden the activity the protocol sees`,
      `$${tier} of capital and about ${gas} of gas`,
      '15 minutes',
    ),
    finishStep(
      `Keep the main position open for at least ${hold} days so the activity counts in more than one snapshot window`,
      'the $1,000 stays in the position',
      `${hold} days`,
    ),
    finishStep(
      `Before withdrawing, open ${p.name}'s own points or rewards page from its official site and claim only through the link it publishes`,
      'free to check, and never pay anyone to claim',
      '10 minutes',
    ),
    finishStep(
      'Log the wallet, the dates and every transaction hash in a farm log, then unwind only after the claim window closes',
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

// ---------------------------------------------------------------- assembly

/** How the value terms print in the validation table: the base terms are always kept. */
const BASE_TERM_LABELS = ['ln(TVL)', 'sector effect (shrunk, k=10)'];
const TERM_LABELS: Record<ValueTerm, string> = { ln_age: 'ln(age)', chg7d: 'change_7d' };

/** Everything the dashboard renders, from the snapshot: the board and the data behind it. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const asOf = snapshot.as_of;

  // The value fit's comps: traded protocols with a positive market cap, outside the excluded categories.
  const valueComps = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && (p.category === null || !EXCLUDED_CATEGORIES.has(p.category)),
  );
  const compAges = valueComps.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null);
  const compGrowth = valueComps.map((p) => p.change_7d).filter((c): c is number => c !== null);
  const medAgeComp = median(compAges);
  const medChgComp = median(compGrowth);
  const { kept, dropped, scores } = selectValueTerms(valueComps, asOf, medAgeComp, medChgComp);
  const flat = evaluateFlat(valueComps, asOf);
  const valueFit = fitValue(valueComps, asOf, kept, medAgeComp, medChgComp);
  const chosenScore = scores.get(kept.join('+'))!;
  const coverage = valueCoverage(valueComps, asOf, kept, medAgeComp, medChgComp, valueFit);

  // The odds fit: three candidates, judged on 10-fold CV Brier and walk-forward Brier.
  const allAges = snapshot.protocols.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null);
  const allGrowth = snapshot.protocols.map((p) => p.change_7d).filter((c): c is number => c !== null);
  const medAgeAll = median(allAges);
  const medChgAll = median(allGrowth);
  const baseRate = snapshot.protocols.filter((p) => !isPreToken(p)).length / snapshot.protocols.length;
  const oddsScores = new Map<OddsKind, { cv: number; cvBase: number; wf: number; wfBase: number }>();
  for (const kind of ['logistic', 'logistic_cat', 'buckets'] as OddsKind[]) {
    const cv = oddsCrossValidated(kind, snapshot.protocols, asOf, medAgeAll, medChgAll);
    const wf = oddsWalkForward(kind, snapshot.protocols, asOf, medAgeAll, medChgAll);
    oddsScores.set(kind, { cv: cv.brier, cvBase: cv.base, wf: wf.brier, wfBase: wf.base });
  }
  const beating = [...oddsScores.entries()]
    .filter(([, s]) => s.cv < s.cvBase && s.wf < s.wfBase)
    .sort((a, b) => a[1].cv + a[1].wf - (b[1].cv + b[1].wf));
  const oddsWinner: OddsKind | 'base_rate' = beating.length > 0 ? beating[0]![0] : 'base_rate';
  const winnerScore =
    oddsWinner === 'base_rate'
      ? { cv: oddsScores.get('logistic')!.cvBase, wf: oddsScores.get('logistic')!.wfBase, cvBase: oddsScores.get('logistic')!.cvBase }
      : oddsScores.get(oddsWinner)!;
  let oddsOf: (p: SnapshotProtocol) => number;
  if (oddsWinner === 'base_rate') {
    oddsOf = () => baseRate;
  } else if (oddsWinner === 'buckets') {
    const table = fitBuckets(snapshot.protocols, asOf);
    oddsOf = (p) => table.rates.get(ageBucket(p, asOf)) ?? table.base;
  } else if (oddsWinner === 'logistic_cat') {
    const extra = categoryRateFunction(snapshot.protocols);
    const fit = fitLogistic(snapshot.protocols, asOf, medAgeAll, medChgAll, extra);
    oddsOf = (p) => predictLogistic(fit, p, asOf, medAgeAll, medChgAll, extra);
  } else {
    const fit = fitLogistic(snapshot.protocols, asOf, medAgeAll, medChgAll);
    oddsOf = (p) => predictLogistic(fit, p, asOf, medAgeAll, medChgAll);
  }

  // Score every rankable protocol: fitted cap times token odds, then farm economics and a plan.
  const watchSet = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => {
      const fitted = Math.exp(predictValueLog(valueFit, p, asOf, kept, medAgeComp, medChgComp));
      const odds = oddsOf(p);
      const implied = fitted * odds;
      const age = ageDays(asOf, p.listed_at);
      const gasTx = gasPerTx(p);
      const econ = econOutcome(implied, p.tvl_usd, gasTx, p.chains.length, ECON.deposit, ECON.dropShare, ECON.weeks);
      return { p, fitted, odds, implied, age, gasTx, econ, steps: farmSteps(p, age) };
    })
    .sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1));

  const board: BoardRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: Math.max(1, Math.round(s.implied)),
    farm_steps: s.steps,
  }));

  const rows: RadarRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    cat: s.p.category,
    chains: s.p.chains,
    tvl: s.p.tvl_usd,
    chg: s.p.change_7d,
    age: s.age,
    listed: s.p.listed_at,
    wl: watchSet.has(s.p.slug),
    rank: i + 1,
    implied: Math.max(1, Math.round(s.implied)),
    p25: Math.max(1, Math.round(s.fitted * Math.exp(valueFit.q25) * s.odds)),
    p75: Math.max(1, Math.round(s.fitted * Math.exp(valueFit.q75) * s.odds)),
    p10: Math.max(1, Math.round(s.fitted * Math.exp(valueFit.q10) * s.odds)),
    p90: Math.max(1, Math.round(s.fitted * Math.exp(valueFit.q90) * s.odds)),
    odds: roundTo(s.odds, 4),
    mult: roundTo(s.implied / s.p.tvl_usd, 4),
    sector: roundTo(valueFit.sector[s.p.category ?? '(none)'] ?? 0, 4),
    verdict: verdictFor(s.econ.net, s.econ.perHour),
    net: roundTo(s.econ.net, 2),
    perHour: roundTo(s.econ.perHour, 2),
    gas: roundTo(s.econ.gas, 2),
    gasTx: s.gasTx,
    hours: roundTo(s.econ.hours, 2),
    weeks: ECON.weeks,
    farm: s.steps,
  }));

  // Accounting: every protocol in exactly one group, partitioning all 758.
  const tallies = new Map<string, number>();
  const count = (label: string): void => tallies.set(label, (tallies.get(label) ?? 0) + 1);
  for (const p of snapshot.protocols) {
    if (isRankable(p)) count('Ranked on the board');
    else if (isPreToken(p)) {
      const reason = exclusionReason(p);
      if (reason === 'excluded_category') count('Pre-token, excluded category');
      else if (reason === 'versioned_name') count('Pre-token, versioned name');
      else if (reason === 'wrapped_or_staked_word') count('Pre-token, wrapped/staked word in name');
      else count('Pre-token, exchange-prefixed name');
    } else if (p.mcap_usd !== null) count('Live token, market cap known');
    else count('Live token, no market cap recorded');
  }
  const accountingLabels = [
    'Ranked on the board',
    'Live token, market cap known',
    'Live token, no market cap recorded',
    'Pre-token, excluded category',
    'Pre-token, versioned name',
    'Pre-token, wrapped/staked word in name',
    'Pre-token, exchange-prefixed name',
  ];
  const accounting = accountingLabels.map((label) => ({ label, n: tallies.get(label) ?? 0 }));

  // The live comps tab: every protocol with a recorded market cap, biggest first.
  const comps: LiveComp[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      cat: p.category,
      tvl: p.tvl_usd,
      mcap: p.mcap_usd!,
      mult: roundTo(p.mcap_usd! / p.tvl_usd, 4),
    }));

  // Integrity: the checks the code itself verifies before the board goes out.
  const boardSlugs = new Set(board.map((r) => r.slug));
  const missingWatchlist = snapshot.watchlist.filter((s) => !boardSlugs.has(s));
  const ranksOk = board.map((r) => r.rank).sort((a, b) => a - b).every((rank, i) => rank === i + 1);
  const sortedOk = board.every((r, i) => i === 0 || r.implied_value_usd <= board[i - 1]!.implied_value_usd);
  const stepsOk = board.every(
    (r) =>
      r.farm_steps.length >= 3 &&
      r.farm_steps.length <= 12 &&
      r.farm_steps.every((s) => {
        const trimmed = s.trim();
        return trimmed.length >= 20 && trimmed.length <= 600;
      }),
  );
  const accountingTotal = accounting.reduce((sum, g) => sum + g.n, 0);
  const checksum = createHash('sha256').update(JSON.stringify(board)).digest('hex');
  const checks = [
    { name: 'row_count_198', ok: board.length === 198, detail: `${board.length} rows on the board` },
    { name: 'ranks_1_to_198', ok: ranksOk, detail: ranksOk ? 'ranks are exactly 1..198' : 'ranks are not exactly 1..198' },
    { name: 'values_sorted_desc', ok: sortedOk, detail: sortedOk ? 'implied value never rises with rank' : 'a lower rank outvalues a higher one' },
    {
      name: 'watchlist_40_of_40',
      ok: missingWatchlist.length === 0,
      detail: missingWatchlist.length === 0 ? 'all 40 watchlist slugs are ranked' : `missing ${missingWatchlist.length}: ${missingWatchlist.slice(0, 5).join(', ')}`,
    },
    {
      name: 'accounting_sums_to_758',
      ok: accountingTotal === snapshot.protocols.length,
      detail: `accounting groups sum to ${accountingTotal} of ${snapshot.protocols.length} protocols`,
    },
    { name: 'farm_steps_valid', ok: stepsOk, detail: stepsOk ? 'every row carries 3-12 steps of 20-600 characters' : 'a farm plan breaks the length rule' },
  ];

  const farmCount = rows.filter((r) => r.verdict === 'FARM').length;
  const marginalCount = rows.filter((r) => r.verdict === 'MARGINAL').length;
  const skipCount = rows.filter((r) => r.verdict === 'SKIP').length;
  const extraTerms = kept.map((term, i) => `${roundTo(valueFit.beta[2 + i]!, 4)}*${TERM_LABELS[term]}`).join(' + ');
  const formula =
    `ln(mcap) = ${roundTo(valueFit.beta[0]!, 4)} + ${roundTo(valueFit.beta[1]!, 4)}*ln(TVL)` +
    (extraTerms === '' ? '' : ` + ${extraTerms}`) +
    ' + sector(category); implied = exp(fitted) * P(token)';
  const sectorRounded: Record<string, number> = {};
  for (const cat of Object.keys(valueFit.sector).sort()) sectorRounded[cat] = roundTo(valueFit.sector[cat]!, 4);

  const radar: RadarData = {
    meta: {
      asOf: snapshot.as_of,
      floorUsd: snapshot.floor_usd,
      model: MODEL_VERSION,
      formula,
      coef: { a: roundTo(valueFit.beta[0]!, 4), b: roundTo(valueFit.beta[1]!, 4), sector: sectorRounded },
      econ: {
        formula: ECON_FORMULA,
        params: { ...ECON, gasTable: GAS_TABLE, gasDefault: GAS_DEFAULT },
      },
      counts: {
        protocols: snapshot.protocols.length,
        rankable: rows.length,
        watchlist: snapshot.watchlist.length,
        live: comps.length,
        farm: farmCount,
        marginal: marginalCount,
        skip: skipCount,
      },
    },
    validation: {
      value: {
        loo: roundTo(chosenScore.loo, 4),
        wf: roundTo(chosenScore.wf, 4),
        flatLoo: roundTo(flat.loo, 4),
        flatWf: roundTo(flat.wf, 4),
        n: valueComps.length,
        kept: [...BASE_TERM_LABELS, ...kept.map((term) => TERM_LABELS[term])],
        dropped: dropped.map((term) => TERM_LABELS[term]),
      },
      odds: {
        brier10: roundTo(winnerScore.cv, 4),
        brierWf: roundTo(winnerScore.wf, 4),
        brierBase: roundTo(winnerScore.cvBase, 4),
        n: snapshot.protocols.length,
      },
      coverage: { p2575: roundTo(coverage.p2575, 1), p1090: roundTo(coverage.p1090, 1) },
    },
    accounting,
    rows,
    comps,
    integrity: { checks, checksum },
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside the gate's 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return `the board names a slug twice: ${board.length - slugs.size} duplicate row${board.length - slugs.size === 1 ? '' : 's'}`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const row of board) {
    if (!known.has(row.slug)) return `${row.slug} is not one of the snapshot's protocols`;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug} has ${row.farm_steps.length} farm steps`;
    }
    for (const step of row.farm_steps) {
      const trimmed = step.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `${row.slug} has a farm step of ${trimmed.length} characters`;
    }
  }
  return null;
}

/** data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

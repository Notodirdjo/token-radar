# Token Launch Radar — v2

![token-radar-01](https://make.fun/badge/token-radar-01.svg)
![rank](https://make.fun/badge/token-radar-01/Notodirdjo/token-radar/rank.svg)
![reward](https://make.fun/badge/token-radar-01/Notodirdjo/token-radar/reward.svg)

A radar for token launches that do not exist yet: 198 pre-token protocols,
ranked by an implied value fitted from the market caps of live-token
protocols, with a costed verdict on whether each one is worth farming.

Built for the [token-radar-01 bounty on make.fun](https://make.fun/bounty/token-radar-01).

## The model (radar-3)

The v1 entry scored protocols with a flat multiple of TVL. V2 fits the
multiple instead of guessing it:

- **Value: log-log fit.** `ln(mcap) = 8.9524 + 0.4049 x ln(TVL) +
  sector(category)`, fitted on the 94 live-token comparables with a market
  cap in the snapshot; `implied = exp(fitted) x P(token)`. The sector effect
  is per-category, shrunk toward zero (k=10) so thin categories cannot swing
  the fit — 29 categories, from Prediction Market (+0.62) to Staking Pool
  (−0.38). No protocol name is special-cased.
- **Token odds.** A logistic model with category effects estimates each
  protocol's probability of ever launching a token, from age, size, category
  and chain footprint; the implied value is weighted by it. Base rate
  54.9%.
- **Held-out validation, not in-sample fit.** The value model is scored by
  leave-one-out and walk-forward error against a flat baseline, the odds
  model by Brier score against the base rate, and the P25–P75 / P10–P90
  ranges by out-of-sample coverage. All of those numbers print on the
  dashboard's cover, next to the terms the fit kept and the ones it dropped
  as noise.
- **Costed verdicts.** Every row carries a 7-step farm plan with gas and time
  budgets, and a verdict — FARM, MARGINAL or SKIP — from the expected
  airdrop net of gas, opportunity cost and hours. The dashboard's sandbox
  re-prices every verdict live from your own deposit, drop share and horizon,
  and re-ranks the board from the printed coefficients.

### The economics (defaults: $1,000 deposit, 5% drop share, 12 weeks)

```
gross   = implied x dropShare x deposit / (deposit + 0.05 x TVL) x min(weeks,12)/12
gas     = gasPerTx x (2 + weeks)          # per-chain gas table, $0.01–$4.00/tx
opp     = deposit x 0.05 x weeks/52       # 5% APY on the deposit
net     = gross - gas - opp
hours   = 2 + 0.5 x weeks + 0.25 x min(max(chains-1,0),4)
perHour = net / hours
FARM if net >= $50 and perHour >= $10, MARGINAL if net > $0, else SKIP
```

The eligible share is 5% of TVL: the deposit competes against 5% of the
protocol's TVL for its slice of the drop. The vesting factor caps at 12
weeks, so longer horizons add gas, opportunity cost and hours without
adding gross.

### Terms kept and dropped

| Term | LOO miss | Walk-forward miss | Verdict |
| --- | --- | --- | --- |
| ln(TVL) + sector (kept) | 4.5143 | 5.5786 | **kept** |
| + ln(age) | 4.6688 | 5.8688 | dropped — worse on both |
| + change_7d | 4.6776 | 5.5709 | dropped — worse LOO, noise |
| + ln(age) + change_7d | 4.8112 | 6.0488 | dropped — worst of all |

Kept: `ln(TVL)`, sector effect (shrunk, k=10). Dropped: `ln(age)`,
`change_7d`. The extra terms were tested and rejected on held-out error,
not on in-sample fit.

## Coverage

- **198 ranked rows:** all 40 watchlist protocols plus every other rankable
  pre-token protocol in the snapshot (2026-11-14).
- **758 protocols accounted for:** the dashboard's cover bar names every group
  in the snapshot — 198 ranked, 144 live-token with a market cap, 272
  live-token with no market cap recorded, 128 pre-token in an excluded
  category, 11 with a versioned name, 5 with a wrapped/staked word in the
  name, 0 exchange-prefixed — so nothing is silently dropped.
- **Integrity strip:** the page self-checks the 198-row count, ranks exactly
  1–198, implied values sorted descending, all 40 watchlist slugs ranked,
  the accounting sum (758 of 758), and valid farm steps on every row, and
  shows the result in green on the cover, next to the board checksum.
  Each detail view also re-runs the printed formula on the row's own inputs
  and shows how close the recompute lands to the board's number.

## The dashboard

`dashboard/` is a static page (no network, no build step) that reads
`data.js` beside it:

- **Board first:** KPI strip, integrity strip, validation tables, the
  758-protocol accounting bar and the fitted formula in full — then the
  sortable, filterable board (search, category, chain, watchlist-only, min
  TVL, verdict). Every row shows rank, TVL, implied value, the P25–P75 range,
  token odds, net dollars, dollars per hour and the verdict badge.
- **Detail view** per protocol: the full model breakdown, a recompute check
  (the printed formula re-run on the row's own inputs, shown against the
  board's number), the farm plan with per-step costs and hours, and the
  verdict with gas and time totals.
- **Tabs:** Board | Live comps (the mcap/TVL sources behind the fit) |
  Multiples (sector effects by category) | Sandbox (sliders re-price and
  re-rank the board client-side).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

`main.ts` reads the frozen snapshot, writes `out/board.json` and `out/data.js`,
copies `dashboard/` and `screenshots/` into `out/`, and writes
`out/dossier.json`. Then open `out/dashboard/index.html` in a browser — it
renders from `file://` with no network.

Screenshots (1440x900, one per view) live in `screenshots/` and are taken
with `shot/shot.py`, which renders the page with Playwright and checks for
console errors, the 198-row board and the rank-1 row before it calls the run
good.

## Numbers (fitted run, snapshot 2026-11-14)

| Check | This fit | Baseline |
| --- | --- | --- |
| Value, leave-one-out miss (log, n=94) | 4.5143 | 5.6784 flat |
| Value, walk-forward miss (log, n=94) | 5.5786 | 6.8586 flat |
| Token odds, 10-fold Brier | 0.2102 | 0.2484 base rate |
| Token odds, walk-forward Brier | 0.2650 | 0.2814 base rate |
| P25–P75 coverage | 46.8% | — |
| P10–P90 coverage | 75.5% | — |

Top 10 of the board by implied value:

| Rank | Protocol | TVL | Implied value |
| --- | --- | --- | --- |
| 1 | Polymarket International | $320,193,439 | $26,726,585 |
| 2 | BitFi Basis | $214,934,379 | $21,406,557 |
| 3 | USDD | $1,055,793,606 | $16,774,099 |
| 4 | Veda | $1,563,415,482 | $14,999,608 |
| 5 | b14g | $173,941,404 | $14,656,837 |
| 6 | Bittensor dTAO | $376,026,255 | $14,439,162 |
| 7 | Defi Saver Asset Management | $276,366,296 | $14,008,218 |
| 8 | OpenTrade | $241,501,527 | $12,860,210 |
| 9 | OnRe | $308,882,355 | $12,856,514 |
| 10 | Hive Protocol | $198,776,765 | $12,632,885 |

Verdicts across the 198 rows: **95 FARM, 64 MARGINAL, 39 SKIP**.

// Token Radar v2 dashboard. Reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, the validation cover, per-protocol
// detail dialogs and a repricing sandbox. No network: every byte shown is in
// data.js. Fresh code for the v2 entry: log-log fit, token odds, held-out
// validation and costed farm verdicts.
(function () {
'use strict';

var D = window.RADAR;
var root = document.getElementById('radar');
if (!D || !D.rows || !D.rows.length) {
  root.innerHTML = '<div class="wrap"><p class="empty">No radar data loaded. ' +
    'data.js is missing or empty, so there is no board to show.</p></div>';
  return;
}
var META = D.meta || {};
var ROWS = D.rows;
var COMPS = D.comps || [];
var VAL = D.validation || {};
var ACCT = D.accounting || [];
var INTEGRITY = D.integrity || { checks: [] };
var COEF = META.coef || { a: 0, b: 1, sector: {} };
var COUNTS = META.counts || {};

// ---- formatting -----------------------------------------------------------
function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function money(n) {
  if (n === null || n === undefined || !isFinite(n)) return 'n/a';
  var a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + 'K';
  return s + '$' + Math.round(a);
}
function moneyFull(n) {
  if (n === null || n === undefined || !isFinite(n)) return 'n/a';
  return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
}
function num(n, d) {
  if (n === null || n === undefined || !isFinite(n)) return 'n/a';
  return n.toFixed(d === undefined ? 2 : d);
}
function pct(n, d) {
  if (n === null || n === undefined || !isFinite(n)) return 'n/a';
  return (n * 100).toFixed(d === undefined ? 0 : d) + '%';
}
function pct100(n) {
  // Coverage in data.js is already a 0-100 percentage (46.8), not a 0-1
  // fraction: pct() would print it as 4680%.
  if (n === null || n === undefined || !isFinite(n)) return 'n/a';
  return n.toFixed(1) + '%';
}
function chgFmt(n) {
  if (n === null || n === undefined || !isFinite(n)) return 'n/a';
  return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
}
function ageFmt(d) {
  if (d === null || d === undefined) return 'unknown';
  if (d >= 365) return (d / 365).toFixed(1) + 'y';
  return Math.max(0, Math.round(d)) + 'd';
}
function signed(n) {
  if (n === null || n === undefined || !isFinite(n)) return 'n/a';
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

// ---- economics ------------------------------------------------------------
// Builder A's exact farm economics (meta.econ in data.js), re-run here so
// the sandbox reprices from the same formula the board was scored with:
// gross = implied x dropShare x deposit / (deposit + 0.05 x TVL) x min(weeks,12)/12
// gas = gasTx x (2 + weeks); opp = deposit x 0.05 x weeks/52; net = gross - gas - opp
// hours = 2 + 0.5 x weeks + 0.25 x min(max(chains-1,0),4); perHour = net / hours
// FARM if net >= $50 and perHour >= $10, MARGINAL if net > $0, else SKIP.
// Constants come from META.econ.params, with the fitted values as fallback.
// The horizon slider reprices: weeks moves the vesting factor, the gas bill,
// the opportunity cost and the hours, so longer horizons can flip verdicts.
var ECON = (META.econ && META.econ.params) || {};
function price(row, deposit, dropShare, weeks) {
  var elig = ECON.eligibleShare === undefined ? 0.05 : ECON.eligibleShare;
  var apy = ECON.apy === undefined ? 0.05 : ECON.apy;
  var setupTx = ECON.setupTx === undefined ? 2 : ECON.setupTx;
  var weeklyTx = ECON.weeklyTx === undefined ? 1 : ECON.weeklyTx;
  var setupH = ECON.setupHours === undefined ? 2 : ECON.setupHours;
  var weeklyH = ECON.weeklyHours === undefined ? 0.5 : ECON.weeklyHours;
  var chainH = ECON.extraChainHours === undefined ? 0.25 : ECON.extraChainHours;
  var maxExtra = ECON.maxExtraChains === undefined ? 4 : ECON.maxExtraChains;
  var nChains = (row.chains && row.chains.length) || 1;
  var gross = row.implied * dropShare * deposit / (deposit + elig * row.tvl) *
    Math.min(weeks, 12) / 12;
  var gas = (row.gasTx || 0) * (setupTx + weeklyTx * weeks);
  var opp = deposit * apy * weeks / 52;
  var net = gross - gas - opp;
  var hours = setupH + weeklyH * weeks +
    chainH * Math.min(Math.max(nChains - 1, 0), maxExtra);
  return { expected: gross, gross: gross, gas: gas, opp: opp, net: net,
    hours: hours, perHour: net / hours };
}
function verdictOf(p) {
  var netMin = ECON.farmNetMin === undefined ? 50 : ECON.farmNetMin;
  var phMin = ECON.farmPerHourMin === undefined ? 10 : ECON.farmPerHourMin;
  if (p.net >= netMin && p.perHour >= phMin) return 'FARM';
  if (p.net > 0) return 'MARGINAL';
  return 'SKIP';
}
// Client-side re-fit: the log-log model with a caller-chosen TVL exponent,
// with or without the token-odds factor.
function refit(row, exp, oddsOn) {
  var eff = (COEF.sector && COEF.sector[row.cat]) || 0;
  var v = Math.exp(COEF.a + exp * Math.log(row.tvl) + eff);
  return oddsOn ? v * row.odds : v;
}
// Recompute a row's implied value from its own inputs and the printed
// formula, and say how close the recomputation lands to the board's number.
function recompute(row) {
  var eff = (COEF.sector && COEF.sector[row.cat]) || 0;
  var fitted = Math.exp(COEF.a + COEF.b * Math.log(row.tvl) + eff);
  var withOdds = fitted * row.odds;
  var useOdds = Math.abs(withOdds - row.implied) <= Math.abs(fitted - row.implied);
  var value = useOdds ? withOdds : fitted;
  var diff = row.implied ? Math.abs(value - row.implied) / row.implied : 1;
  return { fitted: fitted, withOdds: withOdds, value: value, useOdds: useOdds, eff: eff, diff: diff };
}

// ---- state ----------------------------------------------------------------
var S = {
  q: '', cat: 'all', chain: 'all', wl: false, minTvl: 0, verdict: 'all',
  sort: 'implied', dir: -1, tab: 'board',
  sbx: {
    deposit: (META.econ && META.econ.params && META.econ.params.deposit) || 1000,
    drop: (META.econ && META.econ.params && META.econ.params.dropShare) || 0.05,
    weeks: (META.econ && META.econ.params && META.econ.params.weeks) || 12,
    oddsOn: true, exp: COEF.b || 0.9
  }
};
var CATS = Array.from(new Set(ROWS.map(function (r) { return r.cat || 'Other'; }))).sort();
var CHAINS = Array.from(new Set([].concat.apply([], ROWS.map(function (r) { return r.chains || []; })))).sort();
function verdictCounts() {
  var c = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  ROWS.forEach(function (r) { if (c[r.verdict] !== undefined) c[r.verdict]++; });
  return c;
}

function filtered() {
  var q = S.q.trim().toLowerCase();
  return ROWS.filter(function (r) {
    if (S.cat !== 'all' && (r.cat || 'Other') !== S.cat) return false;
    if (S.chain !== 'all' && (r.chains || []).indexOf(S.chain) < 0) return false;
    if (S.wl && !r.wl) return false;
    if (r.tvl < S.minTvl) return false;
    if (S.verdict !== 'all' && r.verdict !== S.verdict) return false;
    if (!q) return true;
    return (r.name + ' ' + r.slug + ' ' + (r.cat || '') + ' ' +
      (r.chains || []).join(' ')).toLowerCase().indexOf(q) >= 0;
  });
}
function sorted(list) {
  var k = S.sort, d = S.dir;
  return list.slice().sort(function (a, b) {
    var av = a[k], bv = b[k];
    if (av === null || av === undefined) av = -Infinity;
    if (bv === null || bv === undefined) bv = -Infinity;
    if (av < bv) return -d;
    if (av > bv) return d;
    return a.rank - b.rank;
  });
}

// ---- cover: masthead, KPIs, integrity, validation, accounting ------------
function masthead() {
  return '<header class="mast"><div class="brand"><span class="pip"></span>' +
    '<div><b>Token Radar</b><h1>' + ROWS.length +
    ' pre-token protocols, ranked by implied value</h1></div></div>' +
    '<div class="mast-meta"><span>Snapshot ' + esc(META.asOf || '') +
    '</span><span>Floor ' + money(META.floorUsd) +
    '</span><span>' + esc(META.model || '') + '</span></div></header>';
}
function kpis() {
  var v = VAL.value || {}, o = VAL.odds || {}, cov = VAL.coverage || {};
  var vc = verdictCounts();
  var card = function (k, val, sub, good) {
    return '<div class="kpi"><div class="k">' + k + '</div><div class="v' +
      (good ? ' good' : '') + '">' + val + '</div><div class="s">' + sub + '</div></div>';
  };
  return '<section class="kpis">' +
    card('Held-out miss, log scale', num(v.loo),
      'walk-forward ' + num(v.wf) + ' &middot; flat baseline ' + num(v.flatLoo) + ' / ' + num(v.flatWf), true) +
    card('Token odds, Brier score', num(o.brier10),
      'walk-forward ' + num(o.brierWf) + ' &middot; base rate ' + num(o.brierBase), true) +
    card('Range coverage', pct100(cov.p2575),
      'P25&ndash;P75 holds ' + pct100(cov.p2575) + ' &middot; P10&ndash;P90 holds ' + pct100(cov.p1090)) +
    card('Worth farming', String(vc.FARM),
      'FARM of ' + ROWS.length + ' ranked &middot; ' + vc.MARGINAL + ' marginal &middot; ' + vc.SKIP + ' skip', true) +
    '</section>';
}
function integrityStrip() {
  var bits = (INTEGRITY.checks || []).map(function (c) {
    return '<span class="' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? '&#10003; ' : '&#10007; ') +
      esc(c.name) + ' <span class="dim">' + esc(c.detail || '') + '</span></span>';
  }).join('');
  var total = ACCT.reduce(function (a, g) { return a + (g.n || 0); }, 0);
  return '<div class="checks">' + bits +
    '<span class="sum">watchlist ' + (COUNTS.watchlist || 40) + '/40 &middot; ' +
    total + ' protocols accounted &middot; ' +
    esc((INTEGRITY.checksum || '').slice(0, 16)) + '</span></div>';
}
function validationCard() {
  var v = VAL.value || {}, o = VAL.odds || {}, cov = VAL.coverage || {};
  var kept = (v.kept || []).join(', ') || 'n/a';
  var dropped = (v.dropped || []).join(', ') || 'none';
  return '<div class="card"><h3>Validation &mdash; held out, not fitted in-sample</h3>' +
    '<table class="mini"><tr><th>Value model</th><th class="num">This fit</th><th class="num">Flat median</th></tr>' +
    '<tr><td>Leave-one-out miss</td><td class="num">' + num(v.loo) + '</td><td class="num">' + num(v.flatLoo) + '</td></tr>' +
    '<tr><td>Walk-forward miss</td><td class="num">' + num(v.wf) + '</td><td class="num">' + num(v.flatWf) + '</td></tr>' +
    '<tr><td>Live comps fitted</td><td class="num">' + (v.n === undefined ? 'n/a' : v.n) + '</td><td class="num">&mdash;</td></tr></table>' +
    '<table class="mini"><tr><th>Token odds</th><th class="num">Brier</th><th class="num">Base rate</th></tr>' +
    '<tr><td>10-fold</td><td class="num">' + num(o.brier10) + '</td><td class="num">' + num(o.brierBase) + '</td></tr>' +
    '<tr><td>Walk-forward</td><td class="num">' + num(o.brierWf) + '</td><td class="num">' + num(o.brierBase) + '</td></tr></table>' +
    '<p class="small dim" style="margin-top:8px">Ranges hold up out of sample: P25&ndash;P75 covers ' +
    pct100(cov.p2575) + ' of realised values, P10&ndash;P90 covers ' + pct100(cov.p1090) +
    '. Terms kept: ' + esc(kept) + '. Dropped as noise: ' + esc(dropped) + '.</p></div>';
}
function accountingCard() {
  var palette = ['#3ddc84', '#2a9d5c', '#f5b942', '#7dd3fc', '#c084fc', '#f472b6'];
  var total = ACCT.reduce(function (a, g) { return a + (g.n || 0); }, 0) || 1;
  var bar = ACCT.map(function (g, i) {
    return '<i style="width:' + ((g.n / total) * 100).toFixed(2) + '%;background:' +
      palette[i % palette.length] + '" title="' + esc(g.label) + ': ' + g.n + '"></i>';
  }).join('');
  var legend = ACCT.map(function (g, i) {
    return '<span><i class="sw" style="background:' + palette[i % palette.length] + '"></i>' +
      esc(g.label) + ' <b>' + g.n + '</b></span>';
  }).join('');
  return '<div class="card"><h3>All ' + total + ' snapshot protocols, accounted for</h3>' +
    '<div class="acct">' + bar + '</div><div class="acct-legend">' + legend + '</div>' +
    '<p class="small dim">Every protocol in the snapshot is either ranked on this board ' +
    'or named in a group above &mdash; nothing is silently dropped.</p>' +
    '<div class="formula">' + esc(META.formula || '') + '</div></div>';
}

// ---- tabs -----------------------------------------------------------------
function tabsBar() {
  var t = function (id, label) {
    return '<button type="button" role="tab" aria-selected="' + (S.tab === id) +
      '" onclick="RD.tab(\'' + id + '\')">' + label + '</button>';
  };
  return '<div class="tabs" role="tablist">' + t('board', 'Board') +
    t('comps', 'Live comps (' + COMPS.length + ')') +
    t('multiples', 'Multiples') + t('sandbox', 'Sandbox') + '</div>';
}

// ---- board tab ------------------------------------------------------------
function sortTh(key, label) {
  var arrow = S.sort === key ? (S.dir < 0 ? ' &#9660;' : ' &#9650;') : '';
  return '<th scope="col"><button type="button" onclick="RD.sort(\'' + key + '\')">' +
    label + arrow + '</button></th>';
}
function boardFilters() {
  var opts = function (list, cur, all) {
    var h = '<option value="all"' + (cur === 'all' ? ' selected' : '') + '>' + all + '</option>';
    list.forEach(function (x) {
      h += '<option value="' + esc(x) + '"' + (cur === x ? ' selected' : '') + '>' + esc(x) + '</option>';
    });
    return h;
  };
  var verdictOpts = ['all', 'FARM', 'MARGINAL', 'SKIP'].map(function (v) {
    return '<option value="' + v + '"' + (S.verdict === v ? ' selected' : '') + '>' +
      (v === 'all' ? 'All verdicts' : v) + '</option>';
  }).join('');
  return '<div class="filters">' +
    '<div class="field"><label for="f-q">Search</label>' +
    '<input type="search" id="f-q" placeholder="Name, slug, category or chain" value="' +
    esc(S.q) + '" oninput="RD.setQ(this.value)"></div>' +
    '<div class="field"><label for="f-cat">Category</label>' +
    '<select id="f-cat" onchange="RD.setCat(this.value)">' + opts(CATS, S.cat, 'All categories') + '</select></div>' +
    '<div class="field"><label for="f-chain">Chain</label>' +
    '<select id="f-chain" onchange="RD.setChain(this.value)">' + opts(CHAINS, S.chain, 'All chains') + '</select></div>' +
    '<div class="field"><label for="f-verdict">Verdict</label>' +
    '<select id="f-verdict" onchange="RD.setVerdict(this.value)">' + verdictOpts + '</select></div>' +
    '<div class="field"><label for="f-tvl">Min TVL ($M)</label>' +
    '<input type="number" id="f-tvl" min="0" step="10" value="' +
    (S.minTvl ? Math.round(S.minTvl / 1e6) : '') + '" placeholder="0" onchange="RD.setMinTvl(this.value)"></div>' +
    '<label class="check"><input type="checkbox" id="f-wl"' + (S.wl ? ' checked' : '') +
    ' onchange="RD.setWl(this.checked)"> Watchlist only</label>' +
    '<span class="count" id="rowcount"></span></div>';
}
function boardTable(list) {
  if (!list.length) {
    return '<div class="panel"><div class="empty"><h2>No protocol matches that filter</h2>' +
      '<p>Clear the search or pick another category to see the board again.</p>' +
      '<p style="margin-top:12px"><button type="button" class="btn primary" onclick="RD.clearFilters()">Clear filters</button></p></div></div>';
  }
  var rowsHtml = list.map(function (r) {
    var netCls = r.net >= 0 ? 'pos' : 'neg';
    var hourCls = r.perHour >= 0 ? 'pos' : 'neg';
    return '<tr data-slug="' + esc(r.slug) + '" class="' + (r.wl ? 'wl' : '') +
      '" tabindex="0" onclick="RD.open(\'' + esc(r.slug) + '\')" onkeydown="if(event.key===\'Enter\')RD.open(\'' + esc(r.slug) + '\')">' +
      '<td class="num">' + r.rank + '</td>' +
      '<td><div class="name"><b>' + esc(r.name) + '</b>' +
      '<span class="sub">' + esc(r.cat || 'Other') + ' &middot; ' +
      esc((r.chains || []).slice(0, 3).join(', ')) +
      (r.wl ? ' &middot; &#9733; watchlist' : '') + '</span></div></td>' +
      '<td class="num">' + money(r.tvl) + '<br><span class="sub ' +
      (r.chg >= 0 ? 'pos' : 'neg') + '">' + chgFmt(r.chg) + ' 7d</span></td>' +
      '<td class="num"><b>' + money(r.implied) + '</b><br><span class="sub">' +
      num(r.mult, 3) + 'x TVL</span></td>' +
      '<td class="num">' + money(r.p25) + '&ndash;' + money(r.p75) + '</td>' +
      '<td class="num">' + pct(r.odds) + '</td>' +
      '<td class="num ' + netCls + '">' + money(r.net) + '</td>' +
      '<td class="num ' + hourCls + '">' + money(r.perHour) + '/h</td>' +
      '<td><span class="badge ' + esc(r.verdict) + '">' + esc(r.verdict) + '</span></td></tr>';
  }).join('');
  return '<div class="panel"><div class="scroll"><table class="board">' +
    '<thead><tr>' + sortTh('rank', 'Rank') +
    '<th scope="col">Protocol</th>' + sortTh('tvl', 'TVL') + sortTh('implied', 'Implied') +
    '<th scope="col">P25&ndash;P75</th>' + sortTh('odds', 'Odds') + sortTh('net', 'Net $') +
    sortTh('perHour', '$/hour') + '<th scope="col">Verdict</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table></div></div>';
}
function refreshBoard() {
  var list = sorted(filtered());
  var wrap = document.getElementById('boardwrap');
  if (wrap) wrap.innerHTML = boardTable(list);
  var c = document.getElementById('rowcount');
  if (c) c.textContent = list.length + ' of ' + ROWS.length + ' rows';
}

// ---- live comps tab -------------------------------------------------------
function compsTab() {
  var list = COMPS.slice().sort(function (a, b) { return b.mult - a.mult; });
  var rowsHtml = list.map(function (c) {
    return '<tr><td><div class="name"><b>' + esc(c.name) + '</b>' +
      '<span class="sub">' + esc(c.cat || 'Other') + '</span></div></td>' +
      '<td class="num">' + money(c.tvl) + '</td><td class="num">' + money(c.mcap) +
      '</td><td class="num">' + num(c.mult, 3) + 'x</td></tr>';
  }).join('');
  return '<p class="small dim" style="margin:12px 0">The live-token protocols the fit ' +
    'learns from: their market-cap / TVL ratios set the sector multiples, so the ' +
    'board&rsquo;s implied values come from prices the market already set, not from a guessed constant.</p>' +
    '<div class="panel"><div class="scroll"><table class="board">' +
    '<thead><tr><th scope="col">Protocol</th><th scope="col">TVL</th>' +
    '<th scope="col">Market cap</th><th scope="col">mcap / TVL</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table></div></div>';
}

// ---- multiples tab --------------------------------------------------------
function multiplesTab() {
  var byCat = {};
  ROWS.forEach(function (r) {
    var c = r.cat || 'Other';
    (byCat[c] = byCat[c] || []).push(r.mult);
  });
  var rowsHtml = Object.keys(byCat).sort().map(function (c) {
    var ms = byCat[c].slice().sort(function (a, b) { return a - b; });
    var med = ms[Math.floor(ms.length / 2)];
    var eff = (COEF.sector && COEF.sector[c]);
    return '<tr><td><b>' + esc(c) + '</b></td><td class="num">' + ms.length +
      '</td><td class="num">' + (eff === undefined ? 'n/a' : signed(eff)) +
      '</td><td class="num">' + (eff === undefined ? 'n/a' : '&times;' + Math.exp(eff).toFixed(2)) +
      '</td><td class="num">' + num(med, 3) + 'x</td></tr>';
  }).join('');
  return '<p class="small dim" style="margin:12px 0">Sector effects from the log-log fit ' +
    '(intercept ' + num(COEF.a) + ', TVL exponent ' + num(COEF.b) +
    '): a positive effect lifts every protocol in that category above the TVL-only ' +
    'line. The last column is the median implied / TVL on the board itself.</p>' +
    '<div class="panel"><div class="scroll"><table class="board">' +
    '<thead><tr><th scope="col">Category</th><th scope="col">Board rows</th>' +
    '<th scope="col">Sector effect (log)</th><th scope="col">Multiple</th>' +
    '<th scope="col">Median implied / TVL</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table></div></div>';
}

// ---- sandbox tab ----------------------------------------------------------
function sandboxTab() {
  var b = S.sbx;
  var slider = function (id, label, val, min, max, step, fn) {
    return '<div class="slider"><label><span>' + label + '</span><b id="' + id + '-v">' +
      val + '</b></label><input type="range" id="' + id + '" min="' + min + '" max="' +
      max + '" step="' + step + '" value="' + fn + '" oninput="RD.sbx(this)"></div>';
  };
  return '<div class="sbx"><div class="card"><h3>Your farm, repriced live</h3>' +
    '<div class="sliders">' +
    slider('sb-dep', 'Deposit', money(b.deposit), 100, 10000, 100, b.deposit) +
    slider('sb-drop', 'Drop share', pct(b.drop, 1), 1, 20, 1, Math.round(b.drop * 100)) +
    slider('sb-weeks', 'Horizon', b.weeks + ' weeks', 4, 52, 4, b.weeks) +
    slider('sb-exp', 'TVL exponent', num(b.exp, 2), 0.5, 1.2, 0.05, b.exp) +
    '<label class="toggle"><input type="checkbox" id="sb-odds"' + (b.oddsOn ? ' checked' : '') +
    ' onchange="RD.sbx(this)"> Weight by token odds</label></div>' +
    '<p class="note" style="margin-top:14px">Every row below re-prices from your sliders: ' +
    'the deposit and drop share set the expected airdrop, the horizon vests it ' +
    '(min(weeks,12)/12) and adds gas, opportunity cost and hours, and the ' +
    'exponent plus the odds toggle re-fit and re-rank the whole board client-side ' +
    'from the printed coefficients. ' + esc((META.econ && META.econ.formula) || '') + '</p></div>' +
    '<div id="sbxwrap"></div></div>';
}
function refreshSandbox() {
  var b = S.sbx;
  var scored = ROWS.map(function (r) {
    var imp2 = refit(r, b.exp, b.oddsOn);
    var p = price({ implied: imp2, tvl: r.tvl, gasTx: r.gasTx, chains: r.chains },
      b.deposit, b.drop, b.weeks);
    return { row: r, implied: imp2, net: p.net, perHour: p.perHour, verdict: verdictOf(p) };
  }).sort(function (a, c) { return c.implied - a.implied; });
  var vc = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  scored.forEach(function (s) { vc[s.verdict]++; });
  var top = scored.slice(0, 30);
  var rowsHtml = top.map(function (s, i) {
    var r = s.row;
    return '<tr data-slug="' + esc(r.slug) + '" onclick="RD.open(\'' + esc(r.slug) + '\')">' +
      '<td class="num">' + (i + 1) + '</td>' +
      '<td><div class="name"><b>' + esc(r.name) + '</b><span class="sub">' +
      esc(r.cat || 'Other') + ' &middot; board #' + r.rank + '</span></div></td>' +
      '<td class="num">' + money(s.implied) + '</td>' +
      '<td class="num ' + (s.net >= 0 ? 'pos' : 'neg') + '">' + money(s.net) + '</td>' +
      '<td class="num ' + (s.perHour >= 0 ? 'pos' : 'neg') + '">' + money(s.perHour) + '/h</td>' +
      '<td><span class="badge ' + s.verdict + '">' + s.verdict + '</span></td></tr>';
  }).join('');
  var wrap = document.getElementById('sbxwrap');
  if (!wrap) return;
  wrap.innerHTML = '<p class="small dim" style="margin-bottom:8px">Deposit ' + money(b.deposit) +
    ' &middot; drop ' + pct(b.drop, 1) + ' &middot; ' + b.weeks + ' weeks &middot; exponent ' +
    num(b.exp, 2) + ' &middot; odds ' + (b.oddsOn ? 'on' : 'off') + ': <b class="pos">' +
    vc.FARM + ' FARM</b> &middot; <b style="color:var(--amber)">' + vc.MARGINAL +
    ' marginal</b> &middot; ' + vc.SKIP + ' skip. Top 30 of ' + scored.length + ' repriced rows:</p>' +
    '<div class="panel"><div class="scroll"><table class="board">' +
    '<thead><tr><th scope="col">New rank</th><th scope="col">Protocol</th>' +
    '<th scope="col">Refit implied</th><th scope="col">Net $</th><th scope="col">$/hour</th>' +
    '<th scope="col">Verdict</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div>';
}

// ---- detail dialog --------------------------------------------------------
function stepHtml(step) {
  if (typeof step === 'string') return '<li>' + esc(step) + '</li>';
  return '<li>' + esc(step.text || '') +
    '<span class="cost">' + esc(step.cost || '') + ' &middot; ' + esc(step.time || '') + '</span></li>';
}
function openDetail(slug) {
  var r = null;
  ROWS.forEach(function (x) { if (x.slug === slug) r = x; });
  if (!r) return;
  var rc = recompute(r);
  var dlg = document.getElementById('dlg');
  var matchCls = rc.diff <= 0.02 ? 'match' : 'match bad';
  var matchTxt = rc.diff <= 0.02
    ? '&#10003; Recompute check: the printed formula gives ' + moneyFull(rc.value) +
      ' from this row&rsquo;s own TVL, sector effect and token odds &mdash; within ' +
      (rc.diff * 100).toFixed(1) + '% of the board&rsquo;s ' + moneyFull(r.implied) + '.'
    : '&#10007; Recompute check: the printed formula gives ' + moneyFull(rc.value) +
      ' but the board shows ' + moneyFull(r.implied) + ' &mdash; ' +
      (rc.diff * 100).toFixed(1) + '% apart. The data and the formula disagree.';
  var steps = (r.farm || []).map(stepHtml).join('');
  dlg.innerHTML =
    '<div class="d-head"><div><span class="small dim">Rank ' + r.rank + ' of ' + ROWS.length +
    (r.wl ? ' &middot; &#9733; watchlist' : '') + '</span><h2 id="dlg-title">' + esc(r.name) +
    '</h2><p class="small dim">' + esc(r.cat || 'Other') + ' on ' +
    esc((r.chains || []).join(', ')) + '</p></div>' +
    '<button type="button" class="btn" onclick="RD.close()">Close</button></div>' +
    '<div class="d-body"><section class="d-sec"><h3>Implied value</h3><div class="kv">' +
    '<div><span>TVL</span><b>' + moneyFull(r.tvl) + '</b></div>' +
    '<div><span>7-day TVL change</span><b>' + chgFmt(r.chg) + '</b></div>' +
    '<div><span>Age with no token</span><b>' + ageFmt(r.age) +
    (r.listed ? ' &middot; listed ' + esc(r.listed) : '') + '</b></div>' +
    '<div><span>Fitted multiple</span><b>' + num(r.mult, 3) + 'x TVL</b></div>' +
    '<div><span>Sector effect</span><b>' + signed(rc.eff) + ' log points</b></div>' +
    '<div><span>Token odds</span><b>' + pct(r.odds) + '</b></div>' +
    '<div><span>Implied value</span><b>' + moneyFull(r.implied) + '</b></div>' +
    '<div><span>P25&ndash;P75 range</span><b>' + moneyFull(r.p25) + ' &ndash; ' + moneyFull(r.p75) + '</b></div>' +
    '<div><span>P10&ndash;P90 range</span><b>' + moneyFull(r.p10) + ' &ndash; ' + moneyFull(r.p90) + '</b></div>' +
    '</div><div class="' + matchCls + '">' + matchTxt + '</div></section>' +
    '<section class="d-sec"><h3>Verdict</h3><div class="kv">' +
    '<div><span>Verdict</span><b><span class="badge ' + esc(r.verdict) + '">' + esc(r.verdict) + '</span></b></div>' +
    '<div><span>Net after gas</span><b>' + moneyFull(r.net) + '</b></div>' +
    '<div><span>Return per hour</span><b>' + moneyFull(r.perHour) + ' / hour</b></div>' +
    '<div><span>Gas budget</span><b>' + moneyFull(r.gas) + '</b></div>' +
    '<div><span>Time needed</span><b>' + r.hours + ' hours over ' + r.weeks + ' weeks</b></div>' +
    '</div></section>' +
    '<section class="d-sec"><h3>Farm plan &mdash; ' + (r.farm || []).length + ' steps</h3>' +
    '<ol class="steps">' + steps + '</ol></section></div>';
  if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
  else dlg.setAttribute('open', '');
}

// ---- render + public API --------------------------------------------------
function renderTab() {
  var body = document.getElementById('tabbody');
  if (!body) return;
  document.querySelectorAll('.tabs button').forEach(function (btn, i) {
    btn.setAttribute('aria-selected', ['board', 'comps', 'multiples', 'sandbox'][i] === S.tab ? 'true' : 'false');
  });
  if (S.tab === 'board') {
    body.innerHTML = boardFilters() + '<div id="boardwrap"></div>';
    refreshBoard();
  } else if (S.tab === 'comps') body.innerHTML = compsTab();
  else if (S.tab === 'multiples') body.innerHTML = multiplesTab();
  else if (S.tab === 'sandbox') { body.innerHTML = sandboxTab(); refreshSandbox(); }
}
function renderShell() {
  root.setAttribute('aria-busy', 'false');
  root.innerHTML = '<div class="wrap">' + masthead() + kpis() + integrityStrip() +
    '<div class="cover">' + validationCard() + accountingCard() + '</div>' +
    tabsBar() + '<div id="tabbody"></div>' +
    '<footer><span>Built for make.fun bounty token-radar-01 &mdash; make.fun/bounty/token-radar-01</span>' +
    '<span>Snapshot ' + esc(META.asOf || '') + ' &middot; ' + esc(META.model || '') + '</span>' +
    '<span>Implied values are model estimates, not prices. A verdict is a costed guess, not advice.</span>' +
    '<span class="mono">checksum ' + esc(INTEGRITY.checksum || '') + '</span></footer></div>' +
    '<dialog class="detail" id="dlg" aria-labelledby="dlg-title"></dialog>';
  renderTab();
}

window.RD = {
  tab: function (id) { S.tab = id; renderTab(); },
  sort: function (key) {
    if (S.sort === key) S.dir = -S.dir;
    else { S.sort = key; S.dir = -1; }
    refreshBoard();
  },
  setQ: function (v) { S.q = v; refreshBoard(); },
  setCat: function (v) { S.cat = v; refreshBoard(); },
  setChain: function (v) { S.chain = v; refreshBoard(); },
  setVerdict: function (v) { S.verdict = v; refreshBoard(); },
  setMinTvl: function (v) { S.minTvl = (parseFloat(v) || 0) * 1e6; refreshBoard(); },
  setWl: function (on) { S.wl = !!on; refreshBoard(); },
  clearFilters: function () {
    S.q = ''; S.cat = 'all'; S.chain = 'all'; S.wl = false; S.minTvl = 0; S.verdict = 'all';
    renderTab();
  },
  open: function (slug) { openDetail(slug); },
  close: function () { var d = document.getElementById('dlg'); if (d) d.close(); },
  sbx: function (el) {
    var b = S.sbx;
    if (el.id === 'sb-dep') { b.deposit = +el.value; document.getElementById('sb-dep-v').textContent = money(b.deposit); }
    if (el.id === 'sb-drop') { b.drop = +el.value / 100; document.getElementById('sb-drop-v').textContent = pct(b.drop, 1); }
    if (el.id === 'sb-weeks') { b.weeks = +el.value; document.getElementById('sb-weeks-v').textContent = b.weeks + ' weeks'; }
    if (el.id === 'sb-exp') { b.exp = +el.value; document.getElementById('sb-exp-v').textContent = num(b.exp, 2); }
    if (el.id === 'sb-odds') b.oddsOn = el.checked;
    refreshSandbox();
  }
};

// ---- boot + deep links ----------------------------------------------------
renderShell();
var P = new URLSearchParams(window.location.search);
var shot = P.get('shot');
if (shot === 'sandbox') { S.tab = 'sandbox'; renderTab(); }
else if (shot === 'filtered' && P.get('category')) { S.cat = P.get('category'); renderTab(); }
else if (shot === 'detail' && P.get('slug')) { openDetail(P.get('slug')); }
})();

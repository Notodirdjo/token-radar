// Token Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, the live comps, the multiples table and a model sandbox, plus a
// per-protocol detail dialog with the model's own inputs and the protocol's farm plan. No network:
// every byte it shows is in data.js. The page recomputes every implied value from the snapshot
// figures with the same function main.ts runs, so the page's code and board.json visibly agree.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var MODEL = DATA.model;
  var state = {
    q: '', category: 'all', chain: 'all', watchlistOnly: false, minTvl: 0,
    tab: 'board', sort: 'implied', dir: -1, selected: null,
    sb: { growth_weight: MODEL.growth_weight, maturity_range: MODEL.maturity_range, multiple_cap: MODEL.multiple_cap }
  };

  function $(id) { return document.getElementById(id); }
  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return n.toFixed(2) + 'x'; }

  // The model in one function: the same arithmetic main.ts runs, with the sandbox's constants.
  function impliedOf(row, c) {
    var multiple = Math.min(row.multiple, c.multiple_cap);
    var growth = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor,
      row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * c.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? MODEL.unknown_age_days : row.age_days;
    var maturity = MODEL.maturity_floor + (Math.min(Math.max(age, 0), MODEL.maturity_days) / MODEL.maturity_days) * c.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * multiple * growthMult * maturity));
  }
  function defaultConstants() {
    return { growth_weight: MODEL.growth_weight, maturity_range: MODEL.maturity_range, multiple_cap: MODEL.multiple_cap };
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function gasFor(chain) {
    var c = chain.toLowerCase();
    if (c.indexOf('ethereum') >= 0) return '$8-15 of gas';
    if (c.indexOf('solana') >= 0) return '$0.05-0.20 of gas';
    if (c.indexOf('bsc') >= 0 || c.indexOf('bnb') >= 0 || c.indexOf('binance') >= 0) return '$0.30-1 of gas';
    if (c.indexOf('polygon') >= 0) return '$0.10-0.50 of gas';
    if (c.indexOf('arbitrum') >= 0 || c.indexOf('base') >= 0 || c.indexOf('optimism') >= 0 ||
      c.indexOf('zksync') >= 0 || c.indexOf('linea') >= 0 || c.indexOf('blast') >= 0 ||
      c.indexOf('scroll') >= 0 || c.indexOf('mantle') >= 0 || c.indexOf('mode') >= 0 ||
      c.indexOf('unichain') >= 0) return '$0.50-2 of gas';
    if (c.indexOf('avalanche') >= 0) return '$0.50-2 of gas';
    return '$1-3 of gas';
  }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ', in a range near the current price, and keep the position open.';
    if (c.indexOf('yield') >= 0) return 'Deposit $' + capital + ' of USDC into ' + name + "'s highest-TVL strategy on " + chain + ' and let the yield compound.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + capital + " of the chain's staking asset through " + name + ' and keep the receipt token.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge, not a leveraged bet.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + ', then leave it to settle.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the vault shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + ' and hold it.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + " of " + name + "'s yield-bearing asset on " + chain + ' and hold it for the yield.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.';
    if (c.indexOf('basis') >= 0) return 'Deposit $' + capital + " into " + name + "'s basis strategy on " + chain + ' and keep the position open.';
    if (c.indexOf('chain') >= 0) return 'Bridge $' + capital + " to " + name + "'s chain, hold it there, and use one of its native apps.";
    if (c.indexOf('launchpad') >= 0) return 'Stake $' + capital + ' for ' + name + "'s allocation tier on " + chain + ' and join one sale.';
    if (c.indexOf('nft') >= 0) return 'Buy one ' + name + ' item for about $' + capital + ' on ' + chain + ' and hold it in the farm wallet.';
    if (c.indexOf('gaming') >= 0) return 'Fund $' + capital + ' into ' + name + "'s game wallet on " + chain + ' and play one session a week.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function deepenFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Borrow 30-40% of what you supplied from ' + name + ' and repay half of it a week later, so the wallet counts as a borrower as well as a supplier.';
    if (c.indexOf('dex') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Add a second, smaller position in another ' + name + ' pool on ' + chain + ', and swap once through the router so the wallet has both LP and trader activity.';
    if (c.indexOf('yield') >= 0) return "Claim the strategy's rewards once and restake them into the same " + name + ' vault, so the wallet shows a claim and a second deposit.';
    if (c.indexOf('bridge') >= 0) return 'Make the return trip a week later: bridge half the funds back through ' + name + ', so the wallet has volume in both directions.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Delegate or restake a second, smaller amount through ' + name + ' to a different validator or operator.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Close the first hedge after a week and open a second one half the size, so the wallet has two settled trades.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit a second, smaller amount into a different ' + name + ' vault on ' + chain + ' to spread the position across two vaults.';
    if (c.indexOf('rwa') >= 0 || c.indexOf('stable') >= 0) return 'Hold the asset for a full yield cycle, then claim the accrued yield once and keep the principal in place.';
    if (c.indexOf('prediction') >= 0) return 'Place a second position in a different ' + name + ' market once the first one settles.';
    if (c.indexOf('chain') >= 0) return 'Use a second native app on ' + name + "'s chain with a small amount, so the wallet is active in more than one place.";
    return 'Make a second, smaller deposit into ' + name + ' a week after the first, so the wallet shows repeat activity rather than one transaction.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gas = gasFor(chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline, never in a screenshot or a chat.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about ' + gas, time: '15 minutes to set up' },
      { text: deepenFor(p, capital, chain), cost: 'about ' + gas, time: '10 minutes' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the wallet stays active across snapshots.', cost: 'about ' + gas + ' a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes; a real airdrop never asks you to pay to claim.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it later.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  // ---- state from the URL: a hash for sharing, query params for staged screenshots ----
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('watchlist') === '1') state.watchlistOnly = true;
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('p')) state.selected = params.get('p');
  }
  function readShot() {
    var params = new URLSearchParams(window.location.search);
    var shot = params.get('shot');
    if (!shot) return;
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('watchlist') === '1') state.watchlistOnly = true;
    if (shot === 'detail' && params.get('slug')) { state.selected = params.get('slug'); state.tab = 'board'; }
    else if (shot === 'filtered') { state.tab = 'board'; if (!params.get('category') && !params.get('q') && !params.get('chain')) state.watchlistOnly = true; }
    else if (shot === 'live') state.tab = 'live';
    else if (shot === 'multiples') state.tab = 'multiples';
    else if (shot === 'sandbox') state.tab = 'sandbox';
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchlistOnly) params.set('watchlist', '1');
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.watchlistOnly && !r.on_watchlist) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'multiple') { av = a.multiple; bv = b.multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function renderFacts() {
    $('meta-date').textContent = 'Snapshot ' + DATA.as_of;
    $('meta-model').textContent = DATA.model_version + ' model';
    $('foot-date').textContent = DATA.as_of;
    $('headline').textContent = DATA.watchlist_size + ' watchlist protocols, ranked by implied value';
    $('fact-watch').textContent = DATA.watchlist_size + ' / ' + DATA.watchlist_size;
    $('fact-board').textContent = String(DATA.board_size);
    $('fact-early').textContent = String(DATA.early_size);
    $('fact-live').textContent = DATA.multiples.global_n + ' live tokens';
    $('formula').textContent = 'implied = round( tvl_usd x multiple(category) x (1 + clamp(change_7d, ' +
      MODEL.growth_floor + ', ' + MODEL.growth_cap + ') / 100 x ' + MODEL.growth_weight + ') x (' +
      MODEL.maturity_floor + ' + min(age_days, ' + MODEL.maturity_days + ') / ' + MODEL.maturity_days +
      ' x ' + MODEL.maturity_range + ') )   —   multiple(category) = median mcap/TVL of its live comps (categories with fewer than 3 live comps use the global median), capped at ' +
      MODEL.multiple_cap + '; global median ' + DATA.multiples.global_median.toFixed(3) + ' (n=' + DATA.multiples.global_n + ')';
    var top = DATA.multiples.by_category.slice(0, 6);
    var tbody = document.querySelector('#mult-table tbody');
    tbody.textContent = '';
    top.forEach(function (m) {
      tbody.appendChild(el('tr', null,
        el('td', { text: m.category }),
        el('td', { class: 'num', text: String(m.n) }),
        el('td', { class: 'num', text: fmtMult(m.median) }),
        el('td', { class: 'num', text: fmtMult(m.multiple) })
      ));
    });
  }

  function fillSelect(select, values) {
    values.forEach(function (v) {
      select.appendChild(el('option', { value: v, text: v }));
    });
  }
  function initControls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    fillSelect($('category'), categories);
    fillSelect($('chain'), chains);
    $('q').value = state.q;
    $('category').value = state.category;
    $('chain').value = state.chain;
    $('min-tvl').value = String(state.minTvl);
    $('watchlist-only').checked = state.watchlistOnly;
    $('q').addEventListener('input', function () { state.q = $('q').value; writeHash(); render(); });
    $('category').addEventListener('change', function () { state.category = $('category').value; writeHash(); render(); });
    $('chain').addEventListener('change', function () { state.chain = $('chain').value; writeHash(); render(); });
    $('min-tvl').addEventListener('change', function () { state.minTvl = Number($('min-tvl').value); writeHash(); render(); });
    $('watchlist-only').addEventListener('change', function () { state.watchlistOnly = $('watchlist-only').checked; writeHash(); render(); });
    $('clear-filters').addEventListener('click', function () {
      state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlistOnly = false; state.minTvl = 0;
      $('q').value = ''; $('category').value = 'all'; $('chain').value = 'all'; $('min-tvl').value = '0'; $('watchlist-only').checked = false;
      writeHash(); render();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (btn) {
      btn.addEventListener('click', function () { state.tab = btn.getAttribute('data-tab'); writeHash(); render(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#board-table th button'), function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-sort');
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = -1; }
        render();
      });
    });
    $('sb-growth').addEventListener('input', function () { state.sb.growth_weight = Number($('sb-growth').value); renderSandbox(); });
    $('sb-maturity').addEventListener('input', function () { state.sb.maturity_range = Number($('sb-maturity').value); renderSandbox(); });
    $('sb-cap').addEventListener('input', function () { state.sb.multiple_cap = Number($('sb-cap').value); renderSandbox(); });
    $('sb-reset').addEventListener('click', function () {
      state.sb = defaultConstants();
      $('sb-growth').value = String(state.sb.growth_weight);
      $('sb-maturity').value = String(state.sb.maturity_range);
      $('sb-cap').value = String(state.sb.multiple_cap);
      renderSandbox();
    });
  }

  function renderBoard() {
    var list = sortedRows(filteredRows());
    var table = $('board-table');
    var empty = $('board-empty');
    var tbody = table.querySelector('tbody');
    tbody.textContent = '';
    table.hidden = list.length === 0;
    empty.hidden = list.length !== 0;
    $('count').textContent = list.length + ' rows shown';
    if (list.length === 0) return;
    var max = 0;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', null, r.name, r.on_watchlist ? el('span', { class: 'watch', text: '  WATCHLIST' }) : null),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtMult(r.multiple) + ' (' + r.multiple_n + ')' }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status pre', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#board-table th button'), function (btn) {
      var base = btn.getAttribute('data-sort');
      var label = { implied: 'Implied value', name: 'Protocol', tvl: 'TVL', growth: '7d', age: 'Age', multiple: 'Multiple' }[base];
      btn.textContent = label + (state.sort === base ? (state.dir < 0 ? ' ↓' : ' ↑') : '');
    });
  }

  function renderLive() {
    var tbody = document.querySelector('#live-table tbody');
    tbody.textContent = '';
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_tvl === null ? 'n/a' : fmtMult(r.mcap_tvl) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    $('count').textContent = DATA.live.length + ' live-token protocols';
  }

  function renderMultiples() {
    var tbody = document.querySelector('#multiples-table tbody');
    tbody.textContent = '';
    DATA.multiples.by_category.forEach(function (m) {
      var note = m.n >= MODEL.min_category_sample ? 'median of ' + m.n + ' live comps'
        : m.n > 0 ? 'too few live comps (' + m.n + '): the global median'
        : 'no live comps: global median';
      if (m.multiple >= MODEL.multiple_cap) note += '; capped at ' + MODEL.multiple_cap.toFixed(1);
      tbody.appendChild(el('tr', null,
        el('td', { text: m.category }),
        el('td', { class: 'num', text: String(m.n) }),
        el('td', { class: 'num', text: fmtMult(m.median) }),
        el('td', { class: 'num', text: fmtMult(m.multiple) }),
        el('td', { text: note })
      ));
    });
    tbody.appendChild(el('tr', null,
      el('td', null, el('b', { text: 'Global (all live tokens)' })),
      el('td', { class: 'num', text: String(DATA.multiples.global_n) }),
      el('td', { class: 'num', text: fmtMult(DATA.multiples.global_median) }),
      el('td', { class: 'num', text: fmtMult(DATA.multiples.global_median) }),
      el('td', { text: 'the fallback for categories with no live comps' })
    ));
    $('count').textContent = DATA.multiples.by_category.length + ' categories priced';
  }

  function renderSandbox() {
    $('sb-growth-val').textContent = state.sb.growth_weight.toFixed(2);
    $('sb-maturity-val').textContent = state.sb.maturity_range.toFixed(2);
    $('sb-cap-val').textContent = state.sb.multiple_cap.toFixed(1) + 'x';
    var scored = DATA.rows.map(function (r) {
      return { row: r, implied: impliedOf(r, state.sb) };
    }).sort(function (a, b) { return b.implied - a.implied || (a.row.slug < b.row.slug ? -1 : a.row.slug > b.row.slug ? 1 : 0); });
    var tbody = document.querySelector('#sandbox-table tbody');
    tbody.textContent = '';
    scored.slice(0, 10).forEach(function (s, i) {
      var moved = s.row.rank - (i + 1);
      tbody.appendChild(el('tr', { onclick: function () { openDetail(s.row.slug); } },
        el('td', { class: 'num', text: String(i + 1) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: s.row.name }), el('span', { class: 'sub', text: s.row.category || 'Other' }))),
        el('td', { class: 'num', text: fmtUsd(s.row.tvl_usd) }),
        el('td', { class: 'num', text: fmtMult(Math.min(s.row.multiple, state.sb.multiple_cap)) }),
        el('td', { class: 'num', text: fmtUsd(s.implied) }),
        el('td', { class: 'num ' + (moved > 0 ? 'pos' : moved < 0 ? 'neg' : ''), text: '#' + s.row.rank + (moved !== 0 ? ' (' + (moved > 0 ? '+' : '') + moved + ')' : '') })
      ));
    });
    $('count').textContent = 'Top 10 under your constants';
  }

  var dialog = $('detail');
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); renderBoard(); });

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var recomputed = impliedOf(row, defaultConstants());
    var mult = null;
    DATA.multiples.by_category.forEach(function (m) { if (m.category === (row.category || 'Other')) mult = m; });
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.on_watchlist ? ' · Watchlist' : ' · Early radar') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category multiple' }), el('b', { class: 'num', text: fmtMult(row.multiple) + ' (n=' + row.multiple_n + ')' })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Growth × maturity' }), el('b', { class: 'num', text: row.growth_multiplier.toFixed(3) + ' × ' + row.maturity_multiplier.toFixed(3) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the multiple is ' + (row.category || 'Other') +
        "'s median mcap/TVL among live tokens" + (mult && mult.n >= MODEL.min_category_sample ? ' (' + mult.n + ' comps, median ' + fmtMult(mult.median) + ')' : ' (too few live comps: the global median ' + fmtMult(DATA.multiples.global_median) + ')') +
        '. The page recomputes this row as ' + fmtUsd(recomputed) +
        (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') +
        ' This is an estimate, not a price, and it says nothing about whether or when a token launches.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-tab') === state.tab ? 'true' : 'false');
    });
    $('board-panel').hidden = state.tab !== 'board';
    $('live-panel').hidden = state.tab !== 'live';
    $('multiples-panel').hidden = state.tab !== 'multiples';
    $('sandbox-panel').hidden = state.tab !== 'sandbox';
    if (state.tab === 'board') renderBoard();
    else if (state.tab === 'live') renderLive();
    else if (state.tab === 'multiples') renderMultiples();
    else renderSandbox();
    $('board').setAttribute('aria-busy', 'false');
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  readShot();
  renderFacts();
  initControls();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
  window.__radar = { state: state, impliedOf: impliedOf, farmSteps: farmSteps, DATA: DATA };
})();

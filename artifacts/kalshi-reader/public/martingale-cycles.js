(function () {
  'use strict';
  var root = document.getElementById('martingale-cycle-cards');
  var stamp = document.getElementById('martingale-cycle-updated');
  if (!root || !stamp) return;
  function setText(element, text) { element.textContent = String(text); }
  function card(market, cycle) {
    var section = document.createElement('div');
    section.style.cssText = 'border:1px solid #41536b;border-radius:8px;padding:14px;min-width:0';
    var name = document.createElement('strong');
    setText(name, market);
    var step = document.createElement('div');
    step.style.cssText = 'font-weight:700;font-size:21px;margin:8px 0';
    setText(step, cycle && Number.isInteger(cycle.step) && cycle.step > 0 ?
      'Step ' + cycle.step + ' / ' + (cycle.maxSteps || '?') : 'Step unavailable');
    var stake = document.createElement('div');
    setText(stake, cycle && Number.isFinite(cycle.nextWagerCents) ?
      'Next $' + (cycle.nextWagerCents / 100).toFixed(2) : 'Next wager unavailable');
    var state = document.createElement('small');
    state.style.color = '#b9c7da';
    setText(state, cycle && cycle.status ? cycle.status : 'Verified cycle source unavailable');
    section.append(name, step, stake, document.createElement('br'), state);
    return section;
  }
  async function refresh() {
    var cycles = [];
    var label = 'Cycle source unavailable';
    try {
      var response = await fetch('/api/trade/analytics/martingale-cycles', {cache:'no-store'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var result = await response.json();
      if (!Array.isArray(result.cycles)) throw new Error('Invalid response');
      cycles = result.cycles;
      label = 'Updated ' + new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York'}) + ' ET';
    } catch (_) { label = 'Cycle source unavailable; no steps inferred from trade history'; }
    root.replaceChildren(...['USD','ETH','BTC'].map(function (market) {
      return card(market, cycles.find(function (x) {return x.market === market;}));
    }));
    setText(stamp, label);
  }
  refresh();
  setInterval(refresh, 10000);
})();

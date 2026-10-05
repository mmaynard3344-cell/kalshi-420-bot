const inventory = [
  {home:'100 Epperly', plan:'Oconee', sf:1893, ask:409990, ppsf:216.58},
  {home:'102 Epperly', plan:'Oconee', sf:1893, ask:409990, ppsf:216.58},
  {home:'106 Epperly', plan:'Oconee End', sf:1893, ask:463990, ppsf:245.11},
  {home:'6122 Wayburn', plan:'Forsyth', sf:1967, ask:429990, ppsf:218.60},
  {home:'6120 Wayburn', plan:'Forsyth', sf:1967, ask:460430, ppsf:234.08},
];

const closings = [
  {home:'98 Epperly', plan:'Oconee', price:399990},
  {home:'6137 Wayburn', plan:'Forsyth', price:399990},
  {home:'6133 Wayburn', plan:'Forsyth', price:399990},
  {home:'Reynolds comp', plan:'Reynolds', price:435000},
  {home:'Reynolds comp', plan:'Reynolds', price:450000},
];

const competitors = [
  ['Fern Parc', '$399,950–$439,950'],
  ['Rosewood Farm • Forsyth', '$349,990'],
  ['Trinity Park resale • 2,194 sf', '$449,900'],
];

const pricing = [
  ['Oconee interiors', '$399,990', 'Move into the proven closing band'],
  ['Standard Forsyth', '$409,990', 'Close the gap to same-community sales'],
  ['End unit / premium Forsyth', '$419,990', 'Retain premium while improving velocity'],
];

const reductions = [
  ['100 Epperly', '$47,000'],
  ['102 Epperly', '$49,000'],
  ['6122 Wayburn', '$33,390'],
];

const money = n => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);

document.querySelector('#inventoryRows').innerHTML = inventory.map(x =>
  `<tr><td>${x.home}</td><td>${x.plan}</td><td>${x.sf.toLocaleString()}</td><td>${money(x.ask)}</td><td>$${x.ppsf.toFixed(2)}</td></tr>`
).join('');

document.querySelector('#closingRows').innerHTML = closings.map(x =>
  `<tr><td>${x.home}</td><td>${x.plan}</td><td>${money(x.price)}</td></tr>`
).join('');

document.querySelector('#competitors').innerHTML = competitors.map(([name,price]) =>
  `<div class="comp-row"><span>${name}</span><strong>${price}</strong></div>`
).join('');

document.querySelector('#pricingPlan').innerHTML = pricing.map(([label,price,reason]) =>
  `<article class="price-card"><span>${label}</span><strong>${price}</strong><p>${reason}</p></article>`
).join('');

document.querySelector('#reductions').innerHTML = reductions.map(([home,amount]) =>
  `<div class="reduction"><span>${home}</span><strong>${amount}</strong></div>`
).join('');

const asks = inventory.map(x=>x.ask);
const avgAsk = asks.reduce((a,b)=>a+b,0)/asks.length;
const minAsk = Math.min(...asks);
const maxAsk = Math.max(...asks);

const kpis = [
  ['Tracked inventory','5 homes','Current public sample'],
  ['Ask range',`${money(minAsk)}–${money(maxAsk)}`,'Wide premium spread'],
  ['Average tracked ask',money(avgAsk),'Across five homes'],
  ['Same-community median close','$399,990','Five-sale sample'],
];

document.querySelector('#kpis').innerHTML = kpis.map(([label,value,detail]) =>
  `<article class="kpi"><span>${label}</span><strong>${value}</strong><em>${detail}</em></article>`
).join('');

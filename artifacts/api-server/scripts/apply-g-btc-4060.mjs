import fs from "node:fs";

const path = "artifacts/api-server/src/g4060ScalpIndex.ts";
let source = fs.readFileSync(path, "utf8");

const replacements = [
  ['const SERIES = "KXETH15M";', 'const SERIES = "KXBTC15M";'],
  ['/^KXETH15M-/.test(String(market["ticker"]))', '/^KXBTC15M-/.test(String(market["ticker"]))'],
  ['/^KXETH15M-/.test(ticker)', '/^KXBTC15M-/.test(ticker)'],
];

for (const [from, to] of replacements) {
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error(`Expected exactly one G BTC patch anchor for ${from}, found ${hits}`);
  source = source.replace(from, to);
}

if (source.includes('KXETH15M-')) throw new Error('Unexpected ETH15 ticker guard remains in G runner');
fs.writeFileSync(path, source);
console.log('Applied G 40-60 BTC15 market switch');

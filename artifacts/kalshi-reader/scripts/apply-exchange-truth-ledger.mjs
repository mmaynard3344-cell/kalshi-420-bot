import fs from 'node:fs';

const runtimePath = new URL('../public/pnl-runtime.js', import.meta.url);
let runtime = fs.readFileSync(runtimePath, 'utf8');

// Financial execution truth comes only from /api/trade/fills. Local strategy
// rows may describe an intent/reservation, but they cannot supply a fill count.
const fillFallbackPatterns = [
  /filled=f\?f\.contracts:reported\(o\)/g,
  /filled=f\?f\.contracts:orderFilled\(o\)/g,
];
let fillFallbackChanged = false;
for (const pattern of fillFallbackPatterns) {
  const next = runtime.replace(pattern, 'filled=f?f.contracts:0');
  if (next !== runtime) {
    runtime = next;
    fillFallbackChanged = true;
  }
}

// If no exchange fill is joined, never inherit a local status such as EXECUTED.
// Preserve the local intent in the table, but label it explicitly as unconfirmed.
const statusPatterns = [
  /status=orderStatus\(o\)\|\|'—'/g,
  /status=status\(o\)\|\|'—'/g,
];
let statusChanged = false;
for (const pattern of statusPatterns) {
  const next = runtime.replace(pattern, "status=f?(orderStatus?.(o)||status?.(o)||'—'):'LOCAL INTENT · NO KALSHI FILL'");
  if (next !== runtime) {
    runtime = next;
    statusChanged = true;
  }
}

// The optional-call expression above cannot be emitted if those identifiers are
// not both present in a given compact runtime. Normalize it to the identifier
// actually used by that runtime.
runtime = runtime.replace(
  "status=f?(orderStatus?.(o)||status?.(o)||'—'):'LOCAL INTENT · NO KALSHI FILL'",
  runtime.includes('const orderStatus=')
    ? "status=f?(orderStatus(o)||'—'):'LOCAL INTENT · NO KALSHI FILL'"
    : "status=f?(status(o)||'—'):'LOCAL INTENT · NO KALSHI FILL'",
);

if (!fillFallbackChanged) {
  // A previously-fixed source is acceptable only if the exchange-only form is
  // already present. Otherwise fail the build instead of silently shipping.
  if (!runtime.includes('filled=f?f.contracts:0')) {
    throw new Error('Exchange-truth fill anchor not found');
  }
}
if (!statusChanged && !runtime.includes("'LOCAL INTENT · NO KALSHI FILL'")) {
  throw new Error('Exchange-truth status anchor not found');
}

// Regression proof: no local filled-contract fallback may remain in the live
// runtime after this finalizer.
if (/filled=f\?f\.contracts:(?:reported|orderFilled)\(o\)/.test(runtime)) {
  throw new Error('Local fill fallback survived exchange-truth finalizer');
}

fs.writeFileSync(runtimePath, runtime);

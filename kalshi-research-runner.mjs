#!/usr/bin/env node

const raw = process.env.KALSHI_PRIVATE_KEY || "";
if (!raw) {
  console.error("KALSHI_PRIVATE_KEY is missing");
  process.exit(1);
}

let s = raw.replace(/\\n/g, "\n").trim();
const headerRe = /^(-----BEGIN [^-]+-----)\s+([A-Za-z0-9+/\s=]+?)\s*(-----END [^-]+-----)$/s;
const m = s.match(headerRe);
if (m) {
  const header = m[1];
  const body = m[2].replace(/\s+/g, "");
  const footer = m[3];
  const lines = body.match(/.{1,64}/g) ?? [];
  s = [header, ...lines, footer].join("\n");
}

process.env.KALSHI_PRIVATE_KEY = s;
await import("./kalshi-pull-research-100d.mjs");

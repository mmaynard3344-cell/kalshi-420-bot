import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";
import { execFileSync, execSync } from "node:child_process";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

function resolveCommitSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function buildAll() {
  // Service-split branches contain the canonical validated source directly.
  // Apply only explicit, narrowly-scoped production transforms before bundling.
  execFileSync(process.execPath, [path.resolve(artifactDir, "scripts/apply-dashboard-history-pagination.mjs")], {
    stdio: "inherit",
  });
  // Service A is intentionally an always-trade martingale road. Remove only its
  // daily-P&L entry stops; reconciliation, exposure, balance, market metadata,
  // deduplication, durable reservation, and runtime kill-switch gates remain intact.
  execFileSync(process.execPath, [path.resolve(artifactDir, "scripts/apply-service-a-always-trade.mjs")], {
    stdio: "inherit",
  });
  // Kalshi's status=open market endpoint currently omits the row-level status
  // field. Retain the authoritative query status so Service A can recognize the
  // returned current window as open without weakening any other metadata gate.
  execFileSync(process.execPath, [path.resolve(artifactDir, "scripts/apply-kalshi-open-status-proof.mjs")], {
    stdio: "inherit",
  });
  // WS ticker messages omit market status. Preserve the authoritative REST
  // snapshot status so Service A does not turn a live market into "unknown".
  execFileSync(process.execPath, [path.resolve(artifactDir, "scripts/apply-kalshi-stream-status-backfill.mjs")], {
    stdio: "inherit",
  });
  // Consolidate Service A's live-exposure proof into reconciliation itself so a
  // just-proven clean ledger is not immediately re-read and spuriously blocked.
  execFileSync(process.execPath, [path.resolve(artifactDir, "scripts/apply-service-a-single-exposure-proof.mjs")], {
    stdio: "inherit",
  });
  // Temporary observability only: identify the exact fail-closed gate that
  // prevents Service A from entering a newly detected ETH window.
  execFileSync(process.execPath, [path.resolve(artifactDir, "scripts/apply-service-a-entry-gate-diagnostic.mjs")], {
    stdio: "inherit",
  });

  const commitSha = resolveCommitSha();
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    define: {
      "process.env.COMMIT_SHA": JSON.stringify(commitSha),
    },
    external: [
      "*.node", "sharp", "better-sqlite3", "sqlite3", "canvas", "bcrypt", "argon2",
      "fsevents", "re2", "farmhash", "xxhash-addon", "bufferutil", "utf-8-validate",
      "ssh2", "cpu-features", "dtrace-provider", "isolated-vm", "lightningcss", "pg-native",
      "oracledb", "mongodb-client-encryption", "nodemailer", "handlebars", "knex", "typeorm",
      "protobufjs", "onnxruntime-node", "@tensorflow/*", "@prisma/client", "@mikro-orm/*",
      "@grpc/*", "@swc/*", "@aws-sdk/*", "@azure/*", "@opentelemetry/*", "@google-cloud/*",
      "@google/*", "googleapis", "firebase-admin", "@parcel/watcher", "@sentry/profiling-node",
      "@tree-sitter/*", "aws-sdk", "classic-level", "dd-trace", "ffi-napi", "grpc", "hiredis",
      "kerberos", "leveldown", "miniflare", "mysql2", "newrelic", "odbc", "piscina", "realm",
      "ref-napi", "rocksdb", "sass-embedded", "sequelize", "serialport", "snappy", "tinypool",
      "usb", "workerd", "wrangler", "zeromq", "zeromq-prebuilt", "playwright", "puppeteer",
      "puppeteer-core", "electron",
    ],
    sourcemap: "linked",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';
globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);`,
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";
import { execSync } from "node:child_process";

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
  // Three-road router plus the regular-zero-fill Back Flip handoff. Every patch
  // uses exact source replacements and aborts if the expected production source
  // has drifted. The normal production esbuild remains the compile gate.
  const routerPatchScript = path.resolve(artifactDir, "../../scripts/apply_eth_three_road_router.py");
  execSync(`python3 "${routerPatchScript}"`, { stdio: "inherit" });
  const regularZeroFillArmPatch = path.resolve(artifactDir, "../../scripts/apply_regular_zero_fill_backflip_v2.py");
  execSync(`python3 "${regularZeroFillArmPatch}"`, { stdio: "inherit" });
  const verifiedRegularZeroFillArmPatch = path.resolve(artifactDir, "../../scripts/apply_regular_zero_fill_verified_backflip.py");
  execSync(`python3 "${verifiedRegularZeroFillArmPatch}"`, { stdio: "inherit" });
  const regularReconcileBeforeRouterPatch = path.resolve(artifactDir, "../../scripts/apply_regular_reconcile_before_router.py");
  execSync(`python3 "${regularReconcileBeforeRouterPatch}"`, { stdio: "inherit" });
  const durableThreeRoadOwnerPatch = path.resolve(artifactDir, "../../scripts/apply_eth_three_road_durable_owner.py");
  execSync(`python3 "${durableThreeRoadOwnerPatch}"`, { stdio: "inherit" });
  const oneShotBackFlipPatch = path.resolve(artifactDir, "../../scripts/apply_backflip_market_ioc_once.py");
  execSync(`python3 "${oneShotBackFlipPatch}"`, { stdio: "inherit" });
  const neutralLt50BackFlipPatch = path.resolve(artifactDir, "../../scripts/apply_backflip_lt50_neutral_martingale.py");
  execSync(`python3 "${neutralLt50BackFlipPatch}"`, { stdio: "inherit" });

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
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    plugins: [
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});

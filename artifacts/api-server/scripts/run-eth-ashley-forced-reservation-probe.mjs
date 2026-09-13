import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = "/tmp/eth-ashley-forced-reservation-probe";
const outfile = path.join(outdir, "probe.mjs");
await build({
  entryPoints: [path.join(root, "src/lib/strategies/ethAshleyForcedReservationProbe.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile,
  logLevel: "warning",
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);` },
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
});
const result = spawnSync(process.execPath, [outfile], { stdio: "inherit", cwd: root, env: process.env });
process.exit(result.status ?? 1);

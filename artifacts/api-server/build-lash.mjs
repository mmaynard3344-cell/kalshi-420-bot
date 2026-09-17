import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { rm } from "node:fs/promises";

globalThis.require = createRequire(import.meta.url);
const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(artifactDir, "dist-lash");
await rm(distDir, { recursive: true, force: true });
await esbuild({
  entryPoints: [path.resolve(artifactDir, "lash-shadow.mjs")],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile: path.resolve(distDir, "lash.mjs"),
  logLevel: "info",
  external: [
    "*.node", "pg-native", "fsevents", "bufferutil", "utf-8-validate",
    "better-sqlite3", "sqlite3", "canvas", "bcrypt", "argon2",
  ],
  banner: {
    js: `import { createRequire as __cr } from "node:module"; globalThis.require = __cr(import.meta.url);`,
  },
});

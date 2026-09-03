import { runCompactShadowWorker } from "./compactShadowWorker.js";
void runCompactShadowWorker().catch((error) => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
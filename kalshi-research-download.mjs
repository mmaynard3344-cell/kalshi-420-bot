#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

async function main() {
  await run(process.execPath, ["kalshi-research-runner.mjs"]);
  await run(process.execPath, ["kalshi-regime-analysis.mjs"]);
  await run(process.execPath, ["kalshi-daily-streak-analysis.mjs"]);
  await run(process.execPath, ["kalshi-portfolio-replay.mjs"]);
  await run(process.execPath, ["kalshi-g2-fresh-confirmation.mjs"]);
  await run(process.execPath, ["kalshi-g-deep-study.mjs"]);

  const archive = path.resolve("./kalshi-100day-research.tar.gz");
  if (fs.existsSync(archive)) fs.unlinkSync(archive);
  await run("tar", ["-czf", archive, "kalshi-100day-research"]);

  const stat = fs.statSync(archive);
  console.error(`Archive ready: ${archive} (${stat.size} bytes)`);

  const analysisPath = path.resolve("./kalshi-100day-research/regime-analysis.json");
  const replayPath = path.resolve("./kalshi-100day-research/portfolio-replay-100d.json");
  const replayCsvPath = path.resolve("./kalshi-100day-research/portfolio-replay-100d-daily.csv");
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === "/" || pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("kalshi research archive ready\nGET /kalshi-100day-research.tar.gz\nGET /regime-analysis.json\nGET /portfolio-replay-100d.json\nGET /portfolio-replay-100d-daily.csv\n");
      return;
    }
    if (pathname === "/regime-analysis.json" && fs.existsSync(analysisPath)) {
      const s = fs.statSync(analysisPath);
      res.writeHead(200, { "content-type": "application/json", "content-length": s.size, "cache-control": "no-store" });
      fs.createReadStream(analysisPath).pipe(res);
      return;
    }
    if (pathname === "/portfolio-replay-100d.json" && fs.existsSync(replayPath)) {
      const s = fs.statSync(replayPath);
      res.writeHead(200, { "content-type": "application/json", "content-length": s.size, "cache-control": "no-store" });
      fs.createReadStream(replayPath).pipe(res);
      return;
    }
    if (pathname === "/portfolio-replay-100d-daily.csv" && fs.existsSync(replayCsvPath)) {
      const s = fs.statSync(replayCsvPath);
      res.writeHead(200, { "content-type": "text/csv", "content-length": s.size, "cache-control": "no-store" });
      fs.createReadStream(replayCsvPath).pipe(res);
      return;
    }
    if (pathname === "/kalshi-100day-research.tar.gz") {
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": stat.size,
        "content-disposition": 'attachment; filename="kalshi-100day-research.tar.gz"',
        "cache-control": "no-store",
      });
      fs.createReadStream(archive).pipe(res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });

  server.listen(port, "0.0.0.0", () => {
    console.error(`Download server listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
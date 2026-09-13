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

  const archive = path.resolve("./kalshi-100day-research.tar.gz");
  if (fs.existsSync(archive)) fs.unlinkSync(archive);
  await run("tar", ["-czf", archive, "kalshi-100day-research"]);

  const stat = fs.statSync(archive);
  console.error(`Archive ready: ${archive} (${stat.size} bytes)`);

  const analysisPath = path.resolve("./kalshi-100day-research/regime-analysis.json");
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("kalshi research archive ready\nGET /kalshi-100day-research.tar.gz\nGET /regime-analysis.json\n");
      return;
    }
    if (req.url === "/regime-analysis.json" && fs.existsSync(analysisPath)) {
      const s = fs.statSync(analysisPath);
      res.writeHead(200, { "content-type": "application/json", "content-length": s.size, "cache-control": "no-store" });
      fs.createReadStream(analysisPath).pipe(res);
      return;
    }
    if (req.url === "/kalshi-100day-research.tar.gz") {
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

#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

function run(cmd, args) { return new Promise((resolve,reject)=>{ const p=spawn(cmd,args,{stdio:"inherit"}); p.on("error",reject); p.on("exit",c=>c===0?resolve():reject(new Error(`${cmd} exited ${c}`))); }); }
async function main(){
  await run(process.execPath,["kalshi-research-runner.mjs"]);
  await run(process.execPath,["kalshi-g-sizing-study.mjs"]);
  await run(process.execPath,["kalshi-g-walkforward.mjs"]);
  await run(process.execPath,["kalshi-g-deep-study.mjs"]);
  await run(process.execPath,["kalshi-g-combo-study.mjs"]);
  await run(process.execPath,["kalshi-g-stability-study.mjs"]);
  await run(process.execPath,["kalshi-g-weekday-validation.mjs"]);
  await run(process.execPath,["kalshi-regime-analysis.mjs"]);
  await run(process.execPath,["kalshi-daily-streak-analysis.mjs"]);
  await run(process.execPath,["kalshi-market-weather-study.mjs"]);
  await run(process.execPath,["kalshi-portfolio-replay.mjs"]);
  await run(process.execPath,["kalshi-g2-fresh-confirmation.mjs"]);
  const archive=path.resolve("./kalshi-100day-research.tar.gz"); if(fs.existsSync(archive))fs.unlinkSync(archive); await run("tar",["-czf",archive,"kalshi-100day-research"]); const stat=fs.statSync(archive);
  const files={"/regime-analysis.json":"regime-analysis.json","/market-weather-study.json":"market-weather-study.json","/portfolio-replay-100d.json":"portfolio-replay-100d.json","/portfolio-replay-100d-daily.csv":"portfolio-replay-100d-daily.csv"};
  const port=Number(process.env.PORT||3000); const server=http.createServer((req,res)=>{const pathname=new URL(req.url||"/","http://localhost").pathname;if(pathname==="/"||pathname==="/health"){res.writeHead(200,{"content-type":"text/plain"});res.end("kalshi research archive ready\nGET /market-weather-study.json\nGET /regime-analysis.json\nGET /kalshi-100day-research.tar.gz\n");return;} if(files[pathname]){const p=path.resolve("./kalshi-100day-research",files[pathname]);if(fs.existsSync(p)){const s=fs.statSync(p);res.writeHead(200,{"content-type":pathname.endsWith('.csv')?'text/csv':'application/json',"content-length":s.size,"cache-control":"no-store"});fs.createReadStream(p).pipe(res);return;}} if(pathname==="/kalshi-100day-research.tar.gz"){res.writeHead(200,{"content-type":"application/gzip","content-length":stat.size,"content-disposition":'attachment; filename="kalshi-100day-research.tar.gz"',"cache-control":"no-store"});fs.createReadStream(archive).pipe(res);return;}res.writeHead(404,{"content-type":"text/plain"});res.end("not found\n");}); server.listen(port,"0.0.0.0",()=>console.error(`Download server listening on port ${port}`));
}
main().catch(err=>{console.error(err?.stack||err);process.exit(1)});

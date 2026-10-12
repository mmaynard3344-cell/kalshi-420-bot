import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);

const dashboardData = JSON.parse(await readFile(join(__dirname, "dashboard-data.json"), "utf8"));

const portfolioData = JSON.parse(await readFile(join(__dirname, "portfolio-data.json"), "utf8"));

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "chandler-run-dashboard" }));
      return;
    }
    if (req.url === "/api/portfolio") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(portfolioData)); return;
    }
    if (["/app.js", "/styles.css", "/chandler-detail.html"].includes(req.url)) {
      const content = await readFile(join(__dirname, "public", req.url.slice(1)));
      const mime = req.url.endsWith(".js") ? "application/javascript" : req.url.endsWith(".css") ? "text/css" : "text/html";
      res.writeHead(200, { "content-type": mime + "; charset=utf-8", "cache-control": "no-cache" });
      res.end(content); return;
    }
    if (req.url === "/api/dashboard") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify(dashboardData));
      return;
    }
    if (req.url === "/report.pdf") {
      const pdf = await readFile(join(__dirname, "public", "Chandler_Run_Visual_CMA_2026-10-12.pdf"));
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Chandler_Run_Visual_CMA_2026-10-12.pdf"', "cache-control": "no-cache" });
      res.end(pdf); return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      const html = await readFile(join(__dirname, "public", "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Chandler Run dashboard listening on :${port}`);
});

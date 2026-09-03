import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Explicit CORS allowlist — never Access-Control-Allow-Origin: *.
// The browser client is served same-origin through the Replit proxy, so
// cross-origin access is only needed for the known app domains below.
const allowedOrigins = new Set<string>(
  [
    "https://kalshi-market-reader.replit.app",
    ...(process.env["REPLIT_DOMAINS"] ?? "")
      .split(",")
      .filter(Boolean)
      .map((d) => `https://${d.trim()}`),
    process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}` : "",
    "http://localhost:21010",
  ].filter(Boolean),
);
app.use(
  cors({
    origin(origin, callback) {
      // Same-origin / non-browser requests send no Origin header — allow them
      // (auth is enforced separately by the trade-token middleware).
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
      } else {
        callback(null, false); // no CORS headers → browser blocks the response
      }
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;

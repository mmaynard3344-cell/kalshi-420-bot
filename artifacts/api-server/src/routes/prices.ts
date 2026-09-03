import { Router } from "express";
import { logger } from "../lib/logger";
import { getKrakenPrices } from "../lib/krakenPrices";

const router = Router();

// Fetches live BTC and ETH prices from Binance public ticker API (no auth required)
router.get("/prices", async (_req, res) => {
  try {
    const { btc, eth, sol } = await getKrakenPrices();
    res.json({ btc, eth, sol, ts: Date.now() });
  } catch (err) {
    logger.warn({ err }, "Failed to fetch prices from Binance");
    res.status(502).json({ error: "Failed to fetch live prices" });
  }
});

export default router;

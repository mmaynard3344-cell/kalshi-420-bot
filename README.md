# Kalshi 100-Day Research Pull

This package contains a Node.js script that pulls the data needed for the ETH 15-minute research work:

- live + historical fills
- live + historical orders
- live + historical KXETH15M market records
- floor strikes / target history
- settlement outcomes
- historical cutoff metadata
- raw JSON plus normalized CSV
- optional ZIP packaging

## Run

Requires Node 18+.

```bash
export KALSHI_API_KEY_ID="YOUR_KEY_ID"
export KALSHI_PRIVATE_KEY_PATH="/path/to/key.pem"
node kalshi-pull-research-100d.mjs
```

Or provide the key directly:

```bash
KALSHI_API_KEY_ID="YOUR_KEY_ID" KALSHI_PRIVATE_KEY="$(cat /path/to/key.pem)" node kalshi-pull-research-100d.mjs
```

Defaults:

- 100 days
- series KXETH15M
- current documented API host
- output folder `./kalshi-100day-research`

Expected output:

```text
kalshi-100day-research/
  manifest.json
  historical-cutoff.json
  fills.csv
  orders.csv
  eth15m-markets.csv
  raw/
    fills-live.json
    fills-historical.json
    fills-merged.json
    orders-live.json
    orders-historical.json
    orders-merged.json
    eth15m-markets-live.json
    eth15m-markets-historical.json
    eth15m-markets-merged.json
```

If the `zip` command is installed, it also creates:

`kalshi-100day-research.zip`

Upload that ZIP back into ChatGPT for analysis.

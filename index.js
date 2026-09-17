const { createRequire } = require('module');
const req = createRequire(process.cwd() + '/lib/db/package.json');
const { Pool } = req('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const big = await client.query(`
      SELECT strategy, order_tag,
             count(*) AS rows,
             count(*) FILTER (WHERE settlement_result IN ('yes','no')) AS settled_rows,
             min(created_at_ms) AS first_created_at_ms,
             max(created_at_ms) AS last_created_at_ms
      FROM eth_big_bet_orders
      GROUP BY strategy, order_tag
      ORDER BY strategy, order_tag
    `);
    const mart = await client.query(`
      SELECT generation,
             count(*) AS rows,
             count(*) FILTER (WHERE settlement_result IN ('yes','no')) AS settled_rows,
             min(created_at_ms) AS first_created_at_ms,
             max(created_at_ms) AS last_created_at_ms
      FROM eth_martingale_orders
      GROUP BY generation
      ORDER BY generation
    `);
    console.log('BIGBET_IDENTIFIERS_JSON ' + JSON.stringify(big.rows));
    console.log('A_GENERATIONS_JSON ' + JSON.stringify(mart.rows));
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('IDENTIFIER_ERROR', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
  setInterval(() => {}, 1 << 30);
})();

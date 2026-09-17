const { createRequire } = require('module');
const req = createRequire(process.cwd() + '/lib/db/package.json');
const { Pool } = req('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const schema = await client.query(`
      SELECT table_name, column_name, data_type, is_nullable, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          table_name IN ('eth_martingale_orders','eth_big_bet_orders','order_attempts','order_fills','market_results','eth420_candidate_live_orders')
          OR table_name ILIKE '%order%'
          OR table_name ILIKE '%trade%'
          OR table_name ILIKE 'eth%'
          OR table_name ILIKE '%strategy%'
        )
      ORDER BY table_name, ordinal_position
    `);
    console.log('TABLES_JSON ' + JSON.stringify(tables.rows));
    console.log('SCHEMA_JSON ' + JSON.stringify(schema.rows));
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('SCHEMA_ERROR', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
  setInterval(() => {}, 1 << 30);
})();

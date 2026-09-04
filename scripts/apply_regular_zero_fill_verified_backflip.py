from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
trade_store_path = ROOT / "artifacts/api-server/src/lib/tradeStore.ts"
source = trade_store_path.read_text()

old_returning = '''        RETURNING o.requested_contracts, o.no_price_cents, o.reserved_fee_cents, o.eastern_date`);\n      const row = (result as unknown as { rows: Array<{\n        requested_contracts: number; no_price_cents: number; reserved_fee_cents: number; eastern_date: string;\n      }> }).rows[0];'''
new_returning = '''        RETURNING o.id, o.ticker, o.side, o.created_at_ms, o.outcome,\n                  o.requested_contracts, o.no_price_cents, o.reserved_fee_cents, o.eastern_date`);\n      const row = (result as unknown as { rows: Array<{\n        id: string; ticker: string; side: string; created_at_ms: number; outcome: string;\n        requested_contracts: number; no_price_cents: number; reserved_fee_cents: number; eastern_date: string;\n      }> }).rows[0];'''
if source.count(old_returning) != 1:
    raise SystemExit(f"verified-zero-fill RETURNING anchor count={source.count(old_returning)}")
source = source.replace(old_returning, new_returning)

old_tail = '''      }\n      return true;\n    });\n  } catch (err) {\n    _healthy = false; _lastErrorMsg = String(err); _degradedReason = `eth order update failed: ${_lastErrorMsg}`;'''
new_tail = '''      }\n\n      // A closed, independently verified Regular zero-fill is still a missed\n      // trading opportunity for Back Flip purposes. Preserve the ordinary\n      // martingale ladder exactly as before, but durably arm the one-window\n      // Back Flip in this same transaction. Never arm late if the target\n      // Regular window has already reserved an order, which prevents duplicate\n      // execution ownership.\n      if (params.outcome === "zero_fill_verified"\n        && Number(params.filledContracts ?? -1) === 0\n        && row.outcome === "zero_fill_verified"\n        && (row.side === "yes" || row.side === "no")) {\n        const sourceOpenTimeMs = Math.floor(Number(row.created_at_ms) / 900_000) * 900_000;\n        const targetOpenTimeMs = sourceOpenTimeMs + 900_000;\n        if (Number.isSafeInteger(sourceOpenTimeMs) && sourceOpenTimeMs > 0) {\n          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth-verified-zero-fill-backflip:" + targetOpenTimeMs}))`);\n          const targetRegular = await tx.execute(sql`\n            SELECT 1 FROM eth_martingale_orders\n            WHERE generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}\n              AND created_at_ms >= ${targetOpenTimeMs}\n              AND created_at_ms < ${targetOpenTimeMs + 900_000}\n            LIMIT 1`);\n          if ((targetRegular as unknown as { rows: unknown[] }).rows.length === 0) {\n            const sourceId = `regular:${String(row.id)}`;\n            await tx.execute(sql`INSERT INTO eth420_candidate_back_flip_overrides\n              (source_candidate_order_id, source_ticker, source_open_time_ms, missed_side,\n               target_open_time_ms, status, armed_at_ms)\n              VALUES (${sourceId}, ${String(row.ticker)}, ${sourceOpenTimeMs}, ${row.side},\n                ${targetOpenTimeMs}, 'armed', ${Date.now()})\n              ON CONFLICT (target_open_time_ms) DO NOTHING`);\n          }\n        }\n      }\n      return true;\n    });\n  } catch (err) {\n    _healthy = false; _lastErrorMsg = String(err); _degradedReason = `eth order update failed: ${_lastErrorMsg}`;'''
if source.count(old_tail) != 1:
    raise SystemExit(f"verified-zero-fill tail anchor count={source.count(old_tail)}")
source = source.replace(old_tail, new_tail)

trade_store_path.write_text(source)

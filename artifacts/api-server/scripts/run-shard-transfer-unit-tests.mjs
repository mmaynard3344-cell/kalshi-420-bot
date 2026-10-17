import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'shard-transfer-tests-'));
const tests = [
  'shardTransferDryRun.test.ts',
  'shardTransferRequestBoundary.test.ts',
  'shardTransferFreshBalance.test.ts',
  'shardTransferKalshiTransport.test.ts',
  'shardTransferPublicBoundary.test.ts',
  'shardTransferApiContract.test.ts',
  'shardTransferOperatorAuth.test.ts',
  'shardTransferSafety.test.ts',
  'shardTransferPayload.test.ts',
  'shardTransferGate.test.ts',
  'shardTransferIdempotency.test.ts',
  'shardTransferLedgerSql.test.ts',
  'shardTransferOrchestrator.test.ts',
];
try {
  const outputs = [];
  for (const test of tests) {
    const output = join(temp, test.replace(/\.ts$/, '.cjs'));
    await build({
      entryPoints: [join(root, 'src', 'lib', test)],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      logLevel: 'warning',
    });
    outputs.push(output);
  }
  // This suite uses pure helpers only: no database, network, or transfer calls.
  const result = spawnSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit', env: { ...process.env, SHARD_TRANSFERS_ENABLED: 'false' } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV !== 'test'
  || process.env.SHARD_TRANSFER_TEST_DATABASE !== '1'
  || process.env.SHARD_TRANSFER_DISPOSABLE_DB_CONFIRMED !== 'yes'
  || !/^postgres(?:ql)?:\/\/[^/]+@(?:127\.0\.0\.1|localhost):5432\/shard_transfer_test(?:\?.*)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Refusing transfer DB test: dedicated localhost disposable shard_transfer_test database required');
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outdir = join(root, 'node_modules', '.shard-transfer-db-tests');
try {
  await build({
    entryPoints: [join(root, 'src/lib/shardTransferLedgerRepository.test.ts'), join(root, 'src/lib/shardTransferSimulatedE2E.test.ts'), join(root, 'src/lib/shardTransferSubmissionAdapter.test.ts')],
    outdir, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    outExtension: { '.js': '.cjs' },

  });
  // Run suites sequentially: concurrent CREATE TABLE IF NOT EXISTS calls can
  // race while PostgreSQL creates its catalog type on a pristine test DB.
  for (const name of ['shardTransferLedgerRepository.test.cjs', 'shardTransferSimulatedE2E.test.cjs', 'shardTransferSubmissionAdapter.test.cjs']) {
    const result = spawnSync(process.execPath, ['--test', join(outdir, name)], { stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} finally {
  rmSync(outdir, {recursive:true,force:true});
}

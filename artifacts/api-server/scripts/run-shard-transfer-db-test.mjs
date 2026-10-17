import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV !== 'test'
  || process.env.SHARD_TRANSFER_TEST_DATABASE !== '1'
  || process.env.SHARD_TRANSFER_DISPOSABLE_DB_CONFIRMED !== 'yes'
  || !/^postgres(?:ql)?:\/\/[^/]+@(?:127\.0\.0\.1|localhost):5432\/shard_transfer_test(?:\?.*)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Refusing transfer DB test: dedicated localhost disposable shard_transfer_test database required');
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'shard-transfer-db-'));
try {
  const outfile = join(temp, 'integration-test.mjs');
  await build({
    entryPoints: [join(root, 'src/lib/shardTransferLedgerRepository.test.ts')],
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: ['pg', 'drizzle-orm', 'drizzle-orm/*', 'drizzle-zod', 'zod'],
  });
  const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, {recursive:true,force:true});
}

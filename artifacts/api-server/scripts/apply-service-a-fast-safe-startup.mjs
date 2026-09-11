import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/index.ts");
let source = await readFile(target, "utf8");

const before = `  await backfillCoverageIncidentsFromFiles();\n  await backfillCoverageWindowAuditsFromFiles();\n  // Wire the SQL write hook so future coverage incidents dual-write to SQL.\n  setCoverageIncidentSqlWriter(recordCoverageIncidentToSql);\n  // Permanent coverage audits are separate from short-retention incidents.\n  setCoverageAuditSqlWriter(recordCoverageWindowAuditToSql);\n  hydrateUnfinishedCoverageAudits(await loadUnfinishedCoverageWindowAuditsFromSql());\n  // One bounded pass seals any restored window that already closed while down.\n  runCoverageCheck();\n  const today = easternDay(new Date());`;

const after = `  await backfillCoverageIncidentsFromFiles();\n  // Coverage history is observability only and must never hold the live trader\n  // behind a long historical scan. Keep incident persistence wired now, then\n  // finish permanent coverage-audit backfill/hydration asynchronously after the\n  // execution-critical SQL/budget/dedup restoration path is allowed to continue.\n  setCoverageIncidentSqlWriter(recordCoverageIncidentToSql);\n  void (async () => {\n    try {\n      await backfillCoverageWindowAuditsFromFiles();\n      setCoverageAuditSqlWriter(recordCoverageWindowAuditToSql);\n      hydrateUnfinishedCoverageAudits(await loadUnfinishedCoverageWindowAuditsFromSql());\n      // One bounded pass seals any restored window that already closed while down.\n      runCoverageCheck();\n      logger.info(\"Coverage audit startup backfill/hydration completed in background\");\n    } catch (err) {\n      logger.warn({ err }, \"Coverage audit startup backfill/hydration failed in background\");\n    }\n  })();\n  const today = easternDay(new Date());`;

const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`Service A fast safe startup: expected one coverage-audit startup anchor, found ${count}`);
source = source.replace(before, after);

await writeFile(target, source, "utf8");
console.log("Service A fast safe startup applied: historical coverage-audit backfill no longer blocks trader startup");

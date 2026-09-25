import { pruneShadowEvaluationEvents, shadowEvaluationRetentionDays } from "../lib/shadowEvaluationTelemetry.js";
import { logger } from "../lib/logger.js";

const retentionDays = shadowEvaluationRetentionDays();

try {
  const prunedCount = await pruneShadowEvaluationEvents(retentionDays);
  logger.info({ retentionDays, prunedCount }, "Shadow evaluation retention maintenance complete");
} catch (err) {
  logger.error({ err, retentionDays }, "Shadow evaluation retention maintenance failed");
  process.exitCode = 1;
}

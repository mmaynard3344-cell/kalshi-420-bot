export function shadowEvaluatorStatus(nowMs, latest) {
  if (!latest) {
    return {
      status: "unknown",
      ageMs: null,
      evaluationIntervalMs: null,
      staleAfterMs: null,
    };
  }
  const interval = Number(latest.evaluationIntervalMs);
  if (!Number.isFinite(interval) || interval <= 0) {
    return {
      status: "stale",
      ageMs: Math.max(0, nowMs - Number(latest.evaluatedAtMs ?? 0)),
      evaluationIntervalMs: null,
      staleAfterMs: null,
    };
  }
  const ageMs = Math.max(0, nowMs - Number(latest.evaluatedAtMs ?? 0));
  const staleAfterMs = interval * 2;
  return {
    status: ageMs <= staleAfterMs ? "healthy" : "stale",
    ageMs,
    evaluationIntervalMs: interval,
    staleAfterMs,
  };
}

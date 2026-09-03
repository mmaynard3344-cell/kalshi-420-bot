import assert from "node:assert/strict";
import test from "node:test";
import {
  _resetRuntimeHeartbeatForTesting,
  _setRuntimeHeartbeatForTesting,
  isRuntimeEntryHealthy,
  RUNTIME_HEARTBEAT_STALE_MS,
} from "./runtimeHeartbeat.js";

const healthy = { runner: true, collector: true, watchdog: true, websocket: true, protectiveExit: true };

test("entry gate fails closed until a persisted healthy heartbeat exists", () => {
  _resetRuntimeHeartbeatForTesting();
  assert.equal(isRuntimeEntryHealthy(), false);
});

test("entry gate requires a fresh healthy collector heartbeat", () => {
  _resetRuntimeHeartbeatForTesting();
  _setRuntimeHeartbeatForTesting({ persistedAt: new Date().toISOString(), components: healthy });
  assert.equal(isRuntimeEntryHealthy(), true);

  _setRuntimeHeartbeatForTesting({
    persistedAt: new Date(Date.now() - RUNTIME_HEARTBEAT_STALE_MS - 1).toISOString(),
    components: healthy,
  });
  assert.equal(isRuntimeEntryHealthy(), false);

  _setRuntimeHeartbeatForTesting({
    persistedAt: new Date().toISOString(),
    components: { ...healthy, collector: false },
  });
  assert.equal(isRuntimeEntryHealthy(), false);
});
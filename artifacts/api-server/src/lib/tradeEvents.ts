import { EventEmitter } from "events";
import type { ProtectiveExitMonitorIncident } from "./tradeStore";

/**
 * Lightweight in-process event bus for trade-side events that need to be
 * forwarded to SSE clients without creating a circular import between
 * tradeStore (business logic) and routes/stream (HTTP layer).
 */
export const tradeEvents = new EventEmitter();

/** Emitted by tradeStore after a protective-exit monitor incident is recorded. */
export const PE_MONITOR_INCIDENT = "pe_monitor_incident";

export function emitPeMonitorIncident(incident: ProtectiveExitMonitorIncident): void {
  tradeEvents.emit(PE_MONITOR_INCIDENT, incident);
}

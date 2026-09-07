import { ensureEthMartingaleReservationStateFence } from "./lib/ethMartingaleReservationStateFence.js";

// The live runner must never start unless the database-level Regular reservation
// fence is installed successfully. This closes the settlement/read/reservation
// race before index.ts can open the production server or start AutoTrader.
await ensureEthMartingaleReservationStateFence();
await import("./index.js");

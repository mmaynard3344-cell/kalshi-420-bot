/**
 * tradingKillSwitch.ts
 *
 * Pure, dependency-free module holding the environment kill-switch logic and
 * the runtime halt flag. Kept separate from trade.ts so tests can import it
 * without dragging in Express, pino, or other CJS modules that break esbuild's
 * ESM bundler.
 *
 * Invariants:
 *  1. isEnvLocked() always takes priority over the runtime tradingHalted flag.
 *  2. isEnvLocked() = envTradingDisabled() || envWorkspaceHaltActive().
 *  3. Neither lock can be cleared by POST /trade/halt.
 *
 * Environment detection:
 *  - The production VM sets NODE_ENV=production in its artifact run config.
 *  - A dev workspace is always environment-locked; it is not a secondary
 *    trading runner even when a developer opens the browser.
 */

/**
 * Returns true when running in the Replit dev workspace.
 * The VM artifact run command explicitly sets NODE_ENV=production. Retaining
 * REPLIT_DEPLOYMENT also supports existing autoscale instances while a VM
 * publish is rolling out.
 */
export const isWorkspaceEnvironment = (): boolean =>
  process.env["NODE_ENV"] !== "production" && process.env["REPLIT_DEPLOYMENT"] !== "1";

/** True only for a published production process, never a dev workspace. */
export const isProductionRuntime = (): boolean =>
  !isWorkspaceEnvironment();

/**
 * Legacy compatibility only. The authoritative runner no longer starts in the
 * workspace, so this setting cannot create a second live trading process.
 */
export const workspaceTradingEnabled = (): boolean =>
  process.env["WORKSPACE_TRADING_ENABLED"] === "true";

/**
 * Returns true when the workspace-environment halt is active.
 * This remains an env-based lock that cannot be cleared by POST /trade/halt.
 * The owner-controlled workspace override is deliberately development-only;
 * production is never workspace-locked.
 */
export const envWorkspaceHaltActive = (): boolean =>
  isWorkspaceEnvironment();

/**
 * Returns true when either env-var kill switch is active.
 * Checked live on every call — no caching — so a mid-process env change
 * (e.g. via platform secrets hot-reload) takes effect immediately.
 */
export const envTradingDisabled = (): boolean =>
  process.env["AUTO_TRADING_ENABLED"] === "false" ||
  process.env["TRADING_ENABLED"]      === "false";

/**
 * Returns true when ANY environment-level lock is active.
 * Used for: environment_lock field in /trade/status, and blocking
 * POST /trade/halt {halted:false}.
 */
export const isEnvLocked = (): boolean =>
  envTradingDisabled() || envWorkspaceHaltActive();

// Runtime halt flag — flipped via POST /trade/halt.
// Environment locks are evaluated independently on every call. Keeping this
// flag runtime-only lets a narrowly scoped production exception distinguish an
// operator's emergency stop from a global environment setting.
let tradingHalted = false;

/**
 * Returns true when trading is halted — either by an environment lock
 * (workspace detection or explicit kill switch) or the runtime flag
 * set via POST /trade/halt.
 */
export function isTradingHalted(): boolean {
  return isEnvLocked() || tradingHalted;
}

/** Sets the runtime halt flag. For production use only via POST /trade/halt. */
export function setTradingHalted(v: boolean): void {
  tradingHalted = v;
}

/** For tests only — sets the runtime flag without touching env vars. */
export function _setTradingHaltedForTesting(v: boolean): void {
  tradingHalted = v;
}

const ETH_15M_TICKER  = /^KXETH15M-/;

export type DogeOrderSubmissionStatus = {
  doge_global_halt_exception_enabled: false;
  doge_strategy_enabled: false;
  doge_order_submission_permitted: boolean;
  doge_order_submission_reason:
    | "doge_new_entries_retired";
};

/**
 * DOGE's former entry exception is permanently retired. Retain this small
 * status API for dashboards and historical callers, but never permit a new
 * DOGE exchange order regardless of environment variables or runtime state.
 *
 * Protective exits do not call this function and remain available for
 * confirmed positions.
 */
export function getDogeOrderSubmissionStatus(_ticker: string): DogeOrderSubmissionStatus {
  return {
    doge_global_halt_exception_enabled: false,
    doge_strategy_enabled: false,
    doge_order_submission_permitted: false,
    doge_order_submission_reason: "doge_new_entries_retired",
  };
}

export function isDogeOrderSubmissionPermitted(ticker: string): boolean {
  return getDogeOrderSubmissionStatus(ticker).doge_order_submission_permitted;
}

export type EthOrderSubmissionStatus = {
  eth_strategy_enabled: boolean;
  eth_order_submission_permitted: boolean;
  eth_order_submission_reason:
    | "not_eth_15m"
    | "workspace_environment"
    | "eth_strategy_disabled"
    | "runtime_halt"
    | "permitted";
};

/**
 * Returns ETH's effective new-entry permission. Mirrors the DOGE pattern but
 * without a global-halt exception — ETH respects the full halt semantics.
 */
export function getEthOrderSubmissionStatus(ticker: string): EthOrderSubmissionStatus {
  const ethStrategyEnabled = process.env["ETH_NO_MARTINGALE_ENABLED"] === "true";
  const base = { eth_strategy_enabled: ethStrategyEnabled };

  if (!ETH_15M_TICKER.test(ticker)) {
    return { ...base, eth_order_submission_permitted: false, eth_order_submission_reason: "not_eth_15m" };
  }
  if (isWorkspaceEnvironment()) {
    return { ...base, eth_order_submission_permitted: false, eth_order_submission_reason: "workspace_environment" };
  }
  if (!ethStrategyEnabled) {
    return { ...base, eth_order_submission_permitted: false, eth_order_submission_reason: "eth_strategy_disabled" };
  }
  if (isTradingHalted()) {
    return { ...base, eth_order_submission_permitted: false, eth_order_submission_reason: "runtime_halt" };
  }
  return { ...base, eth_order_submission_permitted: true, eth_order_submission_reason: "permitted" };
}

export function isEthOrderSubmissionPermitted(ticker: string): boolean {
  return getEthOrderSubmissionStatus(ticker).eth_order_submission_permitted;
}

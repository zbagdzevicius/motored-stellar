/**
 * @motored-stellar/ramps
 *
 * SEPA on-ramp and off-ramp for EURC on Stellar behind the `RampProvider`
 * port, with a Bridge implementation and an in-memory implementation.
 * Pre-award; used by SCF deliverable D5.
 */

export * from "./amounts.js";
export * from "./errors.js";
export * from "./ports.js";
export * from "./quote.js";
export * from "./receiver.js";
export * from "./sepa.js";
export * from "./travel-rule.js";
export * from "./in-memory.js";
export {
  BRIDGE_PRODUCTION_BASE_URL,
  BRIDGE_SANDBOX_BASE_URL,
  type BridgeConfig,
  type BridgeEnvironment,
} from "./bridge/http.js";
export { BridgeRampProvider, type BridgeRampOptions } from "./bridge/provider.js";
export { BridgeSandbox, type SimulateDepositResult } from "./bridge/sandbox.js";

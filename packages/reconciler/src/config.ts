/**
 * Reconciler configuration and defaults.
 */
import { eur, type Units } from "./units.js";

/**
 * Trustless Work v1 fee account as hard-coded in the escrow Wasm the lab
 * inspected (`GBWWSOAT...KSZN`). Documented reference only: pass the fee
 * account of the Wasm you actually deploy against.
 *
 * Verified: the mainnet Wasm (96d51751...) hard-codes it (guard unit test m01); the testnet
 * Wasm (7c3f7b2a...) hard-codes none and takes `trustless_work_address` as an argument
 * (runs 4 to 7; run 6 landed the wrong-address refusal BadFeeAddr on chain).
 */
export const TW_V1_FEE_ACCOUNT_REFERENCE = "GBWWSOATPLIC72ZBOIM7WJCT7VCAHNWW4QUBZ2H4FORMCCIUM5ZVKSZN";

export interface ReconcilerConfig {
  /** The platform fee account set as `platform` on every escrow (G...). */
  platformAccount: string;
  /** The Trustless Work fee account the deployed escrow Wasm pays (G...). */
  trustlessWorkFeeAccount: string;
  /** Per-order cap; a checkout control, not enforced on chain. Default EUR 1,000. */
  perOrderCap: Units;
  /** Cap on total EURC held in open escrows. Default EUR 5,000. */
  openValueCap: Units;
  /** How long a submitted exit may be absent from chain before it counts as reverted. */
  pendingGraceMs: number;
  /** How long after a buyer-paying exit the refund top-up may still be outstanding. */
  topUpGraceMs: number;
}

/** Defaults for everything except the two accounts. */
export const DEFAULT_CONFIG = Object.freeze({
  perOrderCap: eur("1000"),
  openValueCap: eur("5000"),
  pendingGraceMs: 10 * 60 * 1000,
  topUpGraceMs: 60 * 60 * 1000,
});

/** Fill defaults. */
export function makeConfig(
  input: Pick<ReconcilerConfig, "platformAccount" | "trustlessWorkFeeAccount"> & Partial<ReconcilerConfig>,
): ReconcilerConfig {
  return { ...DEFAULT_CONFIG, ...input };
}

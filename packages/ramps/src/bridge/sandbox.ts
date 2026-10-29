/**
 * Bridge sandbox simulation endpoints (sandbox base URL only).
 *
 * The sandbox replaces compliance checks, bank activity and blockchain
 * transactions with simulated behaviour. It does NOT deliver testnet EURC:
 * no transaction is submitted to a blockchain. D5 is therefore verified in two
 * legs: the gateway API leg here (customer, KYC approval, virtual account and
 * liquidation address, simulated deposits and drains), and an on-chain leg on
 * Stellar testnet with the issuer's testnet EURC, run by the scripts in this
 * repository.
 *
 * Endpoints (documented in "Set up a sandbox environment"):
 *   POST /customers/{id}/simulate_kyc_approval
 *   POST /customers/{id}/virtual_accounts/{vaId}/simulate_deposit       { currency, amount }
 *   GET  /customers/{id}/virtual_accounts/{vaId}/history
 *   POST /customers/{id}/liquidation_addresses/{laId}/simulate_deposit  { currency, amount }
 *   GET  /customers/{id}/liquidation_addresses/{laId}/drains
 */

import { formatCents, formatUnits } from "../amounts.js";
import { RampError } from "../errors.js";
import type { BridgeRampProvider } from "./provider.js";
import { seg } from "./http.js";

export interface SimulateDepositResult {
  /** Present on a liquidation-address simulation: the created drain. */
  drainId?: string;
  success?: boolean;
  raw: unknown;
}

export class BridgeSandbox {
  readonly #provider: BridgeRampProvider;

  constructor(provider: BridgeRampProvider) {
    if (provider.endpoint.environment !== "sandbox") {
      throw new RampError("CONFIG_INVALID", "BridgeSandbox only runs against the sandbox environment");
    }
    this.#provider = provider;
  }

  /** Approves a sandbox customer's KYC/KYB and its pending endorsements. */
  async simulateKycApproval(customerId: string, idempotencyKey?: string): Promise<unknown> {
    return this.#provider.http.post(
      `/customers/${seg(customerId)}/simulate_kyc_approval`,
      undefined,
      idempotencyKey,
    );
  }

  /** Simulates a buyer's SEPA deposit into a EUR virtual account. */
  async simulateSepaDeposit(
    customerId: string,
    virtualAccountId: string,
    cents: bigint,
    idempotencyKey?: string,
  ): Promise<SimulateDepositResult> {
    // The documented example uses the VA's source currency ("usd" there); for a EUR VA it is "eur".
    const raw = await this.#provider.http.post<Record<string, unknown>>(
      `/customers/${seg(customerId)}/virtual_accounts/${seg(virtualAccountId)}/simulate_deposit`,
      { currency: "eur", amount: formatCents(cents) },
      idempotencyKey,
    );
    return { raw };
  }

  /** Simulates a seller's EURC deposit into a liquidation address. */
  async simulateEurcDeposit(
    customerId: string,
    liquidationAddressId: string,
    units: bigint,
    idempotencyKey?: string,
  ): Promise<SimulateDepositResult> {
    const raw = await this.#provider.http.post<{ success?: boolean; drain_id?: string }>(
      `/customers/${seg(customerId)}/liquidation_addresses/${seg(liquidationAddressId)}/simulate_deposit`,
      // TODO(verify, D5): amount precision the sandbox accepts for EURC (the documented example is "100.00").
      { currency: "eurc", amount: formatUnits(units) },
      idempotencyKey,
    );
    const out: SimulateDepositResult = { raw };
    if (raw?.success !== undefined) out.success = raw.success;
    if (raw?.drain_id !== undefined) out.drainId = raw.drain_id;
    return out;
  }

  /** Virtual account activity (deposits and their lifecycle events). */
  virtualAccountHistory(customerId: string, virtualAccountId: string): Promise<unknown> {
    return this.#provider.http.get(
      `/customers/${seg(customerId)}/virtual_accounts/${seg(virtualAccountId)}/history`,
    );
  }

  /** Drains (payouts) created from a liquidation address. */
  liquidationDrains(customerId: string, liquidationAddressId: string): Promise<unknown> {
    return this.#provider.http.get(
      `/customers/${seg(customerId)}/liquidation_addresses/${seg(liquidationAddressId)}/drains`,
    );
  }
}

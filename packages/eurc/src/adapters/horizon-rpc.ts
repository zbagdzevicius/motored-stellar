/**
 * Network adapters for the `Submitter` and `AccountReader` ports, backed by
 * Horizon (classic) and Soroban RPC (simulation and Soroban submission).
 *
 * Testnet-only in this release: the constructors refuse the public network.
 * Point `rpcUrl` at your own RPC node in production-like setups; the SDF
 * public endpoints are fine for demos.
 */
import {
  FeeBumpTransaction,
  Horizon,
  rpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import { assertTestnet, type NetworkConfig } from "../network.js";
import type {
  AccountReader,
  AccountSnapshot,
  BalanceLine,
  SimulationOutcome,
  SubmitOutcome,
  Submitter,
} from "../ports.js";
import { isSorobanTx } from "../feebump/inspect.js";

export interface HorizonRpcSubmitterOptions {
  /** How long to poll RPC for a Soroban result, in ms. Default 30 000. */
  pollTimeoutMs?: number;
  /** Poll interval in ms. Default 1 000. */
  pollIntervalMs?: number;
}

export class HorizonRpcSubmitter implements Submitter {
  readonly networkPassphrase: string;
  readonly horizon: Horizon.Server;
  readonly rpc: rpc.Server;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(network: NetworkConfig, opts: HorizonRpcSubmitterOptions = {}) {
    assertTestnet(network.passphrase);
    this.networkPassphrase = network.passphrase;
    this.horizon = new Horizon.Server(network.horizonUrl);
    this.rpc = new rpc.Server(network.rpcUrl);
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  }

  async simulate(tx: Transaction): Promise<SimulationOutcome> {
    const sim = await this.rpc.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error };
    return { ok: true, minResourceFee: sim.minResourceFee };
  }

  /** Simulate and assemble a Soroban tx (footprint, auth, resource fee). Sign afterwards. */
  async prepareSoroban(tx: Transaction): Promise<Transaction> {
    return this.rpc.prepareTransaction(tx);
  }

  async submit(tx: Transaction | FeeBumpTransaction): Promise<SubmitOutcome> {
    const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
    return isSorobanTx(inner) ? this.submitSoroban(tx) : this.submitClassic(tx);
  }

  private async submitClassic(tx: Transaction | FeeBumpTransaction): Promise<SubmitOutcome> {
    const hash = tx.hash().toString("hex");
    try {
      const r = await this.horizon.submitTransaction(tx);
      return { ok: true, hash: r.hash };
    } catch (e: unknown) {
      const codes = (e as { response?: { data?: { extras?: { result_codes?: unknown } } } })?.response?.data?.extras
        ?.result_codes;
      return { ok: false, hash, error: codes ? JSON.stringify(codes) : String(e) };
    }
  }

  private async submitSoroban(tx: Transaction | FeeBumpTransaction): Promise<SubmitOutcome> {
    const sent = await this.rpc.sendTransaction(tx);
    if (sent.status === "ERROR") {
      return { ok: false, hash: sent.hash, error: sent.errorResult?.result().switch().name ?? "ERROR" };
    }
    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      const got = await this.rpc.getTransaction(sent.hash);
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return { ok: true, hash: sent.hash };
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) return { ok: false, hash: sent.hash, error: "FAILED" };
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
    return { ok: false, hash: sent.hash, error: "TIMEOUT waiting for the transaction result" };
  }
}

/** Horizon-backed account reader. */
export class HorizonAccountReader implements AccountReader {
  readonly horizon: Horizon.Server;

  constructor(network: NetworkConfig) {
    this.horizon = new Horizon.Server(network.horizonUrl);
  }

  async loadAccount(accountId: string): Promise<AccountSnapshot | null> {
    let a: Horizon.AccountResponse;
    try {
      a = await this.horizon.loadAccount(accountId);
    } catch (e: unknown) {
      if ((e as { response?: { status?: number } })?.response?.status === 404) return null;
      throw e;
    }
    const balances: BalanceLine[] = a.balances.map((b) => {
      if (b.asset_type === "native") return { assetCode: "native", balance: b.balance };
      if (b.asset_type === "liquidity_pool_shares") return { assetCode: "pool", balance: b.balance };
      return {
        assetCode: b.asset_code,
        assetIssuer: b.asset_issuer,
        balance: b.balance,
        sponsor: b.sponsor,
        authorized: b.is_authorized,
      };
    });
    return { accountId: a.accountId(), sequence: a.sequenceNumber(), balances, sponsor: a.sponsor };
  }
}

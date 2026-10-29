/**
 * In-memory `RampProvider` for tests and the runnable example.
 *
 * It models the gateway's observable behaviour without any network:
 *   - customers start `not_started`, can be moved to `incomplete`, `approved`
 *     or `rejected`; virtual accounts and liquidation addresses need approval;
 *   - a SEPA deposit into a virtual account credits EURC (net of the fee
 *     schedule) to the destination wallet on an injected EURC ledger, which
 *     refuses accounts without a trustline, as Stellar does;
 *   - a liquidation address on Stellar is one shared omnibus G-address plus a
 *     per-address memo and a memoless muxed (M-) address; an EURC payment is
 *     routed only when it reaches the memoless address, or the omnibus
 *     address with the right memo, otherwise it is held unmatched;
 *   - a SEPA payout can be returned, which sends the EURC back to the
 *     liquidation address's return instructions.
 *
 * Addresses it generates are public keys of throwaway keypairs; no secret is
 * stored.
 */

import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { formatCents, formatUnits } from "./amounts.js";
import { RampError } from "./errors.js";
import type {
  CallOptions,
  Clock,
  CreateCustomerInput,
  CustomerType,
  ExternalAccount,
  KycLink,
  KycLinkInput,
  KycStatus,
  LiquidationAddress,
  OffRampInput,
  OnRampInput,
  RampCustomer,
  RampProvider,
  SepaBankAccountInput,
  Transfer,
  VirtualAccount,
} from "./ports.js";
import { isKycApproved, systemClock } from "./ports.js";
import { type FeeSchedule, quoteOffRamp, onRampNetUnits } from "./quote.js";
import { isPlainAccount } from "./receiver.js";
import { assertSepaReference } from "./sepa.js";
import { validateTravelRule } from "./travel-rule.js";

// ---------------------------------------------------------------------------
// EURC ledger port (what the ramp credits and debits on-chain)
// ---------------------------------------------------------------------------

/** The slice of an EURC ledger the in-memory ramp needs. */
export interface EurcLedger {
  hasTrustline(account: string): boolean;
  balance(account: string): bigint;
  credit(account: string, units: bigint): void;
  debit(account: string, units: bigint): void;
}

/** Minimal in-memory EURC ledger with trustlines, in base units. */
export class InMemoryEurcLedger implements EurcLedger {
  readonly #balances = new Map<string, bigint>();

  openTrustline(account: string): void {
    if (!this.#balances.has(account)) this.#balances.set(account, 0n);
  }
  hasTrustline(account: string): boolean {
    return this.#balances.has(account);
  }
  balance(account: string): bigint {
    return this.#balances.get(account) ?? 0n;
  }
  credit(account: string, units: bigint): void {
    if (units < 0n) throw new RangeError("negative credit");
    const cur = this.#balances.get(account);
    if (cur === undefined) throw new RampError("TRUSTLINE_MISSING", `no EURC trustline on ${account}`);
    this.#balances.set(account, cur + units);
  }
  debit(account: string, units: bigint): void {
    if (units < 0n) throw new RangeError("negative debit");
    const cur = this.#balances.get(account) ?? 0n;
    if (cur < units) throw new RampError("INVALID_STATE", `insufficient EURC on ${account}`);
    this.#balances.set(account, cur - units);
  }
}

// ---------------------------------------------------------------------------
// In-memory ramp
// ---------------------------------------------------------------------------

export interface InMemoryRampOptions {
  ledger: EurcLedger;
  /** Fee schedule applied to SEPA deposits into virtual accounts. */
  onRampFees?: FeeSchedule;
  /** Fee schedule applied to liquidation payouts. */
  offRampFees?: FeeSchedule;
  clock?: Clock;
}

interface CustomerRec {
  id: string;
  type: CustomerType;
  email: string;
  kycStatus: KycStatus;
}

interface LaRec extends LiquidationAddress {
  externalAccountId: string;
  returnTo: { address: string; memo: string };
  sepaReference?: string;
}

/** A SEPA payout produced by an off-ramp, as the seller's bank would see it. */
export interface SepaPayout {
  transferId: string;
  externalAccountId: string;
  cents: bigint;
  reference?: string;
}

/** Outcome of an EURC payment arriving at the gateway's Stellar account. */
export type OffRampReceipt =
  | { matched: true; transfer: Transfer; payout: SepaPayout }
  | { matched: false; reason: string };

const ZERO_FEES: FeeSchedule = { percentPpm: 0n, fixedCents: 0n };

export class InMemoryRamp implements RampProvider {
  /** The gateway's shared Stellar deposit account (omnibus). */
  readonly omnibusAddress: string;
  readonly payouts: SepaPayout[] = [];

  readonly #ledger: EurcLedger;
  readonly #onFees: FeeSchedule;
  readonly #offFees: FeeSchedule;
  readonly #clock: Clock;
  #seq = 0;
  readonly #customers = new Map<string, CustomerRec>();
  readonly #links = new Map<string, { id: string; customerId: string }>();
  readonly #externals = new Map<string, ExternalAccount>();
  readonly #vas = new Map<string, VirtualAccount>();
  readonly #las = new Map<string, LaRec>();
  readonly #transfers = new Map<string, Transfer & { laId?: string; units?: bigint }>();
  readonly #idem = new Map<string, unknown>();

  constructor(options: InMemoryRampOptions) {
    this.#ledger = options.ledger;
    this.#onFees = options.onRampFees ?? ZERO_FEES;
    this.#offFees = options.offRampFees ?? ZERO_FEES;
    this.#clock = options.clock ?? systemClock;
    this.omnibusAddress = Keypair.random().publicKey();
  }

  #id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${this.#seq.toString().padStart(6, "0")}`;
  }

  /** Replays the first result for a repeated idempotency key, like the real API. */
  #once<T>(opts: CallOptions | undefined, scope: string, make: () => T): T {
    if (!opts?.idempotencyKey) return make();
    const key = `${scope}:${opts.idempotencyKey}`;
    if (this.#idem.has(key)) return this.#idem.get(key) as T;
    const v = make();
    this.#idem.set(key, v);
    return v;
  }

  #requireCustomer(id: string): CustomerRec {
    const c = this.#customers.get(id);
    if (!c) throw new RampError("NOT_FOUND", `customer ${id}`);
    return c;
  }

  #requireApproved(id: string): CustomerRec {
    const c = this.#requireCustomer(id);
    if (!isKycApproved(c.kycStatus)) {
      throw new RampError("KYC_NOT_APPROVED", `customer ${id} is ${c.kycStatus}`);
    }
    return c;
  }

  // ---- RampProvider --------------------------------------------------------

  async createCustomer(input: CreateCustomerInput, opts?: CallOptions): Promise<RampCustomer> {
    return this.#once(opts, "customer", () => {
      const rec: CustomerRec = {
        id: this.#id("cust"),
        type: input.type,
        email: input.email,
        kycStatus: "not_started",
      };
      this.#customers.set(rec.id, rec);
      return { id: rec.id, type: rec.type, kycStatus: rec.kycStatus };
    });
  }

  async getCustomer(customerId: string): Promise<RampCustomer> {
    const c = this.#requireCustomer(customerId);
    return { id: c.id, type: c.type, kycStatus: c.kycStatus };
  }

  async kycLink(input: KycLinkInput, opts?: CallOptions): Promise<KycLink> {
    const linkId = this.#once(opts, "kyc_link", () => {
      const customer: CustomerRec = {
        id: this.#id("cust"),
        type: input.type,
        email: input.email,
        kycStatus: "not_started",
      };
      this.#customers.set(customer.id, customer);
      const id = this.#id("kyc_link");
      this.#links.set(id, { id, customerId: customer.id });
      return id;
    });
    return this.getKycLink(linkId);
  }

  async getKycLink(kycLinkId: string): Promise<KycLink> {
    const link = this.#links.get(kycLinkId);
    if (!link) throw new RampError("NOT_FOUND", `kyc link ${kycLinkId}`);
    const c = this.#requireCustomer(link.customerId);
    return {
      id: link.id,
      type: c.type,
      customerId: c.id,
      kycUrl: `https://kyc.invalid/${link.id}`,
      tosUrl: `https://tos.invalid/${link.id}`,
      kycStatus: c.kycStatus,
      tosStatus: isKycApproved(c.kycStatus) ? "approved" : "pending",
    };
  }

  async createExternalAccount(
    customerId: string,
    input: SepaBankAccountInput,
    opts?: CallOptions,
  ): Promise<ExternalAccount> {
    this.#requireCustomer(customerId);
    return this.#once(opts, "external_account", () => {
      const iban = input.iban.replace(/\s+/g, "");
      const ea: ExternalAccount = {
        id: this.#id("ea"),
        customerId,
        currency: "eur",
        last4: iban.slice(-4),
      };
      this.#externals.set(ea.id, ea);
      return ea;
    });
  }

  async createVirtualAccount(
    customerId: string,
    input: OnRampInput,
    opts?: CallOptions,
  ): Promise<VirtualAccount> {
    this.#requireApproved(customerId);
    if (!isPlainAccount(input.destinationAddress)) {
      throw new RampError("RECEIVER_NOT_PLAIN_ACCOUNT", "on-ramp destination must be a plain G-address");
    }
    if (!this.#ledger.hasTrustline(input.destinationAddress)) {
      throw new RampError("TRUSTLINE_MISSING", "create the EURC trustline before the virtual account");
    }
    if (input.travelRule) validateTravelRule(input.travelRule, this.#clock);
    return this.#once(opts, "virtual_account", () => {
      const n = this.#seq + 1;
      const va: VirtualAccount = {
        id: this.#id("va"),
        customerId,
        status: "activated",
        deposit: {
          // Not a real IBAN: an obviously fake, stable placeholder.
          iban: `XX00SANDBOX${n.toString().padStart(12, "0")}`,
          bic: "SANDBOXXXXX",
          accountHolderName: "In-memory ramp",
        },
        destination: { address: input.destinationAddress, currency: "eurc", rail: "stellar" },
      };
      if (input.destinationMemo) va.destination.memo = input.destinationMemo;
      this.#vas.set(va.id, va);
      return va;
    });
  }

  async createLiquidationAddress(
    customerId: string,
    input: OffRampInput,
    opts?: CallOptions,
  ): Promise<LiquidationAddress> {
    this.#requireApproved(customerId);
    const ea = this.#externals.get(input.externalAccountId);
    if (!ea || ea.customerId !== customerId) {
      throw new RampError("NOT_FOUND", `external account ${input.externalAccountId} for ${customerId}`);
    }
    if (!isPlainAccount(input.returnTo.address)) {
      throw new RampError("RECEIVER_NOT_PLAIN_ACCOUNT", "return address must be a plain G-address");
    }
    if (!input.returnTo.memo) throw new RampError("INVALID_STATE", "return memo is required on Stellar");
    if (input.sepaReference !== undefined) assertSepaReference(input.sepaReference);
    if (input.travelRule) validateTravelRule(input.travelRule, this.#clock);

    // A retried request with the same idempotency key replays the first result.
    const replayKey = opts?.idempotencyKey ? `liquidation_address:${opts.idempotencyKey}` : undefined;
    if (replayKey && this.#idem.has(replayKey)) return this.#idem.get(replayKey) as LiquidationAddress;
    // Documented: no duplicate liquidation address for the same chain, currency and destination.
    for (const la of this.#las.values()) {
      if (la.customerId === customerId && la.externalAccountId === input.externalAccountId) {
        throw new RampError("INVALID_STATE", "duplicate liquidation address for this destination");
      }
    }

    return this.#once(opts, "liquidation_address", () => {
      const id = this.#id("la");
      const memoId = (BigInt(this.#seq) + 1_000_000n).toString();
      const muxed = new MuxedAccount(new Account(this.omnibusAddress, "0"), memoId).accountId();
      const rec: LaRec = {
        id,
        customerId,
        address: this.omnibusAddress,
        memo: memoId,
        memolessAddress: muxed,
        state: "active",
        returnMemo: input.returnTo.memo,
        externalAccountId: input.externalAccountId,
        returnTo: { ...input.returnTo },
      };
      if (input.sepaReference !== undefined) rec.sepaReference = input.sepaReference;
      this.#las.set(id, rec);
      const { externalAccountId: _e, returnTo: _r, sepaReference: _s, ...pub } = rec;
      return pub;
    });
  }

  async getTransfer(transferId: string): Promise<Transfer> {
    const t = this.#transfers.get(transferId);
    if (!t) throw new RampError("NOT_FOUND", `transfer ${transferId}`);
    const { laId: _l, units: _u, ...pub } = t;
    return { ...pub };
  }

  // ---- Simulation controls (not part of the port) -------------------------

  /** Moves a customer through the hosted KYC/KYB flow. */
  setKycStatus(customerId: string, status: KycStatus): void {
    this.#requireCustomer(customerId).kycStatus = status;
  }

  /**
   * A buyer's SEPA transfer of `cents` arrives at a virtual account. EURC net
   * of the on-ramp fee schedule is credited to the destination wallet.
   */
  simulateSepaDeposit(virtualAccountId: string, cents: bigint): Transfer {
    const va = this.#vas.get(virtualAccountId);
    if (!va || va.status !== "activated") throw new RampError("NOT_FOUND", `virtual account ${virtualAccountId}`);
    if (cents <= 0n) throw new RangeError("deposit must be positive");
    const units = onRampNetUnits(cents, this.#onFees);
    this.#ledger.credit(va.destination.address, units);
    const now = this.#clock.now().toISOString();
    const t: Transfer = {
      id: this.#id("tr"),
      state: "payment_processed",
      amount: formatUnits(units),
      currency: "eurc",
      destinationTxHash: fakeTxHash(this.#seq),
      createdAt: now,
      updatedAt: now,
    };
    this.#transfers.set(t.id, t);
    return t;
  }

  /**
   * A classic EURC payment of `units` from `from` reaches the gateway. It is
   * routed to a liquidation address only by its memoless (M-) address, or by
   * the omnibus address plus the exact memo. Unrouted funds are held, mirroring
   * the documented risk of a missing memo.
   */
  receiveEurcPayment(payment: {
    from: string;
    to: string;
    units: bigint;
    memo?: string;
  }): OffRampReceipt {
    if (payment.units <= 0n) throw new RangeError("payment must be positive");
    let la: LaRec | undefined;
    for (const rec of this.#las.values()) {
      if (rec.state !== "active") continue;
      if (rec.memolessAddress === payment.to) {
        la = rec;
        break;
      }
      if (rec.address === payment.to && payment.memo !== undefined && rec.memo === payment.memo) {
        la = rec;
        break;
      }
    }
    // The payment leaves the sender's wallet either way.
    this.#ledger.debit(payment.from, payment.units);
    if (!la) {
      return { matched: false, reason: "no liquidation address matches destination and memo" };
    }
    const q = quoteOffRamp(payment.units, this.#offFees);
    const now = this.#clock.now().toISOString();
    const transfer: Transfer & { laId: string; units: bigint } = {
      id: this.#id("drain"),
      state: "payment_processed",
      amount: formatCents(q.netCents),
      currency: "eur",
      createdAt: now,
      updatedAt: now,
      laId: la.id,
      units: payment.units,
    };
    this.#transfers.set(transfer.id, transfer);
    const payout: SepaPayout = {
      transferId: transfer.id,
      externalAccountId: la.externalAccountId,
      cents: q.netCents,
    };
    if (la.sepaReference !== undefined) payout.reference = la.sepaReference;
    this.payouts.push(payout);
    const { laId: _l, units: _u, ...pub } = transfer;
    return { matched: true, transfer: { ...pub }, payout };
  }

  /**
   * The seller's bank returns a SEPA payout. The EURC that funded it goes back
   * to the liquidation address's return instructions.
   *
   * TODO(verify, D5): whether the gateway returns the full EURC amount or the
   * amount net of fees on a returned SEPA payout. Modelled as the full amount.
   */
  simulatePayoutReturn(transferId: string): { returnedTo: string; memo: string; units: bigint } {
    const t = this.#transfers.get(transferId);
    if (!t || !t.laId || t.units === undefined) throw new RampError("NOT_FOUND", `drain ${transferId}`);
    if (t.state !== "payment_processed") throw new RampError("INVALID_STATE", `drain is ${t.state}`);
    const la = this.#las.get(t.laId)!;
    this.#ledger.credit(la.returnTo.address, t.units);
    t.state = "returned";
    t.updatedAt = this.#clock.now().toISOString();
    return { returnedTo: la.returnTo.address, memo: la.returnTo.memo, units: t.units };
  }

  /** EURC that would be credited for a SEPA deposit of `cents`, for assertions. */
  previewOnRamp(cents: bigint): bigint {
    return onRampNetUnits(cents, this.#onFees);
  }
}

/** Deterministic 64-hex placeholder for a simulated on-chain hash. */
function fakeTxHash(n: number): string {
  return n.toString(16).padStart(64, "0");
}

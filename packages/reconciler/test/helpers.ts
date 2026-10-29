/**
 * Test world: one platform, one buyer, one seller, placeholder addresses.
 * The addresses are readable labels, not real Stellar keys; the in-memory
 * ports never validate them.
 */
import { makeConfig } from "../src/config.js";
import { InMemoryChainReader, InMemoryLedgerSource, InMemoryReportSink, ManualClock } from "../src/memory.js";
import type { EscrowChainState, ExpectedEscrow } from "../src/ports.js";
import { exitDistribution } from "../src/reconcile.js";
import { eur } from "../src/units.js";

export const PLATFORM = "G_PLATFORM_FEE_ACCOUNT";
export const TW_FEE = "G_TRUSTLESS_WORK_FEE_ACCOUNT";
export const BUYER = "G_BUYER";
export const SELLER = "G_SELLER";
export const THIRD = "G_SOMEONE_ELSE";
export const ESCROW = "C_ESCROW_1";
export const T0 = Date.parse("2026-11-02T00:00:00.000Z");
export const MIN = 60_000;

export const AMOUNT = eur("210");
export const BPS = 1180;

export function world() {
  const clock = new ManualClock(T0);
  const ledger = new InMemoryLedgerSource();
  const chain = new InMemoryChainReader();
  const sink = new InMemoryReportSink();
  const config = makeConfig({ platformAccount: PLATFORM, trustlessWorkFeeAccount: TW_FEE });
  return { clock, ledger, chain, sink, config, deps: { clock, ledger, chain, sink } };
}

export function expected(over: Partial<ExpectedEscrow> = {}): ExpectedEscrow {
  return {
    escrowId: ESCROW,
    orderRef: "order-ref-1",
    buyer: BUYER,
    seller: SELLER,
    amount: AMOUNT,
    platformFeeBps: BPS,
    status: "funded",
    exits: [],
    topUps: [],
    ...over,
  };
}

export function onChain(over: Partial<EscrowChainState> = {}): EscrowChainState {
  return {
    amount: AMOUNT,
    platformFeeBps: BPS,
    approver: BUYER,
    receiver: SELLER,
    platform: PLATFORM,
    flags: { disputed: false, released: false, resolved: false },
    milestoneApproved: false,
    ...over,
  };
}

/** Write the transfers an exit really produces into the in-memory chain. */
export function landExit(
  chain: InMemoryChainReader,
  e: ExpectedEscrow,
  exitIndex: number,
  closedAt: number,
): void {
  const exit = e.exits[exitIndex];
  if (!exit) throw new Error("no such exit");
  const d = exitDistribution(e, exit);
  const leg = (to: string, amount: bigint) => {
    if (amount > 0n) chain.transfer({ txHash: exit.txHash, closedAt, from: e.escrowId, to, amount });
  };
  leg(TW_FEE, d.trustlessWorkFee);
  leg(PLATFORM, d.platformFee);
  for (const r of d.recipients) leg(r.address, r.net);
}

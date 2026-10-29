// SPDX-License-Identifier: Apache-2.0
//
// The order scenarios, written as a marketplace backend would drive them through
// the ports. Each step names the on-chain call it stands for.
//
//   Scenario 1  buyer approves:  quote -> create -> precheck -> wallet funds ->
//               paid -> register -> carrier delivered -> claim anchored ->
//               buyer approves -> guarded release -> reconcile.
//   Scenario 2a silent buyer:    ... claim anchored -> buyer silent -> payout
//               refused while the claim is young (#10) -> platform dispute after
//               7 days -> guarded resolution to the seller with the claim.
//   Scenario 2b refund:          ... buyer disputes -> guarded resolution of the
//               whole balance to the buyer -> platform tops up both fees, so the
//               buyer gets 100% back -> reconcile.

import { randomBytes } from 'node:crypto';
import * as claims from '@motored-stellar/claims';
import * as escrow from '@motored-stellar/escrow';
import * as recon from '@motored-stellar/reconciler';
import { GuardAuthError, GuardError, GuardErrorCode, type Registration } from './guard-model.js';
import { WalletSigner, balanceOf, buildWorld, mintEurc, sha256Hex, syncEscrowState, type World } from './world.js';

export type Log = (line: string) => void;

/** Why the guard refused a call: its error code, or 'auth' when the signature is not from the pinned key. */
export type Refusal = GuardErrorCode | 'auth';

const DAY = 86_400;
const HOUR = 3_600;

/** A single-seller cart, in euro cents, priced the way the card rail prices it. */
export interface Cart {
  itemGrossCents: bigint[];
  shippingCents: bigint;
}

export const DEFAULT_CART: Cart = { itemGrossCents: [18_000n], shippingCents: 1_200n };

export interface PlacedOrder {
  order: escrow.EscrowOrder;
  contractId: string;
  quote: escrow.EscrowQuote;
  buyer: WalletSigner;
  seller: WalletSigner;
  registration: Registration;
}

export interface OrderOutcome {
  contractId: string;
  amount: bigint;
  cardNet: bigint;
  platformFeeBps: bigint;
  /** EURC the seller received from the escrow. */
  sellerReceived: bigint;
  /** EURC the buyer received back (escrow refund plus platform top-up). */
  buyerRefunded: bigint;
  /** Fees the platform account kept, net of any top-up it paid. */
  platformNet: bigint;
  trustlessWorkFee: bigint;
  claimVerified?: boolean;
  /** Guard refusals the scenario provoked on purpose: a guard error code, or 'auth' for a wrong key. */
  refusals: Refusal[];
}

export interface ScenarioResult {
  orders: OrderOutcome[];
  reconciliation: recon.RunResult;
  transactions: number;
}

const fmt = (u: bigint) => `${escrow.formatUnits(u)} EURC`;

/** Places an order on the EURC rail and walks it to "paid". */
export async function placeAndFund(w: World, log: Log, cart: Cart = DEFAULT_CART): Promise<PlacedOrder> {
  const buyer = new WalletSigner('buyer');
  const seller = new WalletSigner('seller');

  // OrderSource: the marketplace's order system supplies the order. The amount
  // and the card-rail seller net use the same fee schedule as the card rail.
  const amountCents = escrow.escrowAmountCents({ ...cart, referral: false });
  const draft: escrow.EscrowOrder = {
    orderRef: randomBytes(32).toString('hex'),
    buyer: buyer.publicKey(),
    seller: seller.publicKey(),
    amount: escrow.centsToUnits(amountCents),
    cardNet: escrow.centsToUnits(escrow.cardNetCents(cart.itemGrossCents)),
  };
  w.orders.add(draft);
  const order = await w.orders.getOrder(draft.orderRef);
  if (!order) throw new Error('order not found');

  // Fee rules: platform_fee_bps makes the seller net at least the card rail's payout.
  const quote = escrow.quoteEscrow(order);
  log(`  order ${order.orderRef.slice(0, 8)}: escrow ${fmt(order.amount)}, card net ${fmt(order.cardNet)}, platform_fee ${quote.platformFeeBps} bps`);

  // Trustless Work: deploy and initialise one single-release escrow, guard in both roles.
  const { contractId } = await w.lifecycle.create(order);
  log(`  escrow deployed ${contractId.slice(0, 10)}... (release_signer = dispute_resolver = guard)`);

  // Guard precheck by simulation before the buyer sees any funding call.
  w.guard.checkEscrow(await w.api.getEscrow(contractId));
  log('  guard.check_escrow passed: roles, platform pin, zero balance, milestone status set');

  w.ledger.put({
    escrowId: contractId,
    orderRef: order.orderRef,
    buyer: order.buyer,
    seller: order.seller,
    amount: order.amount,
    platformFeeBps: Number(quote.platformFeeBps),
    status: 'awaiting_funds',
    exits: [],
    topUps: [],
  });

  // The buyer's EURC arrives (in production: SEPA through the ramp, or the buyer's own wallet).
  mintEurc(w, buyer.publicKey(), order.amount);

  // WalletProvider: the buyer reviews the decoded transaction and signs fund_escrow.
  await w.lifecycle.fund(contractId, buyer);
  const funding = await w.lifecycle.funding(contractId);
  if (!funding.paid) throw new Error(`order not paid: ${funding.flags.join(', ')}`);
  ledgerUpdate(w, contractId, { status: 'funded' });
  log(`  buyer wallet signed fund_escrow (${buyer.reviewed.length} reviewed signature); order paid`);

  // Permissionless register_escrow: buyer, seller and amount frozen; funded_at recorded.
  const registration = w.guard.registerEscrow(await w.api.getEscrow(contractId));
  log(`  guard.register_escrow: funded_at=${registration.fundedAt}`);
  return { order, contractId, quote, buyer, seller, registration };
}

/** DeliveryOracle -> claim -> hourly batch -> registry.anchor. Returns the guard-ready claim. */
export async function deliverAndAnchor(w: World, p: PlacedOrder, log: Log): Promise<claims.Claim> {
  w.clock.advance(2 * DAY);
  w.oracle.push({
    escrow: p.contractId,
    orderRef: claims.fromHex(p.order.orderRef),
    parcelNumber: `PARCEL-${randomBytes(6).toString('hex')}`,
    carrierStatusText: 'Delivered to consignee',
    carrierDateTime: new Date(w.clock.now()).toISOString(),
    deliveredAt: w.clock.nowSeconds(),
  });
  await w.anchoring.ingest();
  w.clock.advance(HOUR);
  const batch = await w.anchoring.anchorBatch();
  if (!batch) throw new Error('nothing anchored');
  const c = await w.anchoring.claimFor(p.contractId);
  if (!c) throw new Error('no anchored claim for escrow');
  log(`  carrier delivered; claim anchored in batch ${batch.batchId} (depth ${batch.depth})`);
  return {
    orderRef: c.orderRef,
    parcelsCommit: c.parcelsCommit,
    carrierEventRef: c.carrierEventRef,
    deliveredAt: c.deliveredAt,
    batchId: c.batchId,
    proof: c.proof,
    index: c.index,
  };
}

/** Scenario 1: the buyer confirms receipt and the guard co-signs the release. */
export async function buyerApproves(w: World, log: Log, cart?: Cart): Promise<OrderOutcome> {
  const before = await snapshotFees(w);
  const p = await placeAndFund(w, log, cart);
  const claim = await deliverAndAnchor(w, p, log);

  await w.lifecycle.approve(p.contractId, p.buyer);
  w.guard.registerEscrow(await w.api.getEscrow(p.contractId));
  log('  buyer wallet signed approve_milestone');

  // Release service: __check_auth Release branch (release key), then release_funds.
  await w.guard.authorize(p.contractId, { fn: 'release_funds' }, { branch: 'Release', signer: w.keys.release });
  await w.lifecycle.release(p.contractId, w.keys.release);
  const txHash = w.api.lastTx;
  ledgerUpdate(w, p.contractId, {
    status: 'released',
    exit: { kind: 'release', txHash, submittedAt: w.clock.now(), toBuyer: 0n, toSeller: p.order.amount },
  });
  log(`  guarded release_funds landed ${txHash.slice(0, 12)}...`);

  // Anyone can re-check the claim against the registry afterwards.
  const recheck = await claims.recheckClaim(w.registry, p.contractId, claim);
  log(`  public claim re-check: ${recheck.ok ? 'ok' : recheck.problems.join('; ')}`);

  return outcome(w, p, before, [], recheck.onChainVerify);
}

/** Scenario 2a: the buyer stays silent; the seller is paid against the delivery claim after 7 days. */
export async function silentBuyer(w: World, log: Log, cart?: Cart): Promise<OrderOutcome> {
  const before = await snapshotFees(w);
  const p = await placeAndFund(w, log, cart);
  const claim = await deliverAndAnchor(w, p, log);
  const refusals: Refusal[] = [];
  const toSeller = (bal: bigint) => escrow.sellerResolution(bal, p.order.amount, p.order.seller, p.order.buyer);

  // Three days later the buyer has not approved. The claim is too young to pay the seller.
  w.clock.advance(3 * DAY);
  await w.lifecycle.openDispute(p.contractId, w.keys.platform);
  w.guard.registerEscrow(await w.api.getEscrow(p.contractId));
  const early = await w.api.getEscrow(p.contractId);
  refusals.push(
    await expectRefusal(log, 'seller payout with a 3-day-old claim', () =>
      w.guard.authorize(p.contractId, { fn: 'resolve_dispute', distributions: toSeller(early.balance) }, {
        branch: 'ResolveSeller',
        signer: w.keys.resolver,
        claim,
      }),
    ),
  );
  // Without a claim and without the buyer's approval there is no seller path at all.
  refusals.push(
    await expectRefusal(log, 'seller payout without a claim', () =>
      w.guard.authorize(p.contractId, { fn: 'resolve_dispute', distributions: toSeller(early.balance) }, {
        branch: 'Resolve',
        signer: w.keys.resolver,
      }),
    ),
  );
  // The release key cannot sign a resolution.
  refusals.push(
    await expectRefusal(log, 'resolution signed with the release key', () =>
      w.guard.authorize(p.contractId, { fn: 'resolve_dispute', distributions: toSeller(early.balance) }, {
        branch: 'ResolveSeller',
        signer: w.keys.release,
        claim,
      }),
    ),
  );

  // Seven days after the anchor: the claim pays the seller, never more than the escrow amount.
  w.clock.advance(4 * DAY + HOUR);
  const snap = await w.api.getEscrow(p.contractId);
  const distributions = toSeller(snap.balance);
  await w.guard.authorize(p.contractId, { fn: 'resolve_dispute', distributions }, { branch: 'ResolveSeller', signer: w.keys.resolver, claim });
  await w.lifecycle.resolveToSeller(p.contractId, w.keys.resolver);
  const txHash = w.api.lastTx;
  ledgerUpdate(w, p.contractId, {
    status: 'resolved',
    exit: { kind: 'resolution', txHash, submittedAt: w.clock.now(), ...gross(distributions, p.order) },
  });
  log(`  claim is 7 days old: guarded resolve_dispute to the seller landed ${txHash.slice(0, 12)}...`);

  const verified = await w.registry.verify(claim.batchId, claims.claimLeaf(p.contractId, claim), claim.proof, claim.index);
  return outcome(w, p, before, refusals, verified);
}

/** Scenario 2b: the buyer disputes before release; the escrow refunds and the platform tops up both fees. */
export async function refundWithTopUp(w: World, log: Log, cart?: Cart): Promise<OrderOutcome> {
  const before = await snapshotFees(w);
  const p = await placeAndFund(w, log, cart);
  const refusals: Refusal[] = [];

  w.clock.advance(DAY);
  await w.lifecycle.openDispute(p.contractId, p.buyer);
  w.guard.registerEscrow(await w.api.getEscrow(p.contractId));
  log('  buyer wallet signed dispute_escrow');

  const snap = await w.api.getEscrow(p.contractId);
  // A resolver cannot send the money anywhere else.
  refusals.push(
    await expectRefusal(log, 'resolution paying a third address', () =>
      w.guard.authorize(p.contractId, { fn: 'resolve_dispute', distributions: [[w.issuer, snap.balance]] }, {
        branch: 'Resolve',
        signer: w.keys.resolver,
      }),
    ),
  );

  const distributions: Array<[string, bigint]> = [[p.order.buyer, snap.balance]];
  await w.guard.authorize(p.contractId, { fn: 'resolve_dispute', distributions }, { branch: 'Resolve', signer: w.keys.resolver });
  const refund = await w.lifecycle.refund(p.contractId, w.keys.resolver);
  const exitTx = w.api.lastTx;
  log(`  guarded resolve_dispute to the buyer landed ${exitTx.slice(0, 12)}...: ${fmt(refund.paidFromEscrow)} from the escrow`);

  // Refund top-up from the platform fee account: exactly the two fees the resolution withheld.
  const topUpTx = sha256Hex(`topup/${exitTx}`);
  w.chain.transfer({ txHash: topUpTx, closedAt: w.clock.now(), from: w.keys.platform.publicKey(), to: p.order.buyer, amount: refund.topUp });
  ledgerUpdate(w, p.contractId, {
    status: 'resolved',
    exit: { kind: 'resolution', txHash: exitTx, submittedAt: w.clock.now(), toBuyer: snap.balance, toSeller: 0n },
    topUp: { exitTxHash: exitTx, txHash: topUpTx },
  });
  log(`  platform top-up ${fmt(refund.topUp)}: buyer receives ${fmt(refund.buyerReceives)} (100%)`);

  return outcome(w, p, before, refusals);
}

/** Runs the reconciler once over everything in the world's ledger. */
export async function reconcile(w: World, log: Log): Promise<recon.RunResult> {
  for (const e of await w.ledger.listEscrows(w.clock.now())) await syncEscrowState(w, e.escrowId);
  const r = await recon.runOnce({ ledger: w.ledger, chain: w.chain, clock: w.clock, sink: w.reports }, w.reconConfig);
  log(
    `  reconciliation: ${r.pass ? 'PASS' : 'FAIL'}; ${r.escrowsChecked} escrow(s), ${r.unexplainedCents} unexplained cents, ` +
      `${r.refundsComplete} complete refund(s)${r.failReasons.length ? `; ${r.failReasons.join(', ')}` : ''}`,
  );
  return r;
}

/** Scenario 1 in a fresh world. */
export async function runScenario1(log: Log = () => {}): Promise<ScenarioResult> {
  const w = buildWorld();
  log('Scenario 1: buyer approves, guarded release');
  const o = await buyerApproves(w, log);
  log('Scenario 1: reconcile');
  return { orders: [o], reconciliation: await reconcile(w, log), transactions: w.api.log.length };
}

/** Scenario 2 in a fresh world: a silent buyer and a refund, reconciled together. */
export async function runScenario2(log: Log = () => {}): Promise<ScenarioResult> {
  const w = buildWorld();
  log('Scenario 2a: silent buyer, seller paid against the delivery claim');
  const a = await silentBuyer(w, log);
  log('Scenario 2b: buyer disputes, refund with fee top-up');
  const b = await refundWithTopUp(w, log);
  log('Scenario 2: reconcile');
  return { orders: [a, b], reconciliation: await reconcile(w, log), transactions: w.api.log.length };
}

// ---------------------------------------------------------------------------

function ledgerUpdate(
  w: World,
  contractId: string,
  u: { status: recon.ExpectedStatus; exit?: recon.ExpectedExit; topUp?: recon.ExpectedTopUp },
): void {
  const e = w.ledger.escrows.get(contractId);
  if (!e) throw new Error(`ledger has no escrow ${contractId}`);
  e.status = u.status;
  if (u.exit) e.exits.push(u.exit);
  if (u.topUp) e.topUps.push(u.topUp);
}

function gross(d: ReadonlyArray<readonly [string, bigint]>, o: escrow.EscrowOrder): { toBuyer: bigint; toSeller: bigint } {
  let toBuyer = 0n;
  let toSeller = 0n;
  for (const [a, v] of d) {
    if (a === o.buyer) toBuyer += v;
    else if (a === o.seller) toSeller += v;
  }
  return { toBuyer, toSeller };
}

async function snapshotFees(w: World): Promise<{ platform: bigint; tw: bigint }> {
  return { platform: await balanceOf(w, w.keys.platform.publicKey()), tw: await balanceOf(w, w.trustlessWorkFee) };
}

async function outcome(
  w: World,
  p: PlacedOrder,
  before: { platform: bigint; tw: bigint },
  refusals: Refusal[],
  claimVerified?: boolean,
): Promise<OrderOutcome> {
  const buyerNow = await balanceOf(w, p.order.buyer);
  const result: OrderOutcome = {
    contractId: p.contractId,
    amount: p.order.amount,
    cardNet: p.order.cardNet,
    platformFeeBps: p.quote.platformFeeBps,
    sellerReceived: await balanceOf(w, p.order.seller),
    // The buyer was minted exactly the amount and spent it on funding.
    buyerRefunded: buyerNow,
    platformNet: (await balanceOf(w, w.keys.platform.publicKey())) - before.platform,
    trustlessWorkFee: (await balanceOf(w, w.trustlessWorkFee)) - before.tw,
    refusals,
  };
  if (claimVerified !== undefined) result.claimVerified = claimVerified;
  return result;
}

async function expectRefusal(log: Log, what: string, attempt: () => Promise<void>): Promise<Refusal> {
  try {
    await attempt();
  } catch (e) {
    if (e instanceof GuardError) {
      log(`  refused as expected: ${what} -> ${GuardErrorCode[e.code]} (#${e.code})`);
      return e.code;
    }
    if (e instanceof GuardAuthError) {
      log(`  refused as expected: ${what} -> auth error (not the pinned key)`);
      return 'auth';
    }
    throw e;
  }
  throw new Error(`guard accepted ${what}`);
}

// End-to-end order flow against in-memory ports (SCF D4, mock half).
// Asserts the money outcomes the design promises:
//   - the seller nets at least the card-rail payout (and at most 1 bp of the amount + 2 units more);
//   - a refund returns 100% to the buyer (escrow refund + platform top-up);
//   - the reconciler passes with zero unexplained cents;
//   - the delivery claim verifies against the registry.
import { describe, expect, it } from 'vitest';
import { GuardError, GuardErrorCode } from '../src/guard-model.js';
import { buyerApproves, placeAndFund, runScenario1, runScenario2 } from '../src/scenarios.js';
import { buildWorld } from '../src/world.js';

const quiet = () => {};
const BP = 10_000n;

describe('scenario 1: buyer approves, guarded release', () => {
  it('pays the seller at least the card net, verifies the claim and reconciles', async () => {
    const r = await runScenario1(quiet);
    const [o] = r.orders;
    expect(o).toBeDefined();
    if (!o) return;

    expect(o.sellerReceived).toBeGreaterThanOrEqual(o.cardNet);
    expect(o.sellerReceived - o.cardNet).toBeLessThanOrEqual(o.amount / BP + 2n);
    expect(o.buyerRefunded).toBe(0n);
    // Every unit of the escrow is accounted for: seller + platform + Trustless Work.
    expect(o.sellerReceived + o.platformNet + o.trustlessWorkFee).toBe(o.amount);
    expect(o.trustlessWorkFee).toBe((o.amount * 30n) / BP);
    expect(o.claimVerified).toBe(true);

    expect(r.reconciliation.pass).toBe(true);
    expect(r.reconciliation.unexplainedCents).toBe(0n);
    expect(r.reconciliation.findings).toEqual([]);
  });
});

describe('scenario 2: silent buyer and refund with top-up', () => {
  it('pays the seller against a 7-day-old claim and refunds the other buyer in full', async () => {
    const r = await runScenario2(quiet);
    const [silent, refund] = r.orders;
    expect(silent && refund).toBeTruthy();
    if (!silent || !refund) return;

    // 2a: refused while the claim is young (#10), without a claim (#8) and with the wrong key.
    expect(silent.refusals).toEqual([GuardErrorCode.TooEarly, GuardErrorCode.NoClaim, 'auth']);
    expect(silent.sellerReceived).toBeGreaterThanOrEqual(silent.cardNet);
    expect(silent.buyerRefunded).toBe(0n);
    expect(silent.claimVerified).toBe(true);

    // 2b: a third-address payout is refused (#9); the buyer gets 100% back.
    expect(refund.refusals).toEqual([GuardErrorCode.BadRecipient]);
    expect(refund.buyerRefunded).toBe(refund.amount);
    expect(refund.sellerReceived).toBe(0n);
    // The platform's net cost of a refund is Trustless Work's 0.3%.
    expect(refund.platformNet).toBe(-refund.trustlessWorkFee);

    expect(r.reconciliation.pass).toBe(true);
    expect(r.reconciliation.unexplainedCents).toBe(0n);
    expect(r.reconciliation.refundsComplete).toBe(1);
  });
});

describe('guard rules visible through the example', () => {
  it('refuses a seller resolution larger than the escrow amount (#28)', async () => {
    const w = buildWorld();
    const p = await placeAndFund(w, quiet);
    await expect(
      w.guard.authorize(p.contractId, { fn: 'resolve_dispute', distributions: [[p.order.seller, p.order.amount + 1n]] }, {
        branch: 'Resolve',
        signer: w.keys.resolver,
      }),
    ).rejects.toEqual(new GuardError(GuardErrorCode.SellerOverAmount));
  });

  it('lets break-glass pay only the buyer, and refuses a second exit after release', async () => {
    const w = buildWorld();
    const p = await placeAndFund(w, quiet);
    await expect(
      w.guard.authorize(p.contractId, { fn: 'resolve_dispute', distributions: [[p.order.seller, p.order.amount]] }, {
        branch: 'BreakGlass',
        signer: w.keys.breakGlass,
      }),
    ).rejects.toEqual(new GuardError(GuardErrorCode.NotWholeToBuyer));

    const w2 = buildWorld();
    const o = await buyerApproves(w2, quiet);
    await expect(
      w2.guard.authorize(o.contractId, { fn: 'release_funds' }, { branch: 'Release', signer: w2.keys.release }),
    ).rejects.toEqual(new GuardError(GuardErrorCode.Closed));
  });

  it('refuses a precheck once anyone has sent funds to the escrow (#24)', async () => {
    const w = buildWorld();
    const p = await placeAndFund(w, quiet);
    await expect(async () => w.guard.checkEscrow(await w.api.getEscrow(p.contractId))).rejects.toEqual(
      new GuardError(GuardErrorCode.NotEmpty),
    );
  });
});

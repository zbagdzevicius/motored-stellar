// Lifecycle rules over the in-memory Trustless Work v1 model: funding decisions,
// release, dispute -> refund with top-up, and cancellation only at balance 0.

import { describe, expect, it } from 'vitest';
import {
  centsToUnits,
  EscrowLifecycle,
  InMemoryEscrowApi,
  KeypairSigner,
  passthroughSignXdr,
  TwContractError,
  type EscrowOrder,
} from '../src/index.js';

const GUARD = 'CDJ5BNPZII6XPW4UCYYEF4LPOTJY7ZHPY3P6BVRYWZLED2RTFDJVGJ3F';
const TOKEN = 'CCBFC27MDMJW3N2RPGXWOIDIAN57IE5E4QFY7HCQSSPOBVOOCGOL563R';

function setup() {
  const twFee = KeypairSigner.random();
  const api = new InMemoryEscrowApi({ trustlessWorkFeeAddress: twFee.publicKey() });
  const platform = KeypairSigner.random();
  const buyer = KeypairSigner.random();
  const seller = KeypairSigner.random();
  const guardKey = KeypairSigner.random();
  const lc = new EscrowLifecycle(api, passthroughSignXdr, api, { platform, guardAddress: GUARD, tokenContractId: TOKEN });
  // EUR 100 item, EUR 4.99 shipping, EUR 5 buyer fee; card net EUR 95.
  const order: EscrowOrder = {
    orderRef: 'ab'.repeat(32),
    buyer: buyer.publicKey(),
    seller: seller.publicKey(),
    amount: centsToUnits(10999n),
    cardNet: centsToUnits(9500n),
  };
  return { api, lc, order, platform, buyer, seller, guardKey, twFee };
}

describe('EscrowLifecycle', () => {
  it('creates an escrow whose every field is final, with the guard in both roles', async () => {
    const { api, lc, order, platform } = setup();
    const { contractId, quote } = await lc.create(order);
    const snap = await api.getEscrow(contractId);
    expect(snap.roles).toEqual({
      approver: order.buyer,
      serviceProvider: order.seller,
      receiver: order.seller,
      platform: platform.publicKey(),
      releaseSigner: GUARD,
      disputeResolver: GUARD,
    });
    expect(snap.platformFeeBps).toBe(Number(quote.platformFeeBps));
    expect(snap.milestones.every((m) => m.status !== '' && !m.approved)).toBe(true);
    expect(snap.balance).toBe(0n);
  });

  it('happy path: buyer funds exactly, approves, release pays seller >= card net', async () => {
    const { api, lc, order, buyer, guardKey, platform } = setup();
    const { contractId, quote } = await lc.create(order);
    await lc.fund(contractId, buyer);
    expect((await lc.funding(contractId)).paid).toBe(true);
    await lc.approve(contractId, buyer);
    await lc.release(contractId, guardKey);
    expect(api.balances.get(order.seller)).toBe(quote.release.receiverAmount);
    expect(api.balances.get(order.seller)! >= order.cardNet).toBe(true);
    expect(api.balances.get(platform.publicKey())).toBe(quote.release.platformFee);
    expect((await api.getEscrow(contractId)).balance).toBe(0n);
  });

  it('partial funding never marks the order paid and release is impossible', async () => {
    const { lc, order, buyer, guardKey } = setup();
    const { contractId } = await lc.create(order);
    await lc.fund(contractId, buyer, order.amount * 4n / 10n);
    const f = await lc.funding(contractId);
    expect(f.paid).toBe(false);
    expect(f.flags).toContain('PARTIAL');
    await lc.approve(contractId, buyer);
    await expect(lc.release(contractId, guardKey)).rejects.toBeInstanceOf(TwContractError);
  });

  it('third-party funding of the full amount never marks the order paid', async () => {
    const { lc, order } = setup();
    const { contractId } = await lc.create(order);
    const stranger = KeypairSigner.random();
    await lc.fund(contractId, stranger, order.amount);
    const f = await lc.funding(contractId);
    expect(f).toMatchObject({ paid: false, buyerFunded: 0n, thirdPartyFunded: order.amount });
    expect(f.flags).toContain('THIRD_PARTY_FUNDING');
  });

  it('flags excess funding; release leaves the excess in the escrow', async () => {
    const { api, lc, order, buyer, guardKey } = setup();
    const { contractId } = await lc.create(order);
    await lc.fund(contractId, buyer);
    await lc.fund(contractId, buyer, order.amount); // double submit
    const f = await lc.funding(contractId);
    expect(f.paid).toBe(true);
    expect(f.excess).toBe(order.amount);
    expect(f.flags).toContain('EXCESS_BALANCE');
    await lc.approve(contractId, buyer);
    await lc.release(contractId, guardKey);
    expect((await api.getEscrow(contractId)).balance).toBe(order.amount);
  });

  it('flags a balance no fund_escrow call explains (plain transfer)', async () => {
    const { api, lc, order, buyer } = setup();
    const { contractId } = await lc.create(order);
    await lc.fund(contractId, buyer);
    api.transferIn(contractId, 1n);
    expect((await lc.funding(contractId)).flags).toEqual(['EXCESS_BALANCE', 'UNEXPLAINED_BALANCE']);
  });

  it('dispute -> refund: escrow pays the buyer net of fees and the top-up makes it 100%', async () => {
    const { api, lc, order, buyer, guardKey, platform } = setup();
    const { contractId, quote } = await lc.create(order);
    await lc.fund(contractId, buyer);
    const r = await lc.refund(contractId, guardKey);
    expect(r.buyer).toBe(order.buyer);
    expect(api.balances.get(order.buyer)).toBe(r.paidFromEscrow);
    expect(r.paidFromEscrow + r.topUp).toBe(order.amount);
    expect(r.topUp).toBe(quote.release.trustlessWorkFee + quote.release.platformFee);
    expect(api.balances.get(platform.publicKey())).toBe(quote.release.platformFee);
    const snap = await api.getEscrow(contractId);
    expect(snap.flags).toEqual({ disputed: false, released: false, resolved: true });
    expect(snap.balance).toBe(0n);
  });

  it('a partially funded escrow is unwound by refund', async () => {
    const { lc, order, buyer, guardKey } = setup();
    const { contractId } = await lc.create(order);
    const part = order.amount * 4n / 10n;
    await lc.fund(contractId, buyer, part);
    const r = await lc.refund(contractId, guardKey);
    expect(r.buyerReceives).toBe(part);
  });

  it('seller resolution caps the seller at the amount; excess goes to the buyer', async () => {
    const { api, lc, order, buyer, guardKey, platform } = setup();
    const { contractId } = await lc.create(order);
    await lc.fund(contractId, buyer);
    await lc.fund(contractId, buyer, order.amount);
    await lc.openDispute(contractId, platform);
    await lc.resolveToSeller(contractId, guardKey);
    const sellerGot = api.balances.get(order.seller)!;
    const buyerGot = api.balances.get(order.buyer)!;
    expect(sellerGot).toBe(buyerGot); // equal shares of 2x amount, equal fees
    expect((await api.getEscrow(contractId)).balance).toBe(0n);
  });

  it('cancels only while the balance is 0, and a cancelled escrow refuses the old funding call', async () => {
    const { api, lc, order, buyer } = setup();
    const { contractId } = await lc.create(order);
    const call = await lc.fundingCall(contractId, buyer.publicKey());
    expect(await lc.cancel(contractId)).toEqual({ cancelled: true });
    expect((await api.getEscrow(contractId)).title).toMatch(/^cancelled:/);
    await expect(api.sendTransaction(call.unsignedXdr)).rejects.toMatchObject({ code: 'EscrowPropertiesMismatch' });
  });

  it('refuses to cancel a funded escrow and says to refund the buyer', async () => {
    const { lc, order, buyer } = setup();
    const { contractId } = await lc.create(order);
    await lc.fund(contractId, buyer);
    const out = await lc.cancel(contractId);
    expect(out).toMatchObject({ cancelled: false, next: 'refund-buyer' });
  });

  it('dust only: cancellation turns into a dispute and a resolution of the dust to the buyer', async () => {
    const { api, lc, order } = setup();
    const { contractId } = await lc.create(order);
    api.transferIn(contractId, 1n);
    const out = await lc.cancel(contractId);
    expect(out).toMatchObject({ cancelled: false, next: 'dispute-and-resolve-dust-to-buyer' });
  });

  it('never hands a funding call for an escrow that already holds a balance', async () => {
    const { api, lc, order, buyer } = setup();
    const { contractId } = await lc.create(order);
    api.transferIn(contractId, 1n);
    await expect(lc.fundingCall(contractId, buyer.publicKey())).rejects.toMatchObject({ code: 'NOT_EMPTY' });
  });

  it('a dispute opened before funding invalidates a prepared funding call', async () => {
    const { api, lc, order, buyer, platform } = setup();
    const { contractId } = await lc.create(order);
    const call = await lc.fundingCall(contractId, buyer.publicKey());
    await lc.openDispute(contractId, platform);
    await expect(api.sendTransaction(call.unsignedXdr)).rejects.toMatchObject({ code: 'EscrowPropertiesMismatch' });
  });

  it('a funded escrow only accepts appended, unapproved milestones', async () => {
    const { api, lc, order, buyer, platform } = setup();
    const { contractId } = await lc.create(order);
    await lc.fund(contractId, buyer);
    const snap = await api.getEscrow(contractId);
    const { contractId: _c, balance: _b, ...escrow } = snap;
    const retitled = await api.updateEscrow({ contractId, signer: platform.publicKey(), escrow: { ...escrow, title: 'x' } });
    await expect(api.sendTransaction(retitled.unsignedXdr)).rejects.toMatchObject({ code: 'EscrowPropertiesMismatch' });
    const appended = await api.updateEscrow({
      contractId,
      signer: platform.publicKey(),
      escrow: { ...escrow, milestones: [...escrow.milestones, { description: 'extra', status: 'pending', evidence: '', approved: false }] },
    });
    await expect(api.sendTransaction(appended.unsignedXdr)).resolves.toMatchObject({ status: 'SUCCESS' });
  });
});

// Funding precheck (guard.check_escrow + get_escrow re-read) and the on-chain
// deployer call shape, over the in-memory RPC.

import { Keypair, Networks, scValToNative, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  deployerCall,
  escrowToScVal,
  InMemorySubmitter,
  precheckEscrow,
  simContractError,
  simOk,
  TW_TESTNET_WASM_HASH,
  type OnChainEscrow,
} from '../src/index.js';

const NET = Networks.TESTNET;
const ESCROW = 'CC3FOQA55L7ZJI6L3IDCSARERTLGJMWTEFQCQX7MTUUODTLESA3T2ZTK';
const GUARD = 'CDJ5BNPZII6XPW4UCYYEF4LPOTJY7ZHPY3P6BVRYWZLED2RTFDJVGJ3F';
const TOKEN = 'CCBFC27MDMJW3N2RPGXWOIDIAN57IE5E4QFY7HCQSSPOBVOOCGOL563R';
const DEPLOYER = 'CCPOJY5UG2ELCMP5FYG5GSOWMW6QJ47XUVPMEFGQOC4BDF7CAOSMK5KQ';

const buyer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();
const platform = Keypair.random().publicKey();
const source = Keypair.random().publicKey();

const escrow: OnChainEscrow = {
  engagementId: '0f1e2d3c',
  title: 'order',
  description: 'part',
  roles: { approver: buyer, serviceProvider: seller, receiver: seller, platform, releaseSigner: GUARD, disputeResolver: GUARD },
  amount: 1_099_900_000n,
  platformFeeBps: 1332,
  milestones: [{ description: 'part delivered', status: 'awaiting delivery', evidence: '', approved: false }],
  flags: { disputed: false, released: false, resolved: false },
  trustline: TOKEN,
  receiverMemo: 0,
};
const terms = { amount: escrow.amount, platformFeeBps: 1332, buyer, seller };

describe('precheckEscrow', () => {
  it('returns the funding call with expected_escrow when the guard and the terms agree', async () => {
    const rpc = new InMemorySubmitter().on(GUARD, 'check_escrow', () => simOk()).on(ESCROW, 'get_escrow', () => simOk(escrowToScVal(escrow)));
    const r = await precheckEscrow(rpc, { networkPassphrase: NET, sourcePublicKey: source, guardContractId: GUARD, escrowContractId: ESCROW, terms });
    if (!r.ok) throw new Error(`precheck failed at ${r.stage}`);
    expect(r.fundingCall.fn).toBe('fund_escrow');
    expect(r.fundingCall.contractId).toBe(ESCROW);
    const [signer, expected, amount] = r.fundingCall.args;
    expect(scValToNative(signer!)).toBe(buyer);
    expect(expected!.toXDR('base64')).toBe(escrowToScVal(escrow).toXDR('base64'));
    expect(scValToNative(amount!)).toBe(escrow.amount);
  });

  it('stops at the guard and names its error (BadPlatform = 22)', async () => {
    const rpc = new InMemorySubmitter().on(GUARD, 'check_escrow', () => simContractError(22));
    const r = await precheckEscrow(rpc, { networkPassphrase: NET, sourcePublicKey: source, guardContractId: GUARD, escrowContractId: ESCROW, terms });
    expect(r).toMatchObject({ ok: false, stage: 'guard', guardError: 'BadPlatform', contractErrorCode: 22 });
  });

  it('stops when the escrow does not match the order', async () => {
    const other = { ...escrow, amount: escrow.amount + 1n, roles: { ...escrow.roles, receiver: Keypair.random().publicKey() } };
    const rpc = new InMemorySubmitter().on(GUARD, 'check_escrow', () => simOk()).on(ESCROW, 'get_escrow', () => simOk(escrowToScVal(other)));
    const r = await precheckEscrow(rpc, { networkPassphrase: NET, sourcePublicKey: source, guardContractId: GUARD, escrowContractId: ESCROW, terms });
    expect(r).toEqual({ ok: false, stage: 'terms', mismatches: ['amount', 'roles.receiver'] });
  });
});

describe('deployerCall', () => {
  it('deploys and initializes in one call with the pinned Wasm hash', () => {
    const salt = Buffer.alloc(32, 9);
    const call = deployerCall({ deployerContractId: DEPLOYER, deployerAddress: platform, wasmHash: TW_TESTNET_WASM_HASH, salt, escrow });
    expect(call.fn).toBe('tw_new_single_release_escrow');
    expect(call.args).toHaveLength(6);
    expect(scValToNative(call.args[0]!)).toBe(platform);
    expect(Buffer.from(scValToNative(call.args[1]!) as Uint8Array).toString('hex')).toBe(TW_TESTNET_WASM_HASH);
    expect(scValToNative(call.args[3]!)).toBe('initialize_escrow');
    expect(xdr.expectUnionVariant(call.args[4]!, 'scvVec').vec![0]!.toXdr('base64')).toBe(escrowToScVal(escrow).toXdr('base64'));
    expect(xdr.expectUnionVariant(call.args[5]!, 'scvVec').vec).toHaveLength(0);
  });

  it('refuses an escrow with an empty milestone status', () => {
    const bad = { ...escrow, milestones: [{ ...escrow.milestones[0]!, status: '' }] };
    expect(() => deployerCall({ deployerContractId: DEPLOYER, deployerAddress: platform, wasmHash: TW_TESTNET_WASM_HASH, escrow: bad })).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

import { KeypairWallet, summarizeTransaction } from '../src/index.js';
import { ESCROW_ID, EURC_LIKE, sorobanTxFrom, sponsoredCreateTx } from './helpers.js';

describe('summarizeTransaction', () => {
  it('decodes a contract call into contract ID, function and JSON-safe arguments', () => {
    const user = Keypair.random().publicKey();
    const tx = sorobanTxFrom(user);
    const summary = summarizeTransaction(tx);

    expect(summary.source).toBe(user);
    expect(summary.hash).toBe(tx.hash().toString('hex'));
    expect(summary.operations).toEqual([
      { type: 'invokeHostFunction', contractId: ESCROW_ID, function: 'fund_escrow', args: [user, '100000000'] },
    ]);
    expect(() => JSON.stringify(summary)).not.toThrow();
  });

  it('lists operation sources, destinations and assets for a sponsored account creation', () => {
    const sponsor = Keypair.random().publicKey();
    const user = Keypair.random().publicKey();
    const { operations } = summarizeTransaction(sponsoredCreateTx(sponsor, user));

    expect(operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
    expect(operations[1]).toMatchObject({ destination: user, asset: 'XLM', amount: '0.0000000' });
    expect(operations[2]).toMatchObject({ source: user, asset: `EURC:${EURC_LIKE.getIssuer()}` });
  });

  it('gives the review hook the summary before signing', async () => {
    const seen: string[] = [];
    const wallet = KeypairWallet.random({
      beforeSign: (s) => {
        seen.push(`${s.operations[0]?.contractId}:${s.operations[0]?.function}`);
      },
    });
    await wallet.signTransaction(sorobanTxFrom(await wallet.getAddress()));
    expect(seen).toEqual([`${ESCROW_ID}:fund_escrow`]);
  });
});

describe('KeypairWallet', () => {
  it('never serialises its secret', () => {
    const wallet = KeypairWallet.random();
    const json = JSON.stringify(wallet);
    expect(json).not.toMatch(/S[A-Z2-7]{55}/);
    expect(JSON.parse(json)).toEqual({ kind: 'keypair', address: wallet.publicKey });
  });
});

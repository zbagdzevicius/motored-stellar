import { describe, expect, it } from 'vitest';
import { Keypair, Networks } from '@stellar/stellar-sdk';

import { WalletsKitProvider, authorizeEntryWithWallet, buildAuthEntryPreimage } from '../src/index.js';
import { NET, entryFor, sorobanTxFrom } from './helpers.js';
import { MockKit } from './mock-kit.js';

function setup(options: { enableAuthEntries?: boolean } = {}) {
  const key = Keypair.random();
  const kit = new MockKit(key);
  const wallet = new WalletsKitProvider({ kit, networkPassphrase: NET, ...options });
  return { key, kit, wallet };
}

describe('WalletsKitProvider', () => {
  it('passes the envelope XDR, network passphrase and connected address to kit.signTransaction', async () => {
    const { key, kit, wallet } = setup();
    await wallet.signTransaction(sorobanTxFrom(key.publicKey()));

    expect(kit.calls).toEqual([
      { method: 'signTransaction', opts: { networkPassphrase: NET, address: key.publicKey() } },
    ]);
  });

  it('rejects a signature from a different account than the connected one', async () => {
    const { key, kit, wallet } = setup();
    kit.misbehaviour = 'other-signer';
    await expect(wallet.signTransaction(sorobanTxFrom(key.publicKey()))).rejects.toMatchObject({
      code: 'SIGNER_MISMATCH',
    });
  });

  it('rejects an envelope whose signature does not verify for the connected account', async () => {
    const { key, kit, wallet } = setup();
    kit.misbehaviour = 'lying-signer';
    await expect(wallet.signTransaction(sorobanTxFrom(key.publicKey()))).rejects.toMatchObject({
      code: 'BAD_SIGNATURE',
    });

    kit.misbehaviour = 'no-signature';
    await expect(wallet.signTransaction(sorobanTxFrom(key.publicKey()))).rejects.toMatchObject({
      code: 'BAD_SIGNATURE',
    });
  });

  it('rejects a transaction the wallet changed before signing', async () => {
    const { key, kit, wallet } = setup();
    kit.misbehaviour = 'tamper';
    await expect(wallet.signTransaction(sorobanTxFrom(key.publicKey()))).rejects.toMatchObject({
      code: 'TX_TAMPERED',
    });
  });

  it('refuses to sign while the connected wallet is on another network', async () => {
    const { key, kit, wallet } = setup();
    kit.network = Networks.PUBLIC;
    await expect(wallet.signTransaction(sorobanTxFrom(key.publicKey()))).rejects.toMatchObject({
      code: 'NETWORK_MISMATCH',
    });
    expect(kit.calls).toHaveLength(0);
  });

  it('runs the review hook first and does not call the wallet when it declines', async () => {
    const key = Keypair.random();
    const kit = new MockKit(key);
    const seen: string[] = [];
    const wallet = new WalletsKitProvider({
      kit,
      beforeSign: (summary) => {
        seen.push(summary.operations[0]?.function ?? '');
        return false;
      },
    });

    await expect(wallet.signTransaction(sorobanTxFrom(key.publicKey()))).rejects.toMatchObject({
      code: 'REJECTED_BY_USER',
    });
    expect(seen).toEqual(['fund_escrow']);
    expect(kit.calls).toHaveLength(0);
  });

  it('keeps auth-entry signing off unless enabled', async () => {
    const { key, wallet } = setup();
    expect(wallet.capabilities.authEntries).toBe(false);
    const preimage = buildAuthEntryPreimage(await entryFor(key.publicKey()), NET);
    await expect(wallet.signAuthEntry(preimage)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('signs auth entries when enabled and rejects a signature from another key', async () => {
    const { key, kit, wallet } = setup({ enableAuthEntries: true });
    const entry = await authorizeEntryWithWallet(await entryFor(key.publicKey()), wallet, 4_000);
    expect(entry.credentials().address().signatureExpirationLedger()).toBe(4_000);

    kit.misbehaviour = 'lying-signer';
    await expect(wallet.signAuthEntry(buildAuthEntryPreimage(entry, NET))).rejects.toMatchObject({
      code: 'BAD_SIGNATURE',
    });
  });
});

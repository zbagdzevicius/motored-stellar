/**
 * Behaviour every WalletProvider must have. Each adapter test file calls
 * `describeWalletProviderContract` with a factory for its adapter.
 */
import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';
import { Keypair, Networks, StrKey } from '@stellar/stellar-sdk';

import {
  type WalletProvider,
  WalletError,
  authEntryPayload,
  authorizeEntryWithWallet,
  buildAuthEntryPreimage,
  hasValidSignatureFrom,
} from '../src/index.js';
import { NET, entryFor, sorobanTxFrom } from './helpers.js';

export interface ProviderUnderTest {
  wallet: WalletProvider;
}

export function describeWalletProviderContract(name: string, make: () => Promise<ProviderUnderTest> | ProviderUnderTest): void {
  describe(`WalletProvider contract: ${name}`, () => {
    it('reports a valid Stellar account address on the configured network', async () => {
      const { wallet } = await make();
      expect(StrKey.isValidEd25519PublicKey(await wallet.getAddress())).toBe(true);
      expect(wallet.networkPassphrase).toBe(NET);
    });

    it('returns a signed copy whose signature verifies over the tx hash', async () => {
      const { wallet } = await make();
      const address = await wallet.getAddress();
      const tx = sorobanTxFrom(address);

      const signed = await wallet.signTransaction(tx);

      expect(signed).not.toBe(tx);
      expect(tx.signatures).toHaveLength(0);
      expect(signed.hash().equals(tx.hash())).toBe(true);
      expect(hasValidSignatureFrom(signed, address)).toBe(true);
    });

    it('refuses a transaction built for another network', async () => {
      const { wallet } = await make();
      const tx = sorobanTxFrom(await wallet.getAddress(), Networks.PUBLIC);
      await expect(wallet.signTransaction(tx)).rejects.toMatchObject({ code: 'NETWORK_MISMATCH' });
    });

    it('signs auth entries when it says it can, and refuses with UNSUPPORTED otherwise', async () => {
      const { wallet } = await make();
      const address = await wallet.getAddress();
      const seed = await entryFor(address);

      if (!wallet.capabilities.authEntries) {
        await expect(wallet.signAuthEntry(buildAuthEntryPreimage(seed, NET))).rejects.toMatchObject({
          code: 'UNSUPPORTED',
        });
        return;
      }

      const entry = await authorizeEntryWithWallet(seed, wallet, 9_000);
      const payload = authEntryPayload(buildAuthEntryPreimage(entry, NET));
      const sig = await wallet.signAuthEntry(buildAuthEntryPreimage(entry, NET));
      expect(Keypair.fromPublicKey(address).verify(Buffer.from(payload), Buffer.from(sig))).toBe(true);
    });

    it('fails with a WalletError, never a silent bad signature', async () => {
      const { wallet } = await make();
      const tx = sorobanTxFrom(Keypair.random().publicKey(), Networks.FUTURENET);
      const err = await wallet.signTransaction(tx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WalletError);
    });
  });
}

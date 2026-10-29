/**
 * Runs the shared WalletProvider contract against every adapter, each wired to
 * an in-memory or mocked backend (no network, no Privy or kit packages).
 */
import { Keypair } from '@stellar/stellar-sdk';

import {
  EmbeddedWalletService,
  InMemoryPrivyClient,
  KeypairWallet,
  PrivyWalletProvider,
  RawHashWallet,
  WalletsKitProvider,
} from '../src/index.js';
import { NET, naclRawSign } from './helpers.js';
import { MockKit } from './mock-kit.js';
import { describeWalletProviderContract } from './provider-contract.js';

describeWalletProviderContract('KeypairWallet', () => ({ wallet: KeypairWallet.random() }));

describeWalletProviderContract('RawHashWallet (tweetnacl signer)', () => {
  const kp = Keypair.random();
  return {
    wallet: new RawHashWallet({ address: kp.publicKey(), signRawHash: async ({ hash }) => naclRawSign(kp, hash) }),
  };
});

describeWalletProviderContract('PrivyWalletProvider (in-memory Privy)', async () => {
  const privy = new InMemoryPrivyClient();
  const service = new EmbeddedWalletService({ client: privy, isEligible: () => true });
  const created = await service.createForUser({ privyUserId: 'did:privy:test-buyer', role: 'buyer' });
  return {
    wallet: new PrivyWalletProvider({
      address: created.address,
      signRawHash: privy.signRawHashFor('did:privy:test-buyer'),
      networkPassphrase: NET,
    }),
  };
});

describeWalletProviderContract('WalletsKitProvider (mock kit, tx signing only)', () => ({
  wallet: new WalletsKitProvider({ kit: new MockKit(Keypair.random()) }),
}));

describeWalletProviderContract('WalletsKitProvider (mock kit, auth entries enabled)', () => ({
  wallet: new WalletsKitProvider({ kit: new MockKit(Keypair.random()), enableAuthEntries: true }),
}));

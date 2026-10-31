/**
 * @motored-stellar/wallets
 *
 * Wallet connector layer for the EURC escrow flow (pre-award; used by SCF #46 deliverable D2):
 * a `WalletProvider` port, a Privy embedded-wallet adapter (raw-hash signing),
 * a Stellar Wallets Kit adapter and a local `KeypairWallet` for tests.
 */
export { WalletError, type WalletErrorCode } from './errors.js';
export type { WalletCapabilities, WalletKind, WalletProvider } from './types.js';

export {
  type AuthEntrySigner,
  type Hex0x,
  attachRawSignature,
  authEntryPayload,
  authorizeEntryWithWallet,
  buildAuthEntryPreimage,
  bytesToHex0x,
  cloneTransaction,
  decoratedSignatureFromRaw,
  hasValidSignatureFrom,
  hexToBytes,
  transactionHashHex,
  verifyRawSignature,
} from './raw-signature.js';

export {
  type BeforeSignHook,
  type OperationSummary,
  type TransactionSummary,
  runBeforeSign,
  summarizeTransaction,
} from './review.js';

export { KeypairWallet, type KeypairWalletOptions } from './keypair-wallet.js';
export { RawHashWallet, type RawHashSigner, type RawHashWalletOptions } from './raw-hash-wallet.js';

export {
  type CreatePrivyWalletInput,
  type EligibilityDecision,
  EmbeddedWalletService,
  type EmbeddedWalletServiceOptions,
  InMemoryPrivyClient,
  type PrivyClient,
  PrivyRestClient,
  type PrivyRestConfig,
  type PrivySignRawHash,
  type PrivyWallet,
  PrivyWalletProvider,
  type PrivyWalletProviderOptions,
  type WalletEligibility,
  type WalletRole,
  type WalletSubject,
} from './privy.js';

export { WalletsKitProvider, type WalletsKitLike, type WalletsKitProviderOptions } from './wallets-kit.js';

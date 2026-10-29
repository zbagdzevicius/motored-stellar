/**
 * Error type shared by every wallet adapter in this package.
 *
 * Callers branch on `code`, never on the message text.
 */
export type WalletErrorCode =
  /** The caller-supplied eligibility predicate refused to create a wallet. */
  | 'NOT_ELIGIBLE'
  /** A signature did not verify against the expected public key and payload. */
  | 'BAD_SIGNATURE'
  /** The wallet signed with a different account than the one requested. */
  | 'SIGNER_MISMATCH'
  /** The wallet returned a transaction whose hash differs from the one it was asked to sign. */
  | 'TX_TAMPERED'
  /** The transaction was built for a different network than the wallet is configured for. */
  | 'NETWORK_MISMATCH'
  /** The review hook (the pre-sign confirmation screen) declined the transaction. */
  | 'REJECTED_BY_USER'
  /** The wallet cannot perform the requested operation (for example auth-entry signing). */
  | 'UNSUPPORTED'
  /** The upstream wallet service returned an error or an unexpected response. */
  | 'PROVIDER_ERROR';

export class WalletError extends Error {
  readonly code: WalletErrorCode;

  constructor(code: WalletErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WalletError';
    this.code = code;
  }
}

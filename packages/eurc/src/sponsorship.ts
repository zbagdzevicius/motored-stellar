/**
 * CAP-33 sponsored reserves: account creation and trustlines paid for by a
 * sponsor account, so a new user can hold EURC with 0 XLM.
 *
 * Every builder here produces the "sandwich" the protocol requires:
 *
 *   BeginSponsoringFutureReserves(sponsoredId = user)   source: sponsor
 *   ...operations whose reserves the sponsor pays...    source: user (or sponsor for createAccount)
 *   EndSponsoringFutureReserves()                       source: user
 *
 * Both the sponsor and the user must sign: the sponsor because it is the
 * transaction source and the Begin source, the user because it is the source
 * of the ChangeTrust and End operations. Testnet evidence (wallets lab):
 *   - E1  sponsored createAccount(0) + 2 trustlines, user at 0 XLM: `8dccb9ab...` (success)
 *   - E1b same without the user's signature: op_bad_auth on End
 *   - E1c createAccount(0) without sponsorship: op_low_reserve
 *   - E4c sponsored ChangeTrust for an existing 1-XLM account: `02c62e1c...` (success)
 *   - E3  the sponsor gains no signing power over the user's account: payment
 *         from the user's account signed only by the sponsor fails op_bad_auth
 *
 * Reserve budget: 1 XLM base reserve for a sponsored account plus 0.5 XLM per
 * sponsored trustline; it stays locked on the sponsor while the entries exist.
 */
import {
  BASE_FEE,
  Operation,
  TransactionBuilder,
  type Account,
  type Asset,
  type Transaction,
} from "@stellar/stellar-sdk";

export interface SponsoredTxOptions {
  networkPassphrase: string;
  /** Per-operation inclusion fee in stroops. Defaults to BASE_FEE. */
  fee?: string;
  /** Seconds until the transaction expires. Defaults to 120. */
  timeoutSeconds?: number;
}

/** Stroops of reserve locked on the sponsor per sponsored entry. */
export const BASE_RESERVE_STROOPS = 5_000_000n; // 0.5 XLM
/** Reserve locked by `buildSponsoredAccountTx` (account counts as 2 base reserves). */
export function sponsoredReserveStroops(trustlines: number): bigint {
  return 2n * BASE_RESERVE_STROOPS + BigInt(trustlines) * BASE_RESERVE_STROOPS;
}

/**
 * Create `userPublicKey` with a 0 XLM starting balance and open trustlines to
 * `assets`, all reserves paid by the sponsor. `sponsorAccount` is the sponsor's
 * loaded account (it is the transaction source and pays the fee).
 *
 * Sign with the sponsor AND the user before submitting.
 */
export function buildSponsoredAccountTx(
  sponsorAccount: Account,
  userPublicKey: string,
  assets: readonly Asset[],
  opts: SponsoredTxOptions,
): Transaction {
  const b = new TransactionBuilder(sponsorAccount, {
    fee: opts.fee ?? BASE_FEE,
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: userPublicKey }))
    .addOperation(Operation.createAccount({ destination: userPublicKey, startingBalance: "0" }));
  for (const asset of assets) {
    b.addOperation(Operation.changeTrust({ asset, source: userPublicKey }));
  }
  return b
    .addOperation(Operation.endSponsoringFutureReserves({ source: userPublicKey }))
    .setTimeout(opts.timeoutSeconds ?? 120)
    .build();
}

/**
 * Open (or re-open) a sponsored trustline on an account that already exists,
 * for example an external wallet that holds only its own base reserve, or a
 * user who removed their trustline. Source is the sponsor, so no fee-bump is
 * needed.
 *
 * Sign with the sponsor AND the user before submitting.
 */
export function buildSponsoredTrustlineTx(
  sponsorAccount: Account,
  userPublicKey: string,
  asset: Asset,
  opts: SponsoredTxOptions,
): Transaction {
  return new TransactionBuilder(sponsorAccount, {
    fee: opts.fee ?? BASE_FEE,
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: userPublicKey }))
    .addOperation(Operation.changeTrust({ asset, source: userPublicKey }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: userPublicKey }))
    .setTimeout(opts.timeoutSeconds ?? 120)
    .build();
}

/**
 * The same sponsored trustline with the user's account as transaction source
 * (the shape a wallet builds and then asks the sponsor to fee-bump). The
 * Begin operation names the sponsor as its source, so the sponsor signs the
 * inner transaction as well as the fee-bump. The fee-bump policy accepts
 * exactly this shape for the configured EURC asset.
 */
export function buildUserSourcedSponsoredTrustlineTx(
  userAccount: Account,
  sponsorPublicKey: string,
  asset: Asset,
  opts: SponsoredTxOptions,
): Transaction {
  const user = userAccount.accountId();
  return new TransactionBuilder(userAccount, {
    fee: opts.fee ?? BASE_FEE,
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: user, source: sponsorPublicKey }))
    .addOperation(Operation.changeTrust({ asset }))
    .addOperation(Operation.endSponsoringFutureReserves({}))
    .setTimeout(opts.timeoutSeconds ?? 120)
    .build();
}

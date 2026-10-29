/**
 * Offline fixtures: transactions and auth entries built locally, never sent.
 * All keys are generated per test run with Keypair.random().
 */
import { Buffer } from 'buffer';
import nacl from 'tweetnacl';
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  authorizeInvocation,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';

export const NET = Networks.TESTNET;

/** A deterministic, obviously fake contract ID used as an escrow address in fixtures. */
export const ESCROW_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
/** A placeholder classic asset issuer for fixtures. */
export const EURC_LIKE = new Asset('EURC', Keypair.random().publicKey());

/**
 * Privy-style raw signer, ported from the SCF wallet lab (`privyRawSign`):
 * Ed25519 over the 32-byte hash with an independent library (tweetnacl),
 * returned as `0x` hex. Lets tests check the raw path against stellar-sdk's own.
 */
export function naclRawSign(secret: Keypair, hashHex: string): string {
  const kp = nacl.sign.keyPair.fromSeed(secret.rawSecretKey());
  const sig = nacl.sign.detached(Buffer.from(hashHex.slice(2), 'hex'), kp.secretKey);
  return `0x${Buffer.from(sig).toString('hex')}`;
}

/** A Soroban call where `user` is the transaction source (the `fund_escrow` shape). */
export function sorobanTxFrom(user: string, passphrase: string = NET): Transaction {
  return new TransactionBuilder(new Account(user, '100'), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(
      new Contract(ESCROW_ID).call(
        'fund_escrow',
        new Address(user).toScVal(),
        nativeToScVal(10_0000000n, { type: 'i128' }),
      ),
    )
    .setTimeout(300)
    .build();
}

/** Lab experiment E1 shape: sponsor is the tx source, user is an operation source. */
export function sponsoredCreateTx(sponsor: string, user: string): Transaction {
  return new TransactionBuilder(new Account(sponsor, '7'), { fee: '1000', networkPassphrase: NET })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: user }))
    .addOperation(Operation.createAccount({ destination: user, startingBalance: '0' }))
    .addOperation(Operation.changeTrust({ asset: EURC_LIKE, source: user }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: user }))
    .setTimeout(120)
    .build();
}

export function sampleInvocation(): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(ESCROW_ID).toScAddress(),
        functionName: 'approve_milestone',
        args: [nativeToScVal(0, { type: 'u32' })],
      }),
    ),
    subInvocations: [],
  });
}

/**
 * An address-credential auth entry for `address` over `sampleInvocation()`.
 * Built by authorizing with a throwaway key, then re-pointing the credential
 * at `address`; the stale signature is replaced by whoever signs it next.
 */
export async function entryFor(address: string): Promise<xdr.SorobanAuthorizationEntry> {
  const entry = await authorizeInvocation({
    signer: Keypair.random(),
    validUntilLedgerSeq: 1_000,
    invocation: sampleInvocation(),
    networkPassphrase: NET,
    // Legacy SOROBAN_CREDENTIALS_ADDRESS, the form simulation returns today and
    // the one the guard and wallets sign; stellar-sdk 17 defaults to V2 (CAP-71).
    authV2: false,
  });
  // XDR values are immutable since stellar-sdk 17: rebuild with the new address.
  const creds = xdr.expectUnionVariant(entry.credentials, 'sorobanCredentialsAddress').address;
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: creds.nonce,
        signatureExpirationLedger: creds.signatureExpirationLedger,
        signature: creds.signature,
      }),
    ),
    rootInvocation: entry.rootInvocation,
  });
}

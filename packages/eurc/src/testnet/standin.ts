/**
 * Testnet stand-in for EURC.
 *
 * Testnet EURC is distributed by Circle's faucet, which a CI job or a reviewer
 * may not be able to use. For demos we issue XEUR from an issuer key generated
 * at runtime and deploy its SAC. XEUR exercises exactly the same code paths
 * (classic trustline, sponsored reserves, SAC transfers into contracts), so a
 * flow proven with XEUR differs from EURC only in the issuer address.
 *
 * The lab ran this flow with assets it called TEUR and LEUR (testnet SAC
 * deploy `fb71617c...`, issue `533a68e7...`).
 */
import {
  Asset,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  type Account,
  type Transaction,
} from "@stellar/stellar-sdk";
import { assertTestnet, type NetworkConfig } from "../network.js";
import { sacContractId, standinAsset } from "../asset.js";

/** Fund a testnet account with friendbot. */
export async function friendbot(network: NetworkConfig, publicKey: string): Promise<void> {
  assertTestnet(network.passphrase);
  if (!network.friendbotUrl) throw new Error(`${network.name} has no friendbot`);
  const r = await fetch(`${network.friendbotUrl}?addr=${encodeURIComponent(publicKey)}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export interface StandIn {
  readonly asset: Asset;
  /** C... id of the stand-in's SAC on this network. */
  readonly sacId: string;
}

/** The XEUR stand-in for `issuerPublicKey`, with its SAC id. */
export function describeStandIn(issuerPublicKey: string, networkPassphrase: string): StandIn {
  const asset = standinAsset(issuerPublicKey);
  return { asset, sacId: sacContractId(asset, networkPassphrase) };
}

/** Issuer pays `amount` of `asset` to `destination` (which needs a trustline). */
export function buildIssueTx(
  issuerAccount: Account,
  destination: string,
  asset: Asset,
  amount: string,
  networkPassphrase: string,
): Transaction {
  return new TransactionBuilder(issuerAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.payment({ destination, asset, amount }))
    .setTimeout(120)
    .build();
}

/**
 * Deploy the SAC for `asset`. Anyone may deploy a classic asset's SAC; the
 * payer here is the sponsor. The returned tx must go through RPC
 * `prepareTransaction` before signing.
 */
export function buildDeploySacTx(payerAccount: Account, asset: Asset, networkPassphrase: string): Transaction {
  return new TransactionBuilder(payerAccount, { fee: "100000", networkPassphrase })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(120)
    .build();
}

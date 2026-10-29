// SPDX-License-Identifier: Apache-2.0
//
// Network configuration. This package targets Stellar testnet. Mainnet values
// appear only in MAINNET_REFERENCE, as documentation of what the guard pins on
// mainnet; nothing in this repository deploys to mainnet.

import { Asset, Networks } from '@stellar/stellar-sdk';

/**
 * The two deployed Trustless Work v1 single-release lineages differ in one
 * argument: the testnet Wasm takes the Trustless Work fee address as argument 1
 * of `release_funds`, `resolve_dispute` and `withdraw_remaining_funds`; the
 * mainnet Wasm hardcodes the fee account and has no such argument.
 */
export type TwLineage =
  | { kind: 'fee-address-argument'; trustlessWorkFeeAddress: string }
  | { kind: 'hardcoded-fee-account' };

export interface NetworkConfig {
  name: 'testnet' | 'local';
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl?: string;
  friendbotUrl?: string;
  /** Trustless Work REST base URL for this network. */
  trustlessWorkApiBase: string;
  /** Hex SHA-256 of the Trustless Work v1 single-release Wasm the guard pins. */
  twWasmHash: string;
}

/** Trustless Work v1 single-release Wasm deployed on testnet (fee address passed as an argument). */
export const TW_TESTNET_WASM_HASH = '7c3f7b2af92ad86092708b23babf80f9e1308d7f3ce18b703b9499192ecc934b';

export const TESTNET: Readonly<NetworkConfig> = Object.freeze({
  name: 'testnet',
  networkPassphrase: Networks.TESTNET,
  rpcUrl: 'https://soroban-testnet.stellar.org',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  friendbotUrl: 'https://friendbot.stellar.org',
  trustlessWorkApiBase: 'https://dev.api.trustlesswork.com',
  twWasmHash: TW_TESTNET_WASM_HASH,
});

/** Circle's testnet EURC issuer. */
export const TESTNET_EURC_ISSUER = 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO';

/** The EURC classic asset on a network. */
export function eurcAsset(issuer: string = TESTNET_EURC_ISSUER): Asset {
  return new Asset('EURC', issuer);
}

/** Stellar Asset Contract ID (C...) of an asset on a network. */
export function sacContractId(asset: Asset, networkPassphrase: string = Networks.TESTNET): string {
  return asset.contractId(networkPassphrase);
}

/**
 * Documentation only. Never used as a deploy or submit target by this package.
 */
export const MAINNET_REFERENCE = Object.freeze({
  trustlessWorkApiBase: 'https://api.trustlesswork.com',
  /** Observed single-release Wasm on mainnet (branch single-release-main). Which hash the v1 API deploys: TODO(verify, D1 live API run) with Trustless Work. */
  twWasmHash: '96d51751f924c938a081deb740056dc1c5cc60c6e645672062531f82957ed2fe',
  /** Fee account hardcoded in that Wasm. */
  trustlessWorkFeeAccount: 'GBWWSOATPLIC72ZBOIM7WJCT7VCAHNWW4QUBZ2H4FORMCCIUM5ZVKSZN',
  eurcIssuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
  eurcSac: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
});

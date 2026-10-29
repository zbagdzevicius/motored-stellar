/**
 * Network configuration.
 *
 * This package is testnet-only in this release. The mainnet passphrase and
 * URLs appear only as documented references (see `MAINNET_REFERENCE`); no
 * submitter in this package accepts them as a submit target.
 */
import { Networks } from "@stellar/stellar-sdk";

export interface NetworkConfig {
  /** Human label, used in logs and error messages. */
  readonly name: string;
  /** Network passphrase that every transaction hash commits to. */
  readonly passphrase: string;
  /** Horizon URL, used for classic transactions and account reads. */
  readonly horizonUrl: string;
  /**
   * Soroban RPC URL, used for simulation and Soroban submission. Operators
   * should point this at their own RPC node; the public default is for demos.
   */
  readonly rpcUrl: string;
  /** Friendbot URL; only defined on test networks. */
  readonly friendbotUrl?: string;
}

/** Stellar public testnet (SDF-hosted endpoints). */
export const TESTNET: NetworkConfig = Object.freeze({
  name: "testnet",
  passphrase: Networks.TESTNET,
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
});

/**
 * Mainnet, as a documented reference only. Used by tests to assert constants
 * such as the EURC SAC id; never accepted by `assertTestnet`.
 */
export const MAINNET_REFERENCE = Object.freeze({
  name: "mainnet (reference only)",
  passphrase: Networks.PUBLIC,
});

/** Build a testnet config with a custom RPC (for example a self-hosted node). */
export function testnetWith(overrides: Partial<Omit<NetworkConfig, "passphrase">>): NetworkConfig {
  return Object.freeze({ ...TESTNET, ...overrides, passphrase: Networks.TESTNET });
}

/**
 * Throw unless `passphrase` is a test network. Every code path in this package
 * that submits to a network calls this first.
 */
export function assertTestnet(passphrase: string): void {
  if (passphrase === Networks.PUBLIC) {
    throw new Error(
      "motored-stellar/eurc is testnet-only in this release: refusing to submit to the public network",
    );
  }
}

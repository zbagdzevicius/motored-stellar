/**
 * Network selection and the testnet-only guard.
 *
 * deploy.ts and e2e.ts move funds and upload code, so they call `assertTestnet`
 * both on the static config and on what the RPC server itself reports. Only the
 * metric script may read mainnet, and it never signs or submits anything.
 */
import { Networks, rpc } from '@stellar/stellar-sdk';

export type NetworkName = 'testnet' | 'mainnet';

export interface NetworkConfig {
  name: NetworkName;
  passphrase: string;
  rpcUrl: string;
  /** Friendbot is a testnet-only faucet. */
  friendbotUrl?: string;
  /** Block explorer base for human-readable links. */
  explorer: string;
}

export const TESTNET: NetworkConfig = {
  name: 'testnet',
  passphrase: Networks.TESTNET,
  rpcUrl: 'https://soroban-testnet.stellar.org',
  friendbotUrl: 'https://friendbot.stellar.org',
  explorer: 'https://stellar.expert/explorer/testnet',
};

/**
 * Mainnet is a read-only target for the metric and re-check scripts. There is no
 * default RPC URL on purpose: the caller names a provider (`--rpc`).
 */
export function mainnetReadOnly(rpcUrl: string): NetworkConfig {
  return { name: 'mainnet', passphrase: Networks.PUBLIC, rpcUrl, explorer: 'https://stellar.expert/explorer/public' };
}

export class NotTestnetError extends Error {
  constructor(reason: string) {
    super(`refusing to run against a non-testnet network: ${reason}`);
    this.name = 'NotTestnetError';
  }
}

/** Host fragments that identify a mainnet RPC or Horizon endpoint. */
const MAINNET_HINTS = ['mainnet', 'pubnet', 'public', 'horizon.stellar.org'];

/**
 * Static check: the passphrase must be the testnet one and the RPC URL must not
 * look like a mainnet endpoint. Throws `NotTestnetError` otherwise.
 */
export function assertTestnet(cfg: Pick<NetworkConfig, 'passphrase' | 'rpcUrl'>): void {
  if (cfg.passphrase === Networks.PUBLIC) throw new NotTestnetError('mainnet passphrase');
  if (cfg.passphrase !== Networks.TESTNET) throw new NotTestnetError(`unknown passphrase "${cfg.passphrase}"`);
  let host: string;
  try {
    host = new URL(cfg.rpcUrl).host.toLowerCase();
  } catch {
    throw new NotTestnetError(`invalid RPC URL "${cfg.rpcUrl}"`);
  }
  if (MAINNET_HINTS.some((h) => host.includes(h)) && !host.includes('testnet')) {
    throw new NotTestnetError(`RPC host "${host}" looks like mainnet`);
  }
}

/**
 * Live check: asks the RPC server which network it serves. Catches a testnet
 * passphrase paired with a mainnet RPC that the static check could not spot.
 */
export async function assertTestnetLive(server: Pick<rpc.Server, 'getNetwork'>, cfg: NetworkConfig): Promise<void> {
  assertTestnet(cfg);
  const net = await server.getNetwork();
  if (net.passphrase !== Networks.TESTNET) throw new NotTestnetError(`RPC reports passphrase "${net.passphrase}"`);
}

/** Testnet config with an optional RPC override (`MS_TESTNET_RPC`), always guarded. */
export function testnetConfig(rpcOverride?: string): NetworkConfig {
  const cfg = rpcOverride ? { ...TESTNET, rpcUrl: rpcOverride } : TESTNET;
  assertTestnet(cfg);
  return cfg;
}

export const txLink = (cfg: NetworkConfig, hash: string): string => `${cfg.explorer}/tx/${hash}`;
export const contractLink = (cfg: NetworkConfig, id: string): string => `${cfg.explorer}/contract/${id}`;
export const accountLink = (cfg: NetworkConfig, id: string): string => `${cfg.explorer}/account/${id}`;

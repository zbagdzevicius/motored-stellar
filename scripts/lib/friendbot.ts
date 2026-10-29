/** Testnet faucet helper. Friendbot exists on testnet only. */
import type { rpc } from '@stellar/stellar-sdk';
import type { NetworkConfig } from './network.js';
import { assertTestnet } from './network.js';

/** Funds `address` through friendbot unless the account already exists. Returns true when it funded. */
export async function fundWithFriendbot(
  server: Pick<rpc.Server, 'getAccount'>,
  cfg: NetworkConfig,
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  assertTestnet(cfg);
  if (!cfg.friendbotUrl) throw new Error('no friendbot configured for this network');
  try {
    await server.getAccount(address);
    return false; // already exists
  } catch {
    // not found: fund it
  }
  const r = await fetchImpl(`${cfg.friendbotUrl}?addr=${encodeURIComponent(address)}`);
  if (!r.ok) throw new Error(`friendbot ${r.status} for ${address}`);
  return true;
}

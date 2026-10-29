/** Soroban RPC implementations of the re-check reader ports. Read-only (simulation); safe on mainnet. */
import { Address, scValToNative } from '@stellar/stellar-sdk';
import { bytes, u32, u64, vec } from '../lib/scval.js';
import type { Chain } from '../lib/soroban.js';
import type { GuardReader, RegistryReader } from './recheck-core.js';

export class RpcRegistry implements RegistryReader {
  constructor(private readonly chain: Chain, private readonly registry: string, private readonly source: string) {}

  async verify(batchId: bigint, leaf: Buffer, proof: Buffer[], index: number): Promise<boolean> {
    const r = await this.chain.read(this.registry, 'verify', [u64(batchId), bytes(leaf), vec(proof.map((p) => bytes(p))), u32(index)], this.source);
    if ('error' in r) return false;
    return scValToNative(r.val) === true;
  }

  async anchoredAt(batchId: bigint): Promise<bigint | { error: string }> {
    const r = await this.chain.read(this.registry, 'anchored_at', [u64(batchId)], this.source);
    if ('error' in r) return { error: r.error };
    return BigInt(scValToNative(r.val) as bigint);
  }
}

export class RpcGuard implements GuardReader {
  constructor(private readonly chain: Chain, private readonly guard: string, private readonly source: string) {}

  async fundedAt(escrow: string): Promise<bigint | undefined> {
    const r = await this.chain.read(this.guard, 'registration', [new Address(escrow).toScVal()], this.source);
    if ('error' in r) return undefined;
    const reg = scValToNative(r.val) as { funded_at?: bigint | null } | null | undefined;
    return reg && reg.funded_at !== undefined && reg.funded_at !== null ? BigInt(reg.funded_at) : undefined;
  }
}

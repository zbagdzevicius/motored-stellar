/**
 * npm run claims:recheck -- --claim <claim.json> [--guard <C...>] [--rpc <url>] [--source <G...>]
 * npm run claims:recheck -- --claim <claim.json> --root <hex>        # offline: proof against a published root
 * npm run claims:recheck -- --from-state [--index n]                 # testnet: a claim anchored by testnet:e2e
 *
 * Re-checks a released order's delivery claim against the claim registry using
 * the published leaf format (docs/leaf-format.md). Read-only: it simulates
 * `verify` and `anchored_at` (and the guard's `registration` when --guard is
 * given) and never signs or submits. Mainnet reads need an explicit --rpc.
 * Exit code 0 when every check passes, 2 when any fails.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Keypair } from '@stellar/stellar-sdk';
import { claimFromFile, claimLeaf, verifyProof, type ClaimFile } from '../lib/claims.js';
import { consoleOut, isMain, runMain, type Out } from '../lib/cli.js';
import { mainnetReadOnly, testnetConfig, type NetworkConfig } from '../lib/network.js';
import { Chain } from '../lib/soroban.js';
import { readState } from '../lib/state.js';
import { recheckClaim } from './recheck-core.js';
import { RpcGuard, RpcRegistry } from './rpc-readers.js';

export async function main(argv: string[] = process.argv.slice(2), out: Out = consoleOut): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      claim: { type: 'string' },
      'from-state': { type: 'boolean', default: false },
      index: { type: 'string', default: '-1' },
      root: { type: 'string' },
      guard: { type: 'string' },
      rpc: { type: 'string' },
      source: { type: 'string' },
    },
  });

  let file: ClaimFile;
  let guardId = values.guard;
  if (values['from-state']) {
    const st = readState();
    const claims = st.claims ?? [];
    const i = Number(values.index);
    const picked = i < 0 ? claims[claims.length - 1] : claims[i];
    if (!picked) throw new Error('no claims in testnet-state.json; run `npm run testnet:e2e` first');
    file = picked;
    guardId ??= st.guard;
  } else if (values.claim) {
    file = JSON.parse(readFileSync(values.claim, 'utf8')) as ClaimFile;
  } else {
    throw new Error('pass --claim <file> or --from-state');
  }
  const claim = claimFromFile(file);

  // Offline mode: the proof against a root published elsewhere (e.g. in a run log).
  if (values.root) {
    const leaf = claimLeaf(claim.escrow, claim);
    const ok = verifyProof(leaf, claim.proof, claim.index, Buffer.from(values.root, 'hex'));
    out.log(JSON.stringify({ mode: 'offline', escrow: claim.escrow, batch_id: file.batch_id, leaf: leaf.toString('hex'), ok }, null, 2));
    return ok ? 0 : 2;
  }

  let cfg: NetworkConfig;
  if (file.network === 'mainnet') {
    if (!values.rpc) throw new Error('mainnet claims need --rpc <mainnet RPC URL> (read-only)');
    cfg = mainnetReadOnly(values.rpc);
  } else {
    cfg = testnetConfig(values.rpc ?? process.env.MS_TESTNET_RPC);
  }
  const chain = new Chain(cfg, out.log);
  // Simulation needs a well-formed source; it signs nothing. A random public key is enough.
  const source = values.source ?? Keypair.random().publicKey();
  const result = await recheckClaim(
    claim,
    new RpcRegistry(chain, file.registry, source),
    guardId ? new RpcGuard(chain, guardId, source) : undefined,
  );
  out.log(JSON.stringify({ network: cfg.name, registry: file.registry, escrow: claim.escrow, batch_id: file.batch_id, ...result }, null, 2));
  return result.ok ? 0 : 2;
}

if (isMain(import.meta.url)) runMain(() => main());

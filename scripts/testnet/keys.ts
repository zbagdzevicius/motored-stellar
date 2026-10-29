/**
 * npm run testnet:keys [-- --force] [-- --no-fund]
 *
 * Generates every testnet role at runtime (Keypair.random-equivalent seeds for
 * accounts, 32 random bytes for each guard ed25519 key), stores them in the
 * git-ignored `.keys/testnet.json` (mode 0600) and funds the accounts through
 * friendbot. Prints G-addresses and raw guard public keys only.
 *
 * Replaces the lab's `stellar keys generate a8-*` identities and its fixed
 * guard-key seeds.
 */
import { parseArgs } from 'node:util';
import { rpc } from '@stellar/stellar-sdk';
import { isMain, runMain, consoleOut, type Out } from '../lib/cli.js';
import { fundWithFriendbot } from '../lib/friendbot.js';
import { ACCOUNT_ROLES, FileKeyStore, generateTestnetKeys, publicView, type KeyStore } from '../lib/keystore.js';
import { accountLink, assertTestnetLive, testnetConfig } from '../lib/network.js';

export async function main(argv: string[] = process.argv.slice(2), store: KeyStore = new FileKeyStore(), out: Out = consoleOut): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { force: { type: 'boolean', default: false }, 'no-fund': { type: 'boolean', default: false } } });
  const cfg = testnetConfig(process.env.MS_TESTNET_RPC);

  let keys = store.load();
  if (keys && !values.force) {
    out.log(`keys already exist at ${store.describe()} (pass --force to replace them)`);
  } else {
    keys = generateTestnetKeys();
    store.save(keys, { overwrite: values.force });
    out.log(`wrote ${store.describe()} (mode 0600, git-ignored)`);
  }

  if (!values['no-fund']) {
    const server = new rpc.Server(cfg.rpcUrl);
    await assertTestnetLive(server, cfg);
    for (const role of ACCOUNT_ROLES) {
      const pk = keys.accounts[role].publicKey;
      const funded = await fundWithFriendbot(server, cfg, pk);
      out.log(`${role.padEnd(9)} ${pk} ${funded ? 'funded' : 'exists'} ${accountLink(cfg, pk)}`);
    }
  }
  out.log(JSON.stringify(publicView(keys), null, 2));
  return 0;
}

if (isMain(import.meta.url)) runMain(() => main());

/**
 * Testnet demo of D2 with the XEUR stand-in. Run manually:
 *
 *   npm run demo:standin -w @motored-stellar/eurc
 *
 * Every key is generated here with Keypair.random(), funded by friendbot,
 * held in memory only and discarded on exit. Only public keys and
 * transaction hashes are printed. Testnet only: the submitter refuses the
 * public network.
 *
 * Steps:
 *   1. sponsor + issuer funded by friendbot
 *   2. sponsored createAccount(0 XLM) + XEUR trustline for a user and for a
 *      ramp-deposit account (sponsor pays all reserves)
 *   3. issuer pays the user 100 XEUR
 *   4. the user (0 XLM) pays 10 XEUR to its registered ramp destination,
 *      fee-bumped by the sponsor through the allowlist
 *   5. the same user asks for a fee-bump of a payment to an arbitrary
 *      address: refused by the policy, nothing is signed or submitted
 */
import { Keypair, Operation, StrKey, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import {
  FeeBumpPolicy,
  FeeBumpService,
  FixedWindowRateLimiter,
  HorizonAccountReader,
  HorizonRpcSubmitter,
  InMemoryWalletRegistry,
  KeypairSigner,
  TESTNET,
  attachSignature,
  attachSignatures,
  buildIssueTx,
  buildSponsoredAccountTx,
  describeStandIn,
  friendbot,
  loadSdkAccount,
  testnetWith,
  trustlineStatus,
} from "../src/index.js";

const network = process.env.STELLAR_RPC_URL ? testnetWith({ rpcUrl: process.env.STELLAR_RPC_URL }) : TESTNET;
const submitter = new HorizonRpcSubmitter(network);
const reader = new HorizonAccountReader(network);
const np = network.passphrase;

const sponsor = KeypairSigner.random();
const issuer = KeypairSigner.random();
const user = KeypairSigner.random();
const ramp = KeypairSigner.random();
const log = (k: string, v: unknown) => console.log(k.padEnd(28), typeof v === "string" ? v : JSON.stringify(v));

await friendbot(network, sponsor.publicKey());
await friendbot(network, issuer.publicKey());
log("sponsor", sponsor.publicKey());
log("issuer", issuer.publicKey());

const { asset: xeur, sacId } = describeStandIn(issuer.publicKey(), np);
log("XEUR SAC (derived)", sacId);

for (const [label, who] of [["user", user], ["ramp", ramp]] as const) {
  const tx = buildSponsoredAccountTx(await loadSdkAccount(reader, sponsor.publicKey()), who.publicKey(), [xeur], {
    networkPassphrase: np,
  });
  await attachSignatures(tx, [sponsor, who]);
  const r = await submitter.submit(tx);
  log(`sponsored create ${label}`, r);
}
log("user XEUR trustline", (await trustlineStatus(reader, user.publicKey(), xeur)).kind);

const issue = buildIssueTx(await loadSdkAccount(reader, issuer.publicKey()), user.publicKey(), xeur, "100", np);
await attachSignature(issue, issuer);
log("issue 100 XEUR", await submitter.submit(issue));

const registry = new InMemoryWalletRegistry().register(user.publicKey(), { ramp: { address: ramp.publicKey() } });
const policy = new FeeBumpPolicy({
  networkPassphrase: np,
  eurc: xeur,
  // The demo exercises the off-ramp rule only; this guard id is a random placeholder.
  guardContractId: StrKey.encodeContract(randomBytes(32)),
  sponsorPublicKey: sponsor.publicKey(),
  registry,
});
const service = new FeeBumpService({
  policy,
  sponsor,
  submitter,
  rateLimiter: new FixedWindowRateLimiter(10, 60_000),
});

const payTo = async (destination: string) => {
  const inner = new TransactionBuilder(await loadSdkAccount(reader, user.publicKey()), { fee: BASE_FEE, networkPassphrase: np })
    .addOperation(Operation.payment({ destination, asset: xeur, amount: "10" }))
    .setTimeout(120)
    .build();
  await attachSignature(inner, user);
  return service.bumpAndSubmit(inner);
};

const ok = await payTo(ramp.publicKey());
log("off-ramp payment (bumped)", ok.ok ? { action: ok.action.kind, outcome: ok.outcome } : ok);

const bad = await payTo(Keypair.random().publicKey());
log("arbitrary payment", bad.ok ? "UNEXPECTEDLY ALLOWED" : { refused: bad.reason });

# Testnet proofs

Public Stellar **testnet** contract IDs and transaction hashes from the runs behind this code.
Runs 1 to 3 were copied from lab run logs. Runs 4 to 9 were produced by this repository's own
scripts (`npm run testnet:keys`, `testnet:deploy`, `testnet:e2e`, `testnet:e2e-claims`, `testnet:refusals`, `testnet:v010`). Links go to [stellar.expert](https://stellar.expert/explorer/testnet).

Testnet is reset from time to time, and a reset erases these entries. The run notes, fees and
instruction counts stay in [verification.md](verification.md). To make a fresh proof, run
`npm run testnet:keys && npm run testnet:deploy && npm run testnet:e2e && npm run testnet:e2e-claims && npm run testnet:refusals && npm run testnet:v010`
and append the output below with the date. Runs 4 to 9 are re-run and re-logged here after any reset, so their links stay live for reviewers.

Pinned Trustless Work escrow Wasm (used by every run and by the unit tests):
testnet `7c3f7b2af92ad86092708b23babf80f9e1308d7f3ce18b703b9499192ecc934b`,
mainnet reference only `96d51751f924c938a081deb740056dc1c5cc60c6e645672062531f82957ed2fe`.
Guard v0.8 optimised Wasm sha256 as deployed in run 3:
`6fb8e25dc3cba23bd3764cc6b4389982a956357e55b21b2a3a32ba527cebce77`.
Guard v0.9 optimised Wasm sha256 as deployed in run 7:
`f53d1ece92fcc29f822aac45a720f4b112a0cdd637e22bf3185cc1ae23c4d0d1`. This hash refers to the
deployed build, made with the workspace version at 0.8.0. The repository's guard source is the same,
but at workspace version 0.9.0 it builds and optimises to
`c3fe20557bcde3bea44b1cb74aa01efab00a46f52b3bd0ddb6f4c4c0f872fb22` (22,541 bytes; the version
string changes the built bytes, not the logic; see [verification.md](verification.md)), which is
what a fresh `npm run testnet:deploy` of the v0.9 source uploads once the optimised file is built.
Guard v0.10 (with the platform fee cap) optimised Wasm sha256 as deployed in run 9:
`2a21ef35e57f8505861296e2b93a09c5aa2117c66a5fb5d3d2cbcefe3087fbb5` (22,664 bytes, workspace version
0.10.0); claim registry v0.10 `e829dc52672dbc8aebca65c6595416ca2b8fba5b787a575e4a487dda3d808870`.

In runs 1 to 7 a lab-issued asset (run 4: `XEUR`, issued by the run's own issuer account) stood in for EURC;
runs 8 and 9 used Circle's testnet EURC (see [Run 8](#run-8-real-circle-testnet-eurc-guard-v09-29-oct-2026-1156-to-1205-utc)
and [Run 9](#run-9-guard-v010-on-circle-testnet-eurc-29-oct-2026-1903-to-1910-utc)).
In all runs the seller-payout delay and contest window were shortened to 120 s so a run fits in minutes. Production values are
7 days. The guard code was the lab crate `lab-guard`, which this repository ships as
`motored-escrow-guard` with the same logic.

## Run 1: guard v0.6, 24 Oct 2026

| Contract | ID |
|---|---|
| Guard | [`CCPWF7OW...A3B2UL`](https://stellar.expert/explorer/testnet/contract/CCPWF7OW3KSTK2MK3HSQLWSTZ4W4K2F2SBJP7X6ZO3QMLQDJ4FA3B2UL) |
| Claim registry | [`CBMJ3HNY...MA76QE`](https://stellar.expert/explorer/testnet/contract/CBMJ3HNYWEIIELFRTHEYG275IKK3JYKSXGPDGDSICGAZLTE6EXMA76QE) |
| Lab asset SAC (stand-in for EURC) | [`CBLO4JEJ...PVPMT2`](https://stellar.expert/explorer/testnet/contract/CBLO4JEJCBQBYSIUN3WVC2XPOW2NOFJPCQPQJ7MCZBHFHK4BXIPVPMT2) |
| Trustless Work testnet-Wasm instance used as deployer | [`CCRHYKGG...6N7C76`](https://stellar.expert/explorer/testnet/contract/CCRHYKGG6FBM7F74LH7QIYDM6OP3SSZ5FFHDDL6DTAUDX7JIM76N7C76) |

| Step | Transaction |
|---|---|
| Atomic deploy and initialise of an escrow through the deployer | [`78fb5abd5f0a...`](https://stellar.expert/explorer/testnet/tx/78fb5abd5f0aa7744d21ad9f0065c2a71f560fa2ee3acb5a5bb8de66ffc573f7) |
| Buyer `fund_escrow` | [`c90787bf07f0...`](https://stellar.expert/explorer/testnet/tx/c90787bf07f0004ec3b29e2bd976883080eced834577c34c251c9283e8a5bcfb) |
| `register_escrow` on the guard | [`e4301f3c013c...`](https://stellar.expert/explorer/testnet/tx/e4301f3c013ca0b37bf445bfeebafcae3779da6a474b71beeb5b453c7f7174ae) |
| Buyer approves the milestone | [`c29147668a4f...`](https://stellar.expert/explorer/testnet/tx/c29147668a4f1dc17d5cf9b52109f00a8a80c47f7c58710b823069981083acd7) |
| Guard-authorised `release_funds` | [`1db534873a27...`](https://stellar.expert/explorer/testnet/tx/1db534873a2782f8e73eed638a73c816cbeaaea69a64279047ef4591f12e96e1) |
| Seller resolution against a depth-32 delivery claim | [`14121ebaad1f...`](https://stellar.expert/explorer/testnet/tx/14121ebaad1f6ae4ecd5839ba1c2aff84e8cc613cd97615ec406a244a7ced569) |
| Register an escrow at 40% funding | [`7f05e4ef0535...`](https://stellar.expert/explorer/testnet/tx/7f05e4ef0535a506455ce12617c4a11794751c53c7dbf79df6378ce77d98ccf4) |
| Break-glass refund to the buyer | [`825f69862492...`](https://stellar.expert/explorer/testnet/tx/825f698624922a90b1df5032d02f379e05e7fe7d6c2f53068928342a069be109) |
| Revoke a claim batch (revoker key) | [`4aad4baab685...`](https://stellar.expert/explorer/testnet/tx/4aad4baab68503689f8a7055b7b6e359f9e0d5fee282ae03da9e79d95fe31082) |
| Resolver refund to the buyer | [`ae7f6756a369...`](https://stellar.expert/explorer/testnet/tx/ae7f6756a3697584dd3b718482b889409fedf46236be55cf93957a2043f0b4bd) |

## Run 2: guard v0.7, 24 Oct 2026, 21:14 to 21:20 UTC

| Contract | ID |
|---|---|
| Guard | [`CDKARO3L...CQ3IWK`](https://stellar.expert/explorer/testnet/contract/CDKARO3LJKPL7K5BJ6V3SO6OWTVLRQJDVNNIXCJ5BUIPZCPVEOCQ3IWK) |
| Claim registry | [`CDSD7V42...VSWDKV`](https://stellar.expert/explorer/testnet/contract/CDSD7V42YXRKL24QC7TCV5XBGWIO7RDXLXC32BA5ZLOTFCJNZHVSWDKV) |
| Lab asset SAC | [`CBYLCEFN...YXJSQS`](https://stellar.expert/explorer/testnet/contract/CBYLCEFNLCMRRXFVODN2M444HQKASLJHYW6PZZITQVXLN774YMYXJSQS) |
| Deployer | [`CDJRR7UE...ARYM7U`](https://stellar.expert/explorer/testnet/contract/CDJRR7UEJ5QYSSVIC3RP5OVA7SIMJRLEFUZOTP3P3FNVRUD4XMARYM7U) |

| Step | Transaction |
|---|---|
| Escrow naming another platform (precheck then refuses, #22) | [`b595050442f4...`](https://stellar.expert/explorer/testnet/tx/b595050442f4efabe275ca449fb3c014b6aaff76e70e77017b3b061b6a4c73d4) |
| Third-party 1-unit dust transfer to an unfunded escrow (precheck then refuses, #24) | [`9ea846f643e0...`](https://stellar.expert/explorer/testnet/tx/9ea846f643e065c34fc56fed873dd79f40b9f4487753dfd75b27d3ebdebe9332) |
| Buyer funding with the pre-dust snapshot | [`0cc7af15ef85...`](https://stellar.expert/explorer/testnet/tx/0cc7af15ef853feccc087b41837c62ca0ee41ca3a34b5daea3186838a480ea76) |
| Platform dispute cancels a dusted escrow | [`1c5652293d63...`](https://stellar.expert/explorer/testnet/tx/1c5652293d63b6db3381c1a795238d2d284538fda43dd79a9dab693e7d596bdc) |
| Seller dispute after buyer approval | [`465baee4e6c8...`](https://stellar.expert/explorer/testnet/tx/465baee4e6c81ba969a33137526c090eae7ceec672e62fc631d8c8845f198f60) |
| Buyer `contest` on the guard | [`82c18aa74596...`](https://stellar.expert/explorer/testnet/tx/82c18aa74596f17ea520ece62c7169f2f760287216b57c5005c26da53ec1c9a5) |
| Uncontested seller payout after the window | [`31c776b87527...`](https://stellar.expert/explorer/testnet/tx/31c776b87527a73016451370c857910b8d23fcad4d7bedc82d36661696240202) |
| Refund to the buyer after a contest | [`aaaf6aea235f...`](https://stellar.expert/explorer/testnet/tx/aaaf6aea235f5e8c4c2fd6c1ec25c4de677b0458336a74724908422e7e8687da) |

## Run 3: guard v0.8 (the version in this repository), 24 Oct 2026, 21:54 to 21:58 UTC

Heading kept for existing links: the repository now holds v0.9, which is these v0.8 rules plus TTL upkeep (run 7).

| Contract | ID |
|---|---|
| Guard | [`CAM3KPYP...STN5NK`](https://stellar.expert/explorer/testnet/contract/CAM3KPYP6KOBSU4XMCHW46ARCGTVUOKM44YHHLQ7OXDAP23RBVSTN5NK) |
| Claim registry | [`CBDKYDEC...YYLV5W`](https://stellar.expert/explorer/testnet/contract/CBDKYDECWAFVOGGDXWBSFSKPTZGWIENC7VBZG2LSFUQ3LJL3GSYYLV5W) |
| Lab asset SAC | [`CAOVNXTN...QFPKOS`](https://stellar.expert/explorer/testnet/contract/CAOVNXTNKWGZV6PQNYQEO55J7LLEBIJKOXWWPDK54A6GI6DGROQFPKOS) |
| Deployer | [`CDBVSUBX...XH7OME`](https://stellar.expert/explorer/testnet/contract/CDBVSUBXPODDWLZVAGZAFZ6PTQTQ7Y7WWJX6A3BJOKHZRVPWXBXH7OME) |

| Step | Transaction |
|---|---|
| Guard v0.8 deployed | [`1ac5c84bab7c...`](https://stellar.expert/explorer/testnet/tx/1ac5c84bab7cc90f06a5ab4305938d7a01e60bf84e35327343f01ce11fd5cb47) |
| Overfunding: buyer funds the amount | [`38987ef82ed1...`](https://stellar.expert/explorer/testnet/tx/38987ef82ed1ec5559e3110d8edbbf413d670291d0bf1bab6372e9f6d78fe337) |
| Overfunding: buyer funds again (balance 2x) | [`25400724fa30...`](https://stellar.expert/explorer/testnet/tx/25400724fa305a7e95ac12d0bdc85008e82163d871bd3d8bfb9a8ce318aed596) |
| Overfunding: buyer approves | [`501799539753...`](https://stellar.expert/explorer/testnet/tx/501799539753bfb93e2c3b4da60b4abc4b9135e8eb03600d145637fed0395869) |
| Overfunding: seller disputes | [`65d904f85d15...`](https://stellar.expert/explorer/testnet/tx/65d904f85d15ebcaf66f8f8aa46d022710d4752873addf122bb68353c6848543) |
| Overfunding: split after the window, seller gets the amount, buyer the excess | [`65701f3b210f...`](https://stellar.expert/explorer/testnet/tx/65701f3b210fe13a74234931cf7e8344bb900729bcb9410e53442d80d2b5df62) |
| Contest first: buyer contests before any dispute | [`5693488fee34...`](https://stellar.expert/explorer/testnet/tx/5693488fee3429e53333ae1f9de2514618bd1691bbc8e8eeecba65a98d847598) |
| Contest first: buyer disputes second | [`883b1dabd5b0...`](https://stellar.expert/explorer/testnet/tx/883b1dabd5b0406a598b0cbeab7b133a83d2427438f4a9d2edd59c89e505fb5a) |
| Contest first: refund to the buyer | [`db5f64588de7...`](https://stellar.expert/explorer/testnet/tx/db5f64588de796639ec87c051ba46309728d0607dc72a6f1941c1b652eeed2dd) |

## Run 4: guard v0.8 from this repository's scripts, 28 Oct 2026, 09:37 to 09:39 UTC

Fresh keys generated at runtime (git-ignored), contracts built from `contracts/` and deployed by
`npm run testnet:deploy`; scenarios run by `npm run testnet:e2e`. Optimised Wasm sha256 as built:
guard `25de70abd1a3c0740ff261a6df53e880c2d2d3f6debd751ceffe02fa3f72b4a4`,
claim registry `af18affa27b182c3d10ffb022fbd0d0bb2a9b7c0c825bbf0f33418d14a4e98a8`.

| Contract | ID |
|---|---|
| Guard | [`CBYWR2P3...Y467EX`](https://stellar.expert/explorer/testnet/contract/CBYWR2P3PEJS2IYIHVVQ2OHXM2ZHGKZDVVDIWI3JCUW7YE4VXNY467EX) |
| Claim registry | [`CD27AQMH...3EYHPZ`](https://stellar.expert/explorer/testnet/contract/CD27AQMH2QGS2IRJA26LKNRH6ZQFZZ7EI4QWC5PIRVRJQ4KSTY3EYHPZ) |
| XEUR SAC (stand-in for EURC) | [`CDDP3WON...YOY4VF`](https://stellar.expert/explorer/testnet/contract/CDDP3WONCQS5EWCTIITACO3FKIEY6BS5UB6ILE4MT3UGFO25CDYOY4VF) |
| Escrow factory: an instance of Trustless Work's testnet Wasm that this run deployed with its own runtime key, whose built-in deployer function created the escrows | [`CC742MOT...DADWCG`](https://stellar.expert/explorer/testnet/contract/CC742MOTTEMMVGGGHG5UOMDK2M6RHL4TTDAE7DRFBHJLUOZGAZDADWCG) |
| Escrow A (release) | [`CBZKLCMG...GJSX3X`](https://stellar.expert/explorer/testnet/contract/CBZKLCMGU4UK4N42GBUAJUZJNBBXF672U4MZURFPKGDQTRIVN5GJSX3X) |
| Escrow B (dispute refund) | [`CCWPDSC5...XHC4BS`](https://stellar.expert/explorer/testnet/contract/CCWPDSC5UOP7J3TZN7JK62OXVSEJY4IXC46KRNZXC4WOZUAHWOXHC4BS) |
| Escrow C (partial funding, break-glass) | [`CCZQ53SG...FP2AGY`](https://stellar.expert/explorer/testnet/contract/CCZQ53SG4RZMY5HL46PD7ELYHR3HPTXNSIPKTJ4D5GFAFGQANYFP2AGY) |

| Step | Transaction |
|---|---|
| Claim registry uploaded (fee-bump) | [`6f266ca80032...`](https://stellar.expert/explorer/testnet/tx/6f266ca8003211c9fc60897c85792d442f82c42e3386f32c7c7f40b9703bb1bf) |
| Claim registry deployed | [`65da57cb74fd...`](https://stellar.expert/explorer/testnet/tx/65da57cb74fdd1aadd9f00d59d3e23d8db5340a22e0a452ffa9914b52a2fc3bb) |
| Guard uploaded (fee-bump) | [`0cfafb6ce26c...`](https://stellar.expert/explorer/testnet/tx/0cfafb6ce26cf41dd92b8ce4404a0f50964cf64818e4f5deff41ee6a4e23ee7f) |
| Guard deployed | [`6c71bec01d5d...`](https://stellar.expert/explorer/testnet/tx/6c71bec01d5d674a1a7040fb838ab2891392b4c0be4a005c17fca5b357396e41) |
| Trustless Work testnet Wasm instance deployed | [`9f9f059b7ddc...`](https://stellar.expert/explorer/testnet/tx/9f9f059b7ddcad8d9d383ece457dcb2ed519a6c4bf4dc4a5074eea625f06ada8) |
| A: escrow deploy+init through the Trustless Work deployer | [`bb041063f9b5...`](https://stellar.expert/explorer/testnet/tx/bb041063f9b5b81a16b9d2087cc1ad0b285ad43053d5ffe480b1c4725c483319) |
| A: buyer funds 100 XEUR | [`e73b8ccd75bb...`](https://stellar.expert/explorer/testnet/tx/e73b8ccd75bb14d4dcb35ae530e2e82f4cb50ea6658336435016c49785e581ad) |
| A: escrow registered with the guard | [`471c0d3e3407...`](https://stellar.expert/explorer/testnet/tx/471c0d3e340798c84031679d4711745a6ea52bad65ad2ec6f1763ec02e172ac4) |
| A: buyer approves the milestone | [`70dde99fb2d2...`](https://stellar.expert/explorer/testnet/tx/70dde99fb2d223b15ab52aff2e3d31791cd457c0c70bc713341e267f8a103098) |
| A: guard records the approval | [`088fd1f48417...`](https://stellar.expert/explorer/testnet/tx/088fd1f48417bb33b81ab8b50333af474eda5214d4fc7eda711a1c1ac1134ad9) |
| A: delivery-claim batch anchored in the registry | [`2dcab3a8be43...`](https://stellar.expert/explorer/testnet/tx/2dcab3a8be435484a40bed323746ad21238b3f7d291408a3f6c1b061dff86da9) |
| A: release through the guard (seller paid; claim re-check ok) | [`a018c1eb444a...`](https://stellar.expert/explorer/testnet/tx/a018c1eb444a28b2957234f7c33235e253f1f86fe61a865e320ca33096ecdbc0) |
| B: escrow deploy+init | [`772c4a82a4e8...`](https://stellar.expert/explorer/testnet/tx/772c4a82a4e8eb8d6bf0054a0a0d4541667fa3d10d2c355da41a01b1a9a39a6c) |
| B: buyer funds 100 XEUR | [`e4ef5006db69...`](https://stellar.expert/explorer/testnet/tx/e4ef5006db69b30089b9dcb6921b792eeeed664d045b3316844ac8f397c8de01) |
| B: escrow registered | [`597b2e177d0f...`](https://stellar.expert/explorer/testnet/tx/597b2e177d0f8907f5351c912b0e2d59ce4a10ae375d42952bd41d0afa28a901) |
| B: buyer opens a dispute | [`7a01785b588c...`](https://stellar.expert/explorer/testnet/tx/7a01785b588c8b09ab4d596df830e493f8059d5894edaaa48128bef822417f6b) |
| B: guard records the dispute | [`45d653477e0f...`](https://stellar.expert/explorer/testnet/tx/45d653477e0f3158a2b18d8f2c6f6a2723b5c9ba224af8cb2358f85c9a756a6a) |
| B: dispute resolved, whole balance to the buyer | [`577805f66de4...`](https://stellar.expert/explorer/testnet/tx/577805f66de433dcfefc3a4b083d06d9fa49dc84296a9e795814520253968618) |
| B: platform tops up the escrow fee so the buyer nets 100% | [`35b95eb62d3e...`](https://stellar.expert/explorer/testnet/tx/35b95eb62d3eb6c6384bda0a8179065026cce6c5aca090f028ca12fe93d4ee80) |
| C: escrow deploy+init | [`10157aff2dd0...`](https://stellar.expert/explorer/testnet/tx/10157aff2dd0f3eb9d366160f75e034af267bf96062e2b5caec26af48558556e) |
| C: buyer funds 40% only | [`98abd8c470f2...`](https://stellar.expert/explorer/testnet/tx/98abd8c470f249dcc4c67151c8521ad748dd32a1281679e57b13d222b200e859) |
| C: escrow registered at 40% funding | [`595307d9465d...`](https://stellar.expert/explorer/testnet/tx/595307d9465d530611078abee8699d3ed0cbb597246d54172001bca1074a8b4d) |
| C: platform opens a dispute | [`6b65fe369ceb...`](https://stellar.expert/explorer/testnet/tx/6b65fe369ceb3d1b8e26713b2f05a0d099f554aac8cb76cc7460ad9664f66b9a) |
| C: break-glass refund, whole balance to the buyer | [`f35afeec6ecd...`](https://stellar.expert/explorer/testnet/tx/f35afeec6ecd45317c258127b13a3c28998662e05b5cf6f0fd2ee855043685ae) |
| C: platform top-up, buyer nets 100% | [`2cf13fa31644...`](https://stellar.expert/explorer/testnet/tx/2cf13fa31644419061cdfcb7cc13d8b36f5481ff7543614874186f6dfb780050) |

Refused paths, checked by simulation in the same run (no transaction is submitted for a refusal):
release before buyer approval (Trustless Work refuses), release with a wrong Trustless Work fee
address (guard `BadFeeAddr` = 15), release signed with the resolver key (auth trap), resolve to the
seller without a delivery claim (guard `NoClaim` = 8), break-glass to the seller (guard
`NotWholeToBuyer` = 13). Full run log: [`docs/runs/e2e-2026-10-28T09-39-21-050Z.json`](runs/e2e-2026-10-28T09-39-21-050Z.json) (public hashes only).

### Network cost of one order (escrow A, run 4)

`fee_charged` of each escrow-A transaction, read from Horizon testnet on 29 Oct 2026. Resource fees
include the rent for the new escrow and registry entries.

| Step | Tx | fee_charged (stroops) |
|---|---|---|
| Escrow deploy+init | `bb041063f9b5...` | 133,347 |
| Buyer `fund_escrow` | `e73b8ccd75bb...` | 107,507 |
| `register_escrow` with the guard | `471c0d3e3407...` | 50,416 |
| Buyer approves the milestone | `70dde99fb2d2...` | 6,654 |
| Guard records the approval | `088fd1f48417...` | 6,018 |
| Delivery-claim batch anchored | `2dcab3a8be43...` | 22,267 |
| Release through the guard | `a018c1eb444a...` | 20,288 |
| **Total** | | **346,497 (about 0.035 XLM)** |

The "about 2.4 XLM per order" figure (in the SCF #46 architecture document) is the higher figure from lab run 1
(24 Oct 2026, [verification.md](verification.md), Testnet run 1): deploy+init 13,313,438 + fund
10,830,314 + release 22,545 = 24,166,297 stroops (about 2.42 XLM), and is kept as the upper bound
we observed. Not included: trustline and account reserves (base reserves are locked, not spent;
run 4 created its trustlines unsponsored, so no sponsorship reserve appears here), TTL extensions
for escrows open beyond 7 days, and the anchoring job's periodic registry extensions. These are
testnet fees; mainnet fees and rent are not measured yet.

## Run 5: silent buyer and buyer contest, from this repository's scripts, 28 Oct 2026, 22:08 to 22:11 UTC

Same deployment as run 4 (same keys, guard, claim registry, XEUR SAC and escrow factory, read from
`testnet-state.json`); scenarios run by `npm run testnet:e2e-claims` (`scripts/testnet/e2e-claims.ts`).
Payout delay and contest window 120 s (production 7 days). The delivered event came from the
script's mock oracle: no carrier was contacted and no parcel data exists. The claim's leaf is
in the published format ([leaf-format.md](leaf-format.md)); its 8-leaf batch was placed under 29
further levels of random filler siblings, so the anchored root needs a 32-level proof and the guard
walked all 32 levels on-chain.

| Contract | ID |
|---|---|
| Guard (as run 4) | [`CBYWR2P3...Y467EX`](https://stellar.expert/explorer/testnet/contract/CBYWR2P3PEJS2IYIHVVQ2OHXM2ZHGKZDVVDIWI3JCUW7YE4VXNY467EX) |
| Claim registry (as run 4) | [`CD27AQMH...3EYHPZ`](https://stellar.expert/explorer/testnet/contract/CD27AQMH2QGS2IRJA26LKNRH6ZQFZZ7EI4QWC5PIRVRJQ4KSTY3EYHPZ) |
| XEUR SAC (as run 4, stand-in for EURC) | [`CDDP3WON...YOY4VF`](https://stellar.expert/explorer/testnet/contract/CDDP3WONCQS5EWCTIITACO3FKIEY6BS5UB6ILE4MT3UGFO25CDYOY4VF) |
| Escrow factory (as run 4) | [`CC742MOT...DADWCG`](https://stellar.expert/explorer/testnet/contract/CC742MOTTEMMVGGGHG5UOMDK2M6RHL4TTDAE7DRFBHJLUOZGAZDADWCG) |
| Escrow D (silent buyer, seller paid against the claim) | [`CDLO52RB...JSMH2E`](https://stellar.expert/explorer/testnet/contract/CDLO52RBMHUQ5C6OQ77ALPS44PLZYI3JNKIFTNPIR4KHZ3PKT5JSMH2E) |
| Escrow E (buyer contest, refund) | [`CCOCR767...UZKKF6`](https://stellar.expert/explorer/testnet/contract/CCOCR767OCY2VZYCQOVJVY7BISAO4U4PTQVC5IIOXU4IM6VESRUZKKF6) |

| Step | Transaction |
|---|---|
| D: escrow deploy+init through the Trustless Work deployer | [`8340e53c5396...`](https://stellar.expert/explorer/testnet/tx/8340e53c5396a9f27281e86bd3cc77db560552040a81975a94625ffe804091b1) |
| D: buyer funds 100 XEUR, then stays silent (no approval, no dispute) | [`e82c0f688bec...`](https://stellar.expert/explorer/testnet/tx/e82c0f688bec0d18cf6cee3bd4929f4b210b697c5a084951970a4b5a3dfdbd79) |
| D: escrow registered with the guard (records full funding) | [`a2e1aae32101...`](https://stellar.expert/explorer/testnet/tx/a2e1aae321012381178d6e2cc40669591927e37f0aeebcba6f7553b34b02efa1) |
| D: platform opens a dispute | [`f0f7c7312fa1...`](https://stellar.expert/explorer/testnet/tx/f0f7c7312fa1ec1add90e113e13630436641360e80d4b6f159f9414adcce6627) |
| D: guard records the dispute | [`74334e92b568...`](https://stellar.expert/explorer/testnet/tx/74334e92b5684cd178470e3979d8865837c2ac398ab0d59abe4e404f428eb90e) |
| D: delivery-claim batch anchored in the registry (proof depth 32) | [`840d9fb4d6c9...`](https://stellar.expert/explorer/testnet/tx/840d9fb4d6c96cc43c7be4966ab937a2f5123c085428a1959c7a322a704bd52e) |
| D: after the 120 s delay, seller paid through `resolve_dispute` against the claim; the guard verified the depth-32 proof in `__check_auth` (4,955,849 instructions in simulation); seller received 95 XEUR, claim re-check ok | [`6cc1b9f648b5...`](https://stellar.expert/explorer/testnet/tx/6cc1b9f648b57bed8c7944c6f18283a39ccdb95b516ad095f3370d9ec52541d0) |
| E: escrow deploy+init | [`f9f016bc9e35...`](https://stellar.expert/explorer/testnet/tx/f9f016bc9e35f6b4bdb0c4b581d728f5d10bf107dc7fc82077a21f7309221fed) |
| E: buyer funds 100 XEUR | [`8caa5d50f13e...`](https://stellar.expert/explorer/testnet/tx/8caa5d50f13eac56e8e559a821f737a816f5bc8d01cf2b0539e336d041f66851) |
| E: escrow registered (records full funding) | [`fda8088b993f...`](https://stellar.expert/explorer/testnet/tx/fda8088b993f837bedcc582d8a8ec12fe2ac6d9361efdf9f25df8696c1eabaef) |
| E: buyer approves the milestone | [`3bbaccc5cd2e...`](https://stellar.expert/explorer/testnet/tx/3bbaccc5cd2e10001b91cae6c638e57a8e42710ef34e5e46f903364065922be8) |
| E: guard records the approval | [`5dc27e1e5cc2...`](https://stellar.expert/explorer/testnet/tx/5dc27e1e5cc2ebdaf3be194d94c68959623edb1eb0abff819ca5a1035250e095) |
| E: seller opens a dispute | [`8325639a4043...`](https://stellar.expert/explorer/testnet/tx/8325639a4043363d9c8e991c37b4ab5f2ee470b03fa34424dbfcfe60754437ac) |
| E: guard records the dispute (the 120 s contest window opens) | [`a788679fa84c...`](https://stellar.expert/explorer/testnet/tx/a788679fa84c1e45227c5ff2465c56abf60b28501dd18f92573cb30189fb409b) |
| E: buyer calls `contest` on the guard, 5 s into the window | [`ed5a7e8dc83c...`](https://stellar.expert/explorer/testnet/tx/ed5a7e8dc83ccf6488eee929ede31275bb8dbbcfa1bdde502671a5561b27d7d3) |
| E: after the window, dispute resolved with the whole balance to the buyer | [`224ab6396e6a...`](https://stellar.expert/explorer/testnet/tx/224ab6396e6a07150477aa622d0909b1070bfae9707eeb424c5a2db0529cbd15) |
| E: platform tops up the two escrow fees (5 XEUR), buyer nets 100% | [`9c014de424b2...`](https://stellar.expert/explorer/testnet/tx/9c014de424b2a69f23a23239c693853264ce716f3c3b96464a395c4ae28686cb) |

Refused paths, checked by simulation in the same run (no transaction is submitted for a refusal):
D seller payout without a claim (guard `NoClaim` = 8); D seller payout with the anchored claim
before the delay (guard `TooEarly` = 10); D seller payout with a tampered claim field (guard
`NoClaim` = 8, the proof no longer reaches an anchored root); E seller payout after the window,
because the buyer contested (guard `Contested` = 25). The claim was re-checked publicly after the
payout: `registry.verify` true, anchored at ledger time 1793225320, after the guard saw the escrow
fully funded at 1793225305. Run log: [`docs/runs/e2e-claims-2026-10-28T22-11-56-666Z.json`](runs/e2e-claims-2026-10-28T22-11-56-666Z.json) (public hashes only).

## Run 6: refusals landed as failed transactions, 29 Oct 2026, 07:02 to 07:05 UTC

Runs 4 and 5 showed the guard's refusals by enforce-mode simulation only, so no refused call ever
reached the ledger. Run 6 lands four of them: each refused payout below is a real testnet
transaction that validators included and that **failed** in the Soroban host with the guard's own
error code, recorded in the transaction's diagnostic events (`Error(Contract, #N)`). Same deployment as runs 4 and 5 (same keys, guard, claim
registry, XEUR SAC and escrow factory, read from `testnet-state.json`); run by
`npm run testnet:refusals` (`scripts/testnet/refusals.ts`). Every refused escrow is then settled the
legitimate way on the same escrow, so each order shows the refused attempt next to the accepted one.

How a refusal is landed (`Chain.landRefusal` in `scripts/lib/soroban.ts`). A failed simulation
returns no footprint, so a refused call cannot be assembled the usual way. The script (1) simulates
the refused call in record mode and signs the guard's auth entry with the role's key, (2) simulates
it again in enforce mode and requires the expected guard error (a call the guard would accept is
never submitted; any other error stops the step), (3) simulates, without submitting, the accepted
alternative on the same escrow (for example the refund to the buyer), whose footprint covers the
guard's config and per-escrow record that `__check_auth` reads, (4) submits the refused call with
the union of both footprints, the accepted path's resources plus headroom and a resource fee above
its minimum, and (5) reads the error code back from the ledger's diagnostic events. All four
expected codes were confirmed from the ledger. Checked again after the run, outside the script:
the public RPC's `getTransaction` returns `FAILED` for each hash, and stellar.expert's own indexed
copy of each transaction (its public API) has result `txFailed` and the guard's
`Error(Contract, #N)` in the diagnostic events (ledgers 5446750, 5446758, 5446765 and 5446777;
fee charged 28,061 to 28,477 stroops each).

| Contract | ID |
|---|---|
| Guard (as run 4) | [`CBYWR2P3...Y467EX`](https://stellar.expert/explorer/testnet/contract/CBYWR2P3PEJS2IYIHVVQ2OHXM2ZHGKZDVVDIWI3JCUW7YE4VXNY467EX) |
| Escrow A (wrong fee address, then release) | [`CBGSH4QH...HUHGRM`](https://stellar.expert/explorer/testnet/contract/CBGSH4QH5KARKGSWMZJ2DL25COQDT4SHZWXWLSD76U632L3VOMHUHGRM) |
| Escrow B (seller payout without a claim, then refund) | [`CBGIRLMO...OA7ABN`](https://stellar.expert/explorer/testnet/contract/CBGIRLMOZKM3GXJXFP57HUG2CZYCENIDXNXZCA7Q4LX46SAVVLOA7ABN) |
| Escrow C (break-glass to the seller, then refund) | [`CAA7HKSD...PDQGO4`](https://stellar.expert/explorer/testnet/contract/CAA7HKSDYSUYNWJEEH2JZPJ42M5QVBZUCBGPMEUJQIRZLK2CE2PDQGO4) |
| Escrow E (seller payout during the buyer contest, then refund) | [`CB4NGNZE...J65OBP`](https://stellar.expert/explorer/testnet/contract/CB4NGNZEMAEOAKL4MLUDJQX6AV7YBBMVIM22HYHW5CIRYGE4RRJ65OBP) |

Failed transactions (the point of this run):

| Refused payout | Guard error | Failed transaction |
|---|---|---|
| A: release with a wrong `trustless_work_address` (fee account not the pinned one) | `Error(Contract, #15)` `BadFeeAddr` | [`92a1b01c2457...`](https://stellar.expert/explorer/testnet/tx/92a1b01c245703781078d17ece3768ab5913f383099954077ae18d5021a3a598) |
| B: resolver pays the seller with no delivery claim and no buyer approval | `Error(Contract, #8)` `NoClaim` | [`e592b600ab8f...`](https://stellar.expert/explorer/testnet/tx/e592b600ab8fd2e05269c0eedc848b7490ac35ae80591944a71fd90f5422a651) |
| C: break-glass key pays the seller | `Error(Contract, #13)` `NotWholeToBuyer` | [`e2067727b074...`](https://stellar.expert/explorer/testnet/tx/e2067727b0741da618e6f3f3a7775104361efa676947bf9efc61f837e2a79032) |
| E: seller payout while the buyer's contest stands | `Error(Contract, #25)` `Contested` | [`f75e15032094...`](https://stellar.expert/explorer/testnet/tx/f75e150320940a6c55718202ade29a18047feece3cd1b1d8895a80c86312c2c1) |

Every step of the run:

| Step | Transaction |
|---|---|
| A: escrow deploy+init through the Trustless Work deployer | [`93a5889baca2...`](https://stellar.expert/explorer/testnet/tx/93a5889baca20316095eed891af48b699a4533e888bf9a70f8d024e3cbe173af) |
| A: buyer funds 100 XEUR | [`3645a42a33e7...`](https://stellar.expert/explorer/testnet/tx/3645a42a33e7eb24f61e1836fbd8602969bb8a8ea3a875e62a549ff5be9759a9) |
| A: escrow registered with the guard | [`cc82a7d154d9...`](https://stellar.expert/explorer/testnet/tx/cc82a7d154d9ce3d008b477825f731ebc6a7c869fed198c7ec108e2202ed2b6c) |
| A: buyer approves the milestone | [`d5110be4986c...`](https://stellar.expert/explorer/testnet/tx/d5110be4986cab603cd5fd10250d0a65e3825ce49136c9932bdb5d841f92197b) |
| A: guard records the approval | [`5c77a1040693...`](https://stellar.expert/explorer/testnet/tx/5c77a104069362148dc9c247a6fac8e0c046611ffe3448cd6b561116b07d2ad2) |
| **A: FAILED on chain.** `release_funds` with a wrong `trustless_work_address`, signed with the release key: `Error(Contract, #15)` `BadFeeAddr` | [`92a1b01c2457...`](https://stellar.expert/explorer/testnet/tx/92a1b01c245703781078d17ece3768ab5913f383099954077ae18d5021a3a598) |
| A: then `release_funds` with the pinned fee address pays the seller | [`d53730332759...`](https://stellar.expert/explorer/testnet/tx/d53730332759b2483113d34e7f693a66b5b60893404d6d874fcc6db44f140d6d) |
| B: escrow deploy+init | [`a0c89f90c9fa...`](https://stellar.expert/explorer/testnet/tx/a0c89f90c9fa60026d8cfd051e265818f0d134dd8ead52f6dedcea77eed5744a) |
| B: buyer funds 100 XEUR | [`46f342d3ff16...`](https://stellar.expert/explorer/testnet/tx/46f342d3ff16fc4e125e132793a3fede9872ac8520bd820de12924f4c2aa5d46) |
| B: escrow registered | [`16b2c780e108...`](https://stellar.expert/explorer/testnet/tx/16b2c780e108cc6723e49505f25ae3c01e32fb8215680802be777c8a067c86cd) |
| B: buyer opens a dispute | [`2440655946f9...`](https://stellar.expert/explorer/testnet/tx/2440655946f95af7fa5f890421fd1658efa7f56fd32bc5231c981b7188d73c36) |
| B: guard records the dispute | [`97bbc716d809...`](https://stellar.expert/explorer/testnet/tx/97bbc716d809fdb20114d992700676f8b5298b969ea408da8a0df4d8e3e1f2c8) |
| **B: FAILED on chain.** `resolve_dispute` paying the seller without a delivery claim (and without buyer approval), signed with the resolver key: `Error(Contract, #8)` `NoClaim` | [`e592b600ab8f...`](https://stellar.expert/explorer/testnet/tx/e592b600ab8fd2e05269c0eedc848b7490ac35ae80591944a71fd90f5422a651) |
| B: then the whole balance is resolved to the buyer | [`c8a22efa4d6b...`](https://stellar.expert/explorer/testnet/tx/c8a22efa4d6b2dcd56864bd23f227cd7a10692616f80409dc152a0a222d90d08) |
| B: platform tops up the two escrow fees (5 XEUR), buyer nets 100% | [`2a18ce3a6cf2...`](https://stellar.expert/explorer/testnet/tx/2a18ce3a6cf24c3cd2a13c887f465a7db345eab357e52b389c11482c5682aff4) |
| C: escrow deploy+init | [`a545ee2be5c8...`](https://stellar.expert/explorer/testnet/tx/a545ee2be5c889bdcccb82bd3e143e2e8482c923a73977d682a4e906f43ba1bf) |
| C: buyer funds 40 XEUR (40%) | [`d129a1eb091b...`](https://stellar.expert/explorer/testnet/tx/d129a1eb091b2ab0f12af4a421583a65f26092235beffd3bb1cf634b538d08c4) |
| C: escrow registered at 40% funding | [`8695c2df971a...`](https://stellar.expert/explorer/testnet/tx/8695c2df971a1c8ed827d50ebef969e62446735b6a164c98a9795d3c485094f8) |
| C: platform opens a dispute | [`62f12e595475...`](https://stellar.expert/explorer/testnet/tx/62f12e595475514836288a8f8e3afa5767e76cdac1c9809a0cfc9ea010d5f5cd) |
| **C: FAILED on chain.** break-glass key tries `resolve_dispute` paying the seller: `Error(Contract, #13)` `NotWholeToBuyer` | [`e2067727b074...`](https://stellar.expert/explorer/testnet/tx/e2067727b0741da618e6f3f3a7775104361efa676947bf9efc61f837e2a79032) |
| C: then break-glass refunds the whole balance to the buyer | [`b6ff56eb889a...`](https://stellar.expert/explorer/testnet/tx/b6ff56eb889a0c96b3b77b34892a9c2a6ed772df0bd7a4134bf0cf43b2a4873b) |
| C: platform tops up the two escrow fees (2 XEUR) | [`bfffad7c23e3...`](https://stellar.expert/explorer/testnet/tx/bfffad7c23e3d01f4be16629107aa654fb4f9c90c69eb4d1c8f15d4958ae990e) |
| E: escrow deploy+init | [`eac8a3ea8ca6...`](https://stellar.expert/explorer/testnet/tx/eac8a3ea8ca6c02439875781fc1106b09cab02dcb27a3420be97333cda1fce5f) |
| E: buyer funds 100 XEUR | [`68e0c1892698...`](https://stellar.expert/explorer/testnet/tx/68e0c1892698f9af7936cabb3b070d6824e09ef3f059a29ab7131f48f5b8366e) |
| E: escrow registered (records full funding) | [`460a79f4ffbd...`](https://stellar.expert/explorer/testnet/tx/460a79f4ffbd5136294a09e181966e5df668a4a66b29b52bbdcb9a6a687c6708) |
| E: buyer approves the milestone | [`b6b01b2563db...`](https://stellar.expert/explorer/testnet/tx/b6b01b2563db84e3ce40a00ee08358031657ac62b421b8393a461e4b83ad4e35) |
| E: guard records the approval | [`e90b902530cd...`](https://stellar.expert/explorer/testnet/tx/e90b902530cd834f33a46f05e0b635fce852d90782bf222fdf7f3d381807654c) |
| E: seller opens a dispute | [`2b79d640fc17...`](https://stellar.expert/explorer/testnet/tx/2b79d640fc1721531ffee106d167d2d2d256e192941ad391267e7535fe5c58a4) |
| E: guard records the dispute (contest window opens) | [`7bc4e30d9d2f...`](https://stellar.expert/explorer/testnet/tx/7bc4e30d9d2f6e4fdde8a6767dffc62e8e7aa39e761e857ba875c10072a32824) |
| E: buyer calls `contest` on the guard inside the window | [`f9724257377f...`](https://stellar.expert/explorer/testnet/tx/f9724257377f6ad87d038da63b8cc5d2408878378a49e18bb2b728c95b2b36b1) |
| **E: FAILED on chain.** claimless seller payout through `resolve_dispute` while the buyer's contest stands, signed with the resolver key: `Error(Contract, #25)` `Contested` | [`f75e15032094...`](https://stellar.expert/explorer/testnet/tx/f75e150320940a6c55718202ade29a18047feece3cd1b1d8895a80c86312c2c1) |
| E: then the whole balance is resolved to the buyer | [`caea3ddbc004...`](https://stellar.expert/explorer/testnet/tx/caea3ddbc004f577e5d29f088b22b1310b03aee60a3ed32c5d4b4423a736cc02) |
| E: platform tops up the two escrow fees (5 XEUR), buyer nets 100% | [`b63dff8d98a3...`](https://stellar.expert/explorer/testnet/tx/b63dff8d98a3bdc5432eae15afdfa5ba7d7f3a8596f9baebb48668cb94406ec0) |

Not landed in this run: the other refused paths (the release before buyer approval, which Trustless
Work itself refuses; the release signed with the resolver key; `TooEarly` and the tampered claim from
run 5) are still unit tests plus enforce-mode simulations. The same `landRefusal` step can land them.
Run log: [`docs/runs/refusals-2026-10-29T07-05-36-669Z.json`](runs/refusals-2026-10-29T07-05-36-669Z.json) (public hashes only).

## Run 7: guard v0.9 with TTL upkeep, 29 Oct 2026, 09:27 to 09:35 UTC

Guard v0.9 adds in-contract TTL upkeep (see [architecture.md](architecture.md), Guard contract) and
changes no rule. Same runtime keys as runs 4 to 6 (git-ignored `.keys/`), a fresh deployment by
`npm run testnet:deploy` (new claim registry, new guard, new escrow factory; the XEUR SAC from run 4
was reused), then `npm run testnet:e2e` (A, B, C) and `npm run testnet:e2e-claims` (D, E). Payout
delay and contest window 120 s (production 7 days). The delivered event came from the script's mock
oracle. Optimised Wasm sha256 as built and uploaded:
guard v0.9 `f53d1ece92fcc29f822aac45a720f4b112a0cdd637e22bf3185cc1ae23c4d0d1` (22,541 bytes),
claim registry `af18affa27b182c3d10ffb022fbd0d0bb2a9b7c0c825bbf0f33418d14a4e98a8` (unchanged since run 4).

| Contract | ID |
|---|---|
| Guard v0.9 | [`CBNODLOP...UAJKX6`](https://stellar.expert/explorer/testnet/contract/CBNODLOP53AMF2MTXUM4V36SWTFLZE4APWWXNMTZAI7XGRIJOQUAJKX6) |
| Claim registry | [`CCHAVZFF...O3OK26`](https://stellar.expert/explorer/testnet/contract/CCHAVZFFGI44XTEHY23GHTYTWDBIXSPSK5FEVCYICDKCYFUSWAO3OK26) |
| XEUR SAC (as run 4, stand-in for EURC) | [`CDDP3WON...YOY4VF`](https://stellar.expert/explorer/testnet/contract/CDDP3WONCQS5EWCTIITACO3FKIEY6BS5UB6ILE4MT3UGFO25CDYOY4VF) |
| Escrow factory (Trustless Work testnet Wasm instance) | [`CDDLQTQX...BOBJPY`](https://stellar.expert/explorer/testnet/contract/CDDLQTQXS42V5TQVRVESEDNZNMXZ2FJPCFZDP4J6PJN667ABTNBOBJPY) |
| Escrow A (release) | [`CAIKWHW7...7PDMRQ`](https://stellar.expert/explorer/testnet/contract/CAIKWHW744BMNMF5FSC6XP7LZTVB37KQFXWLJ5O5ILJKQM3GQ57PDMRQ) |
| Escrow B (dispute refund) | [`CDRRZE64...OAFLWY`](https://stellar.expert/explorer/testnet/contract/CDRRZE645RPIOYHXJCXDBU5SQZUZQXRAHRKJ3HRKS3GWGWHSPIOAFLWY) |
| Escrow C (partial funding, break-glass) | [`CCOA5O42...HCTVXU`](https://stellar.expert/explorer/testnet/contract/CCOA5O42POSX5KF2CKP3AZJ3SLSLEHAGC7GF7RENZC5PFRI65JHCTVXU) |
| Escrow D (silent buyer, seller paid against the claim) | [`CB5VVZ24...DMX54P`](https://stellar.expert/explorer/testnet/contract/CB5VVZ24FPIQCPZPPGGJV2JMRJWVJZ533OHP4XBTSSXO5FWRLHDMX54P) |
| Escrow E (buyer contest, refund) | [`CA5JCYZL...LCGMGE`](https://stellar.expert/explorer/testnet/contract/CA5JCYZL5I2ZMSFCNUZYPDLEUNQINIUCNL4RLY4NRSNF2FINZULCGMGE) |
| Escrow A0 (first `testnet:e2e` attempt, stopped before release; funded with 100 XEUR and approved, not settled) | [`CC4ZSC55...NP3DKQ`](https://stellar.expert/explorer/testnet/contract/CC4ZSC55IASIAXUWFJ76VDYPFIZ35L6SPCRKVFSHCB2Z5WRFIGNP3DKQ) |

Deployment:

| Step | Transaction |
|---|---|
| Trustlines for buyer, seller, platform, twFee, third (already present from run 4; `changeTrust` re-applied) | see run 4 |
| Issue floats | [`8aae8f5dadf7...`](https://stellar.expert/explorer/testnet/tx/8aae8f5dadf7e418493458c72264dc798ad04222b1b50138dac74f8390301d3e) |
| Claim registry uploaded (fee-bump; same Wasm as run 4) | [`c64154207732...`](https://stellar.expert/explorer/testnet/tx/c641542077326abee5d0e855feb0325c53ddecee75eb5629f4f6ec321c20458d) |
| Claim registry deployed | [`8f4bac855ec1...`](https://stellar.expert/explorer/testnet/tx/8f4bac855ec1749e5395a8b6949408c491f4509a6abf47538bc69c8bb44cfe71) |
| Guard v0.9 uploaded (fee-bump) | [`6a8d5861f73b...`](https://stellar.expert/explorer/testnet/tx/6a8d5861f73b6fd3d05f595c4b6de70ea74e067bff3a307bf9c455b8c9cb282c) |
| Guard v0.9 deployed (the constructor extends instance and code to 60 days) | [`678fe05c1732...`](https://stellar.expert/explorer/testnet/tx/678fe05c17328790079df30ee7b32271c0d6e73234feb6942b81cdb98fd16b8b) |
| Trustless Work testnet Wasm instance deployed (escrow factory) | [`eb5ba884b535...`](https://stellar.expert/explorer/testnet/tx/eb5ba884b5350d0941797bab1ce12f35a98b7b9388ccb19c5736e7948d0a3c27) |

Scenarios:

| Step | Transaction |
|---|---|
| A: escrow deploy+init through the Trustless Work deployer | [`8a5550bf076e...`](https://stellar.expert/explorer/testnet/tx/8a5550bf076e19caa708cf6cf3cf588773aa53e5a899b4730b9b94c76d3078f5) |
| A: buyer funds 100 XEUR | [`b8f33a745d38...`](https://stellar.expert/explorer/testnet/tx/b8f33a745d38ef139c28e8755fa325bfd0eb8d0b8a0fe558b030f2a8005d490c) |
| A: escrow registered with the guard (`Reg` created and extended to 60 days) | [`37de9b859994...`](https://stellar.expert/explorer/testnet/tx/37de9b8599946b1b2bc452057c81433e3dc81072998047ae7992b1e9600ecbe8) |
| A: buyer approves the milestone | [`4a34ff611de3...`](https://stellar.expert/explorer/testnet/tx/4a34ff611de3f852caf9bfec7c0f26aef3b546dec6e80140deb816d76fd1a934) |
| A: guard records the approval | [`e53a2e2ca25e...`](https://stellar.expert/explorer/testnet/tx/e53a2e2ca25e51805c3091db623b82c0e54fd7c1a66aa2c1ab9ce4eb6136c0ed) |
| A: delivery-claim batch anchored in the registry | [`402ffbf31242...`](https://stellar.expert/explorer/testnet/tx/402ffbf31242ed8d55c29a942d7c78daaebdf60ff9410d0e0eacddeca4180871) |
| A: release through the guard (seller received 95 XEUR; claim re-check ok) | [`a851cf7e3908...`](https://stellar.expert/explorer/testnet/tx/a851cf7e3908a3c876df72104baaec4d8499b23196d70f05b109d38c12a510a7) |
| B: escrow deploy+init | [`413ed8125587...`](https://stellar.expert/explorer/testnet/tx/413ed812558772e51d6809e880df807de1f33d53ddbdd8f371ec79df81f5578d) |
| B: buyer funds 100 XEUR | [`12c15e769ae8...`](https://stellar.expert/explorer/testnet/tx/12c15e769ae8f45a464d354c7dee661f4364e27e4fce3510e338ee66a70c8b29) |
| B: escrow registered | [`2f828972de2d...`](https://stellar.expert/explorer/testnet/tx/2f828972de2d6db10cdf0ebc0613e3d4aaa670de6af8865f7b94e3dc44ea844e) |
| B: buyer opens a dispute | [`9c37e171fe9d...`](https://stellar.expert/explorer/testnet/tx/9c37e171fe9d99176a86d6ec548dfacd7ce238d42e7f3cc1d57b023b3036d88b) |
| B: guard records the dispute | [`75c545b832ed...`](https://stellar.expert/explorer/testnet/tx/75c545b832eda9cdcdb18b8da15730e9d545fb592ad211a0aedbcd1aa30a70a6) |
| B: dispute resolved, whole balance to the buyer | [`0ee52513f9b6...`](https://stellar.expert/explorer/testnet/tx/0ee52513f9b6abce13acbd9ade89b5c7c81a48b2502284d936407a85ef6d279c) |
| B: platform tops up the escrow fees so the buyer nets 100% | [`afdfc8f7c9d9...`](https://stellar.expert/explorer/testnet/tx/afdfc8f7c9d981bb6e07aa9edf45f2b248d7094acfed144a42ce593550b97afd) |
| C: escrow deploy+init | [`16b4fbafd47d...`](https://stellar.expert/explorer/testnet/tx/16b4fbafd47d51d2f332a632a98e09888a4d3c29a85788b16e04b9d8021ec206) |
| C: buyer funds 40% only | [`870803ed2a7f...`](https://stellar.expert/explorer/testnet/tx/870803ed2a7f3ff3ae4c5c23a6c5ca0a451acf1d21dbaa47577c87398ee47aa4) |
| C: escrow registered at 40% funding | [`b8674683d7cf...`](https://stellar.expert/explorer/testnet/tx/b8674683d7cf3cd199fb364d16ec0bef373e0cffb71061035e3c2bafef835a9f) |
| C: platform opens a dispute | [`dd0e3cb0bb8c...`](https://stellar.expert/explorer/testnet/tx/dd0e3cb0bb8c20442672fe276b7341a16e2bd1bd33d0355538892d3e62d6722a) |
| C: break-glass refund, whole balance to the buyer | [`d2b81127ea43...`](https://stellar.expert/explorer/testnet/tx/d2b81127ea43d81044d96664c116344a7a2e8ee6cb5db3db0af0d7b35dc015ab) |
| C: platform top-up, buyer nets 100% | [`c0b1efc302ce...`](https://stellar.expert/explorer/testnet/tx/c0b1efc302ce1ecdd6efc84a2b54150ea7bd0e23ef428871ad230466bda53207) |
| D: escrow deploy+init | [`3e5ac1f10301...`](https://stellar.expert/explorer/testnet/tx/3e5ac1f10301b1b281780eb3be7094d25d96ac4191335c1de5e6f2ea87a5a8b9) |
| D: buyer funds 100 XEUR, then stays silent | [`2c37b03ebdb3...`](https://stellar.expert/explorer/testnet/tx/2c37b03ebdb310d0b5b129eb2e121983800714ec27ea26983f5c2fc3ec34810d) |
| D: escrow registered (records full funding) | [`38919529f3b3...`](https://stellar.expert/explorer/testnet/tx/38919529f3b302626193a3319b2f8f305058abf13d4f36ceb95a2a0f30d08a3f) |
| D: platform opens a dispute | [`0b86a85dd295...`](https://stellar.expert/explorer/testnet/tx/0b86a85dd2959b11b80c0e1a048ecf91f946f1e7c5a078dbbbac124b3e2b44c1) |
| D: guard records the dispute | [`c3cee887386d...`](https://stellar.expert/explorer/testnet/tx/c3cee887386dcde582daa82ba2ad34aac0102d82477abeaf61a94bd9a09bb517) |
| D: delivery-claim batch anchored (proof depth 32) | [`fbbee22c070e...`](https://stellar.expert/explorer/testnet/tx/fbbee22c070e00063ca775ef3e1da6a559dac2a105b74416117b85bd9c466b02) |
| D: after the 120 s delay, seller paid through `resolve_dispute` against the claim; the guard verified the depth-32 proof in `__check_auth` (4,996,027 instructions in simulation); seller received 95 XEUR, claim re-check ok | [`0c8780dc75d6...`](https://stellar.expert/explorer/testnet/tx/0c8780dc75d6ed0632155a0a88af09b8cfc6219e78ecd6a7d596641bb52706a4) |
| E: escrow deploy+init | [`2f89fc5f897d...`](https://stellar.expert/explorer/testnet/tx/2f89fc5f897d0dcb355d8aae2046eb0975c936173ef3bf632366bf9d96d342a7) |
| E: buyer funds 100 XEUR | [`6cb7cc832bf5...`](https://stellar.expert/explorer/testnet/tx/6cb7cc832bf5b6ae946a6ff3cda17f0f8dd505ba8dd6fa00d4f1d362bf5ed91a) |
| E: escrow registered (records full funding) | [`c71c694e1b55...`](https://stellar.expert/explorer/testnet/tx/c71c694e1b55d58460efabd370e7b8a15131341a2636a95276a9e6956b2e0790) |
| E: buyer approves the milestone | [`caec44f8ca2c...`](https://stellar.expert/explorer/testnet/tx/caec44f8ca2ccf9a97900978d066cb6601a01cf8c7dee320b094d9da84e90ae3) |
| E: guard records the approval | [`ecde5628e72f...`](https://stellar.expert/explorer/testnet/tx/ecde5628e72f021bbe35f48a928a0fae9a7b41635d0e22f905dab8bb71679a35) |
| E: seller opens a dispute | [`d4ef8f0202d9...`](https://stellar.expert/explorer/testnet/tx/d4ef8f0202d97576eb26b7e62a1f059794b2cfbb24fe9a3a264bb96e632e30a1) |
| E: guard records the dispute (the 120 s contest window opens) | [`7b62a062fcb3...`](https://stellar.expert/explorer/testnet/tx/7b62a062fcb37784e4830fc6ae6ea4fcc2670663bb7adbfa53b7add6513fa62d) |
| E: buyer calls `contest` on the guard inside the window | [`2974e98d4d64...`](https://stellar.expert/explorer/testnet/tx/2974e98d4d64069ea96ff8bfb550c1f1187c4c3154be29db20d60b4f9223504b) |
| E: after the window, dispute resolved with the whole balance to the buyer | [`e942b01cdb17...`](https://stellar.expert/explorer/testnet/tx/e942b01cdb1757c2cf09985ede9d17f321e64ed2ec7d8b9d456c023b83469f8b) |
| E: platform tops up the two escrow fees (5 XEUR), buyer nets 100% | [`e07ebbfb3de0...`](https://stellar.expert/explorer/testnet/tx/e07ebbfb3de0117a4a6f1ebf67f88eee1b445bc69b221862a387036461bce8a4) |

Refused paths, checked by enforce-mode simulation in the same run (not submitted), all with the
expected codes: A release with a wrong fee address (`BadFeeAddr` = 15), A release signed with the
resolver key (auth trap), B seller payout without a claim (`NoClaim` = 8), C break-glass to the
seller (`NotWholeToBuyer` = 13), D seller payout without a claim (`NoClaim` = 8), D before the delay
(`TooEarly` = 10), D with a tampered claim (`NoClaim` = 8), E seller payout while contested
(`Contested` = 25). The release before buyer approval was refused in record-mode simulation.

**TTL upkeep, read back from the ledger** (RPC `getLedgerEntries`, 29 Oct 2026; full readout in
[`runs/ttl-run-7.json`](runs/ttl-run-7.json)). Testnet's `minPersistentTtl` is 120,960 ledgers
(about 7 days), so without upkeep a new entry lives 7 days. At ledger 5448575 the guard v0.9
instance had 1,036,703 ledgers left (live until 6485278, extended at deploy, ledger 5448478) and
each of the five registrations A to E had 1,036,727 to 1,036,757 left: each was extended to
exactly 1,036,800 ledgers (60 days) by its first `register_escrow` (escrow A: live until 6485302,
set in ledger 5448502, the ledger of A's registration). For comparison, the run 4 guard (v0.8,
no upkeep) at ledger 5448577: instance 103,703 ledgers left and run 4 escrow A's registration
103,708 left, both at the network minimum from creation.

**Cost of the upkeep** (`fee_charged` from Horizon testnet): escrow A in run 7 totals 685,147
stroops (deploy+init 133,347; fund 107,507; first `register_escrow` 383,152; approve 6,654; second
`register_escrow` 11,919; anchor 22,267; release 20,301) against 346,497 for run 4's escrow A; the
difference is mostly the first registration's 60-day rent (383,152 against 50,416). The guard
deployment cost 106,688,213 stroops (about 10.7 XLM) against 89,960 in run 4, the 60-day rent on
its 22,541-byte code and instance, once per deployment and then again when it falls under 30 days.

**Change needed in the scripts for this run.** Since runs 4 to 6, testnet RPC simulation returns
the guard's auth entry as `sorobanCredentialsAddressV2` (CAP-71: the signed preimage also binds the
address) instead of `sorobanCredentialsAddress`. The first `testnet:e2e` attempt (escrow A0 above)
stopped at the release with `Expected XDR variant 'sorobanCredentialsAddress', got
'sorobanCredentialsAddressV2'`, after its first six transactions had landed. `Chain.signGuardEntry` in
`scripts/lib/soroban.ts` now signs whichever variant the simulator returns; every later guard
authorisation in this run went through V2 credentials. The guard contract was not involved (it
verifies the payload hash the host gives it).

| Step | Transaction |
|---|---|
| A0: escrow deploy+init | [`413795ac4e8f...`](https://stellar.expert/explorer/testnet/tx/413795ac4e8f1e5a0fe8997a37d6d39ada5b077afd6a6b087406969820ba8d58) |
| A0: buyer funds 100 XEUR | [`5a4fca367064...`](https://stellar.expert/explorer/testnet/tx/5a4fca367064e6445cb97dcf6b092acd562c4b3246786f6b8a55a2aa057a6b92) |
| A0: escrow registered | [`48ac8912e647...`](https://stellar.expert/explorer/testnet/tx/48ac8912e64771f91f79808249c554c1b815d4861da8abdf94727979284209ed) |
| A0: buyer approves the milestone | [`2cf86893834e...`](https://stellar.expert/explorer/testnet/tx/2cf86893834ebabe6cfe105bb63508e05b4e27a39b782287ad18a9bfe38686c9) |
| A0: guard records the approval | [`20f82d371507...`](https://stellar.expert/explorer/testnet/tx/20f82d3715079435c07273fa31465565a1e65cbf82a0a497e7644f5e4c723c82) |
| A0: delivery-claim batch anchored | [`70ec386985fb...`](https://stellar.expert/explorer/testnet/tx/70ec386985fb762c94459809762108fd8a917349f3839064f69ed199d6a2ebfc) |

Run logs: [`docs/runs/e2e-2026-10-29T09-30-46-390Z.json`](runs/e2e-2026-10-29T09-30-46-390Z.json),
[`docs/runs/e2e-claims-2026-10-29T09-34-42-235Z.json`](runs/e2e-claims-2026-10-29T09-34-42-235Z.json)
(public hashes only).

## Run 8: real Circle testnet EURC, guard v0.9, 29 Oct 2026, 11:56 to 12:05 UTC

Runs 1 to 7 used a lab-issued stand-in asset. Run 8 moves the same flows onto **Circle's testnet
EURC**: issuer `GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO` (source:
https://developers.circle.com/stablecoins/eurc-contract-addresses), its existing SAC
`CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ`. Nothing was issued by us: the buyer already held
20 EURC when `testnet:e2e` started (run log). A fresh deployment by
`npm run testnet:deploy -- --asset EURC:GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO --amount 2`
(29 Oct 2026, 11:19 UTC per `testnet-state.json`: new claim registry, guard v0.9 and escrow factory),
then `npm run testnet:e2e` (A, B, C), `npm run testnet:e2e-claims` (D, E) and
`npm run testnet:refusals` (fresh escrows A, B, C, E with four refusals landed). Orders of 2 EURC
(20,000,000 units at 7 decimals); platform fee 470 bps plus Trustless Work's 0.3%, so a released
2 EURC order pays the seller 1.9 EURC. Payout delay and contest window 120 s (production 7 days).
The delivered event came from the script's mock oracle. Guard Wasm sha256 recorded in
`testnet-state.json` for this deployment: `c3fe20557bcde3bea44b1cb74aa01efab00a46f52b3bd0ddb6f4c4c0f872fb22`
(the workspace 0.9.0 build of the v0.9 source); claim registry
`af18affa27b182c3d10ffb022fbd0d0bb2a9b7c0c825bbf0f33418d14a4e98a8` (unchanged since run 4).

| Contract | ID |
|---|---|
| Guard v0.9 | [`CAYLUEO3...RRXNQC`](https://stellar.expert/explorer/testnet/contract/CAYLUEO3PVSCBL4PPLIZV3QLRQ47HRONNUQ2M2PAZQSP5PRZRNRRXNQC) |
| Claim registry | [`CCLXA67O...Z7YC67`](https://stellar.expert/explorer/testnet/contract/CCLXA67OTSYDVGMKZI54S4YJE7JWS6UUEZCEM4JY4VEAS3SK5FZ7YC67) |
| Circle testnet EURC SAC | [`CCUUDM43...R4MCGZ`](https://stellar.expert/explorer/testnet/contract/CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ) |
| Escrow factory (Trustless Work testnet Wasm instance) | [`CBKKZGDH...CP5ZWU`](https://stellar.expert/explorer/testnet/contract/CBKKZGDH2QQJ2CW6EVYRTC5SL3YKPWP636PRQQO46B6G53SF63CP5ZWU) |
| `testnet:e2e` escrow A (release) | [`CCHHOYKT...S3QWDC`](https://stellar.expert/explorer/testnet/contract/CCHHOYKTIZI25FGQRDR2D7N46AVMUDBSWMUNIXPX3QOB5XTJ25S3QWDC) |
| `testnet:e2e` escrow B (dispute refund) | [`CBCTYELH...DE24FA`](https://stellar.expert/explorer/testnet/contract/CBCTYELHUZCHQNPRBO4AKZQZT6EQ23AQXQPPSEPPT2MQWGJNLFDE24FA) |
| `testnet:e2e` escrow C (partial funding, break-glass) | [`CCWN64DH...JGTNUU`](https://stellar.expert/explorer/testnet/contract/CCWN64DHJIEZ7W3W5F4ZN42ZGHLFWGZ55BMBHZRKPWM7CFEOSQJGTNUU) |
| `testnet:e2e-claims` escrow D (silent buyer, seller paid against the claim) | [`CC4DIT7Z...T3OHI6`](https://stellar.expert/explorer/testnet/contract/CC4DIT7ZMQVEVV323TADUFQUX6ROHGMA2OO2EPHEEWS7OGIECBT3OHI6) |
| `testnet:e2e-claims` escrow E (buyer contest, refund) | [`CD7AUG4B...DOMZ4S`](https://stellar.expert/explorer/testnet/contract/CD7AUG4BIHAQ2H7D5DH3AUA3K2T2HYCWILX4LLED4LIM7WINIGDOMZ4S) |
| `testnet:refusals` escrow A (wrong fee address, then release) | [`CDZVHRRN...YCYWQN`](https://stellar.expert/explorer/testnet/contract/CDZVHRRNRB7MVP6FEJNSP4FEZNZZNFPIT4UJVBDIZQT2CMOKJEYCYWQN) |
| `testnet:refusals` escrow B (seller payout without a claim, then refund) | [`CAAJVNXH...5H7PR3`](https://stellar.expert/explorer/testnet/contract/CAAJVNXHKTAZVISY5BHRRB4L7OSDADCQ2J5ENGZN2QXIMGCBA45H7PR3) |
| `testnet:refusals` escrow C (break-glass to the seller, then refund) | [`CADW4SHZ...Z6A5IR`](https://stellar.expert/explorer/testnet/contract/CADW4SHZ5MPZ27BRPXOR6CDONDIL6WKTXRLTRG67GRTGKNVLHCZ6A5IR) |
| `testnet:refusals` escrow E (seller payout during the buyer contest, then refund) | [`CCWJVH7L...Y2P6PV`](https://stellar.expert/explorer/testnet/contract/CCWJVH7LVB6GJ7ES2SZUC43ORVP2ESKDKYAWL6DCOHTX5RHKHVY2P6PV) |

The deployment transactions (trustlines, registry and guard upload and deploy, escrow factory) were
not kept in a run log, so they are not listed here; the contract IDs above are the ones the three
scripts read from `testnet-state.json` and printed in their run headers.

Failed transactions (refusals landed on the ledger in EURC, as in run 6; each code confirmed from the
ledger's diagnostic events by the script):

| Refused payout | Guard error | Failed transaction |
|---|---|---|
| A: release with a wrong `trustless_work_address` (fee account not the pinned one) | `Error(Contract, #15)` `BadFeeAddr` | [`022d839874bc...`](https://stellar.expert/explorer/testnet/tx/022d839874bcaa81628a91e9c954c6f9f1aca58fc061f7f35405736d338a8f51) |
| B: resolver pays the seller with no delivery claim and no buyer approval | `Error(Contract, #8)` `NoClaim` | [`c7a8fa917f05...`](https://stellar.expert/explorer/testnet/tx/c7a8fa917f052ee9648f312813e0e9ce76d18466778b59782000d12aee1ccfa8) |
| C: break-glass key pays the seller | `Error(Contract, #13)` `NotWholeToBuyer` | [`a2923c617fea...`](https://stellar.expert/explorer/testnet/tx/a2923c617feaf3a5f163ed4d5c0d2ec714b68889be7ba0e9fcb48971e52d854c) |
| E: seller payout while the buyer's contest stands | `Error(Contract, #25)` `Contested` | [`e949dfc17f20...`](https://stellar.expert/explorer/testnet/tx/e949dfc17f20acb9a534e05626b813ca35cc1574295eb0d00b809b98cfb30183) |

`npm run testnet:e2e` (A, B, C):

| Step | Transaction |
|---|---|
| Wrong-fee-address account (`third`) given 0.0001 EURC dust by the buyer, as the stand-in deploy does for XEUR | [`60840a2044f6...`](https://stellar.expert/explorer/testnet/tx/60840a2044f6b43450f5e0a00f19486f6f7cfcd6f70502d33b9396571280ffe2) |
| A: escrow deploy+init through the Trustless Work deployer | [`973e3049553d...`](https://stellar.expert/explorer/testnet/tx/973e3049553d85e3a77e3e2bda03d1941ddefa3e01032f6b088b7ed567f7644a) |
| A: buyer funds 2 EURC | [`1b9d8517f2bd...`](https://stellar.expert/explorer/testnet/tx/1b9d8517f2bd11fe910eddf0caea57c335e0cef9f075eeb120d2e9c6d4030bf1) |
| A: escrow registered with the guard | [`f1ed87bfc461...`](https://stellar.expert/explorer/testnet/tx/f1ed87bfc46156232dd6541b9ff251327755f153f7163018bd06932f0985d9f5) |
| A: buyer approves the milestone | [`cc174396ae7e...`](https://stellar.expert/explorer/testnet/tx/cc174396ae7ec0e868066dbd2737ec3bd8a29febbb239499e1626b77f70ea170) |
| A: guard records the approval | [`3ad7b4ffd512...`](https://stellar.expert/explorer/testnet/tx/3ad7b4ffd5127b71d53cbe4a892ba61fa094076dd93defb8641711fba311c6c5) |
| A: delivery-claim batch anchored in the registry (proof depth 3) | [`e256804762d8...`](https://stellar.expert/explorer/testnet/tx/e256804762d82f46912b04e8f6e3c57cee4758af21c84e3c7d3241f5bcc73a68) |
| A: release through the guard (3,112,582 instructions in simulation); seller received 1.9 EURC, claim re-check ok | [`3466197bcabc...`](https://stellar.expert/explorer/testnet/tx/3466197bcabc189580f3fd56eedb141f6bfac3dde177d814833a03fe9a0b8efc) |
| B: escrow deploy+init through the Trustless Work deployer | [`36a3841887b4...`](https://stellar.expert/explorer/testnet/tx/36a3841887b4f92392811704168acc20fd67f392fb64eda4fc09e5b4602ee702) |
| B: buyer funds 2 EURC | [`1ad525875a1c...`](https://stellar.expert/explorer/testnet/tx/1ad525875a1c17fc185ab2cc16459721803960b62c0ef30518a20f5dd6d29173) |
| B: escrow registered with the guard | [`636e183338f6...`](https://stellar.expert/explorer/testnet/tx/636e183338f66d17e63dc00740e7098470c76833f8e8694a571ef4aa22093698) |
| B: buyer opens a dispute | [`2c09eb37e6f5...`](https://stellar.expert/explorer/testnet/tx/2c09eb37e6f5229ff01c34c2df6c2fc27ca381d73bb6c366803f42b950b960de) |
| B: guard records the dispute | [`1cc0958aa310...`](https://stellar.expert/explorer/testnet/tx/1cc0958aa31057d1a2d4f11b0185ef6895ee411644697fee7ff3ad4b2ef5ee85) |
| B: dispute resolved, whole balance to the buyer | [`c6088f8efd2b...`](https://stellar.expert/explorer/testnet/tx/c6088f8efd2b2ba4a504a00345b26debe68f6abd82b88ffcde86235328441a2a) |
| B: platform tops up the two escrow fees (0.1 EURC), buyer nets 100% | [`70fb50cabba0...`](https://stellar.expert/explorer/testnet/tx/70fb50cabba097cb43b2928379788e1de192f5c51accc697cec18b38ebcbc285) |
| C: escrow deploy+init through the Trustless Work deployer | [`02e7a77fa999...`](https://stellar.expert/explorer/testnet/tx/02e7a77fa9992f9ec0be446936bae395e59ce1f3e64b394a42e0a632657039df) |
| C: buyer funds 0.8 EURC (40%) | [`59f7197b5246...`](https://stellar.expert/explorer/testnet/tx/59f7197b52466e3571cbfcb6ca68dec3b13447f643ea27f76d6bef13443214e5) |
| C: escrow registered at 40% funding | [`0d4d49cc50cf...`](https://stellar.expert/explorer/testnet/tx/0d4d49cc50cf43cce69406b0b3ba80fe93658e44e8b1b6064fd785ea080312ab) |
| C: platform opens a dispute | [`f324d9aad30a...`](https://stellar.expert/explorer/testnet/tx/f324d9aad30a76a23cde354fb5965304f4e0a3b2094de2f7d49e33365df65953) |
| C: break-glass refund, whole balance (0.8 EURC) to the buyer | [`1daf45e08a95...`](https://stellar.expert/explorer/testnet/tx/1daf45e08a95a6c426ce3f6c4b010871672a3cac3f2c13337871596bcbd63611) |
| C: platform tops up the two escrow fees (0.04 EURC), buyer nets 100% | [`44fc124b31be...`](https://stellar.expert/explorer/testnet/tx/44fc124b31bec7607ff26f756461f926d9d9a83c8391b306a0375a8969d8afb8) |

`npm run testnet:e2e-claims` (D, E):

| Step | Transaction |
|---|---|
| D: escrow deploy+init through the Trustless Work deployer | [`b6057e097399...`](https://stellar.expert/explorer/testnet/tx/b6057e097399e203bfe09d14b0adf4f61004c311f64bbd20345986fc05839720) |
| D: buyer funds 2 EURC, then stays silent | [`5df72e8d77c6...`](https://stellar.expert/explorer/testnet/tx/5df72e8d77c66b3c41dbbd7b85cdec1b3af402f29edc255145f6d6c2ad672460) |
| D: escrow registered with the guard (records full funding) | [`c89f145a7375...`](https://stellar.expert/explorer/testnet/tx/c89f145a7375d7b7b1eab3b821553f14635fe5098e3bf96bf6d9f03752453fd6) |
| D: platform opens a dispute | [`26ac406e9b2b...`](https://stellar.expert/explorer/testnet/tx/26ac406e9b2b7bca512b7058fb5c53ef209c05b77cf3ca8b9f285ca0b991c10c) |
| D: guard records the dispute | [`ae483092a29f...`](https://stellar.expert/explorer/testnet/tx/ae483092a29fcddf07524fb4ac7a28265db4fca31e8c4147de7c44a43f69e519) |
| D: delivery-claim batch anchored in the registry (proof depth 32) | [`1bb2d1c46bfa...`](https://stellar.expert/explorer/testnet/tx/1bb2d1c46bfa399a15e670ea1db6551297ad68f1676c332426bd0d00c2978c95) |
| E: escrow deploy+init through the Trustless Work deployer | [`27c99853ece9...`](https://stellar.expert/explorer/testnet/tx/27c99853ece9042afcfa6a2a555c58d09058b4f4e5bf7c0b282ec6a1473a374a) |
| E: buyer funds 2 EURC | [`f57613487320...`](https://stellar.expert/explorer/testnet/tx/f5761348732003dcea0177a79a0b5240a691bbf17cab99014148899e7d0350bb) |
| E: escrow registered with the guard (records full funding) | [`05d18ced89cc...`](https://stellar.expert/explorer/testnet/tx/05d18ced89cc06857fadd19e3152739d33bff9e5d7e549a51dd0c438576ac0dd) |
| E: buyer approves the milestone | [`71ff1742c824...`](https://stellar.expert/explorer/testnet/tx/71ff1742c824e4514a3ce8243ddad431628ac7cb518e2f205f2eb37112ee9a33) |
| E: guard records the approval | [`775290718539...`](https://stellar.expert/explorer/testnet/tx/7752907185392641645f8fbf25fc8927dc0cfe541b980e339076dc8cb8a4bedb) |
| E: seller opens a dispute | [`5faa1bbab58a...`](https://stellar.expert/explorer/testnet/tx/5faa1bbab58aa8a83811e9ccff41bfdc09c0388d50dfc54fbbb5ddf68e694140) |
| E: guard records the dispute (the 120 s contest window opens) | [`9f77112eefb8...`](https://stellar.expert/explorer/testnet/tx/9f77112eefb82132e1f2e9d4d1b52c18a5f7a4e243ca074038e4c57b9d52aefb) |
| E: buyer calls `contest` on the guard inside the window | [`b40383b5db3f...`](https://stellar.expert/explorer/testnet/tx/b40383b5db3f8f25c58c7c86ea9c69246424684aa1a0b5f2d8d0d4ae86847954) |
| D: after the 120 s delay, seller paid through `resolve_dispute` against the claim; the guard verified the depth-32 proof in `__check_auth` (4,996,998 instructions in simulation); seller received 1.9 EURC, claim re-check ok | [`3cc5632805b0...`](https://stellar.expert/explorer/testnet/tx/3cc5632805b02b00e79d16c861d8dd3886aa5956ca3adb56afcb5240cc324326) |
| E: dispute resolved, whole balance to the buyer | [`639c61719f35...`](https://stellar.expert/explorer/testnet/tx/639c61719f35d2152abee74524d784e28028e936dce0b9d39ba2866b0269930a) |
| E: platform tops up the two escrow fees (0.1 EURC), buyer nets 100% | [`63d22b6b5311...`](https://stellar.expert/explorer/testnet/tx/63d22b6b53117a8a3ad78aa596311f8e34a824f625892682d17184baeb0be8b3) |

`npm run testnet:refusals` (fresh escrows A, B, C, E):

| Step | Transaction |
|---|---|
| A: escrow deploy+init through the Trustless Work deployer | [`0499174a8033...`](https://stellar.expert/explorer/testnet/tx/0499174a8033adf150c8009965bd3d2e53e571dc29c7b3fa0deb710491a94f94) |
| A: buyer funds 2 EURC | [`0cb8a103f76c...`](https://stellar.expert/explorer/testnet/tx/0cb8a103f76cfc9ac8a78b0e175bb234e973e8f7a8cc143604cdd74a30770fff) |
| A: escrow registered with the guard | [`b10a684012b0...`](https://stellar.expert/explorer/testnet/tx/b10a684012b0bab5aad92749d99ce009b1372d6466b900c84d835894676a6f88) |
| A: buyer approves the milestone | [`0c86bf58f549...`](https://stellar.expert/explorer/testnet/tx/0c86bf58f5498173f6642951e6ef1c6ea1ed1662111e23a3c8a69c9d38b2f52a) |
| A: guard records the approval | [`d52b904f4809...`](https://stellar.expert/explorer/testnet/tx/d52b904f48093f1d8d33314fb356cc895ea94d92ff689efae26e788f2cf17095) |
| **A: FAILED on chain.** `release_funds` with a wrong `trustless_work_address`: `Error(Contract, #15)` `BadFeeAddr` | [`022d839874bc...`](https://stellar.expert/explorer/testnet/tx/022d839874bcaa81628a91e9c954c6f9f1aca58fc061f7f35405736d338a8f51) |
| A: then `release_funds` with the pinned fee address pays the seller | [`d88fead42b59...`](https://stellar.expert/explorer/testnet/tx/d88fead42b5978d08b1c98e04af9706a53206c123c36f302cd9f6291664ec82c) |
| B: escrow deploy+init through the Trustless Work deployer | [`bc6324bc0db3...`](https://stellar.expert/explorer/testnet/tx/bc6324bc0db374bf9d45bfc5c99795e3f0069881639ff7f59f5fe45f83324e26) |
| B: buyer funds 2 EURC | [`69d610bd30ca...`](https://stellar.expert/explorer/testnet/tx/69d610bd30ca5fb4898401c89138363d98ada8ac0831820fa7d56d3a8ff2c738) |
| B: escrow registered with the guard | [`24addb60cc79...`](https://stellar.expert/explorer/testnet/tx/24addb60cc7902d3b051646371aa65876bda4b9ae319ecd641bf0e219eee7a89) |
| B: buyer opens a dispute | [`c5b2a0d07bce...`](https://stellar.expert/explorer/testnet/tx/c5b2a0d07bce8e36bd1e88079c95b2f5eff5b4a9bf1fc2f8e246c5c90c7c6092) |
| B: guard records the dispute | [`046ca72062bf...`](https://stellar.expert/explorer/testnet/tx/046ca72062bfb79e49850e8bf89cc42659605f8f2fcc4625871be976d52b3110) |
| **B: FAILED on chain.** `resolve_dispute` paying the seller without a delivery claim (and without buyer approval), signed with the resolver key: `Error(Contract, #8)` `NoClaim` | [`c7a8fa917f05...`](https://stellar.expert/explorer/testnet/tx/c7a8fa917f052ee9648f312813e0e9ce76d18466778b59782000d12aee1ccfa8) |
| B: dispute resolved, whole balance to the buyer | [`826c754c3678...`](https://stellar.expert/explorer/testnet/tx/826c754c36780149e5a7fba22b5ed927ef34be4fdd340a25a236dbc6a66bb8c6) |
| B: platform tops up the two escrow fees (0.1 EURC), buyer nets 100% | [`3b1308782050...`](https://stellar.expert/explorer/testnet/tx/3b1308782050da6f500f7db473da88f67c9fe2d23e2b9887edeb10b54c9aeed9) |
| C: escrow deploy+init through the Trustless Work deployer | [`7160a8bd4a6c...`](https://stellar.expert/explorer/testnet/tx/7160a8bd4a6c4df3e8a991d72671a9f121d823fcd7f93b564f0d77e49f71e20b) |
| C: buyer funds 0.8 EURC (40%) | [`5b7f3c40477d...`](https://stellar.expert/explorer/testnet/tx/5b7f3c40477d7b2082ec08a60ca674d68a5cff806628e1d874f92d37f1b246cf) |
| C: escrow registered at 40% funding | [`846237acaeae...`](https://stellar.expert/explorer/testnet/tx/846237acaeae85da3cd85c91400c143c986d0b14d5111c831f8d6b42b19f862d) |
| C: platform opens a dispute | [`c934d201f4ae...`](https://stellar.expert/explorer/testnet/tx/c934d201f4ae82e1ab0c28a3787064cd69a6ff54be5ea081a2dd48b135a5d68f) |
| **C: FAILED on chain.** break-glass key tries `resolve_dispute` paying the seller: `Error(Contract, #13)` `NotWholeToBuyer` | [`a2923c617fea...`](https://stellar.expert/explorer/testnet/tx/a2923c617feaf3a5f163ed4d5c0d2ec714b68889be7ba0e9fcb48971e52d854c) |
| C: break-glass refund, whole balance (0.8 EURC) to the buyer | [`e4c7c94bb2e2...`](https://stellar.expert/explorer/testnet/tx/e4c7c94bb2e2bc2813e63cd95945cdb090d24b5006a584f5b72ce058165beb3c) |
| C: platform tops up the two escrow fees (0.04 EURC), buyer nets 100% | [`b154f8939aa9...`](https://stellar.expert/explorer/testnet/tx/b154f8939aa98879f98d71436720580f13687b70bcf87e7fba7d92d417faffbd) |
| E: escrow deploy+init through the Trustless Work deployer | [`767819ee0438...`](https://stellar.expert/explorer/testnet/tx/767819ee0438d5dcfc85840e1e82e1a9dd380ae4996f17e442c706f952eb8c6d) |
| E: buyer funds 2 EURC | [`30d8c63801bb...`](https://stellar.expert/explorer/testnet/tx/30d8c63801bbf26b233e7fafa0cc3fb71cd80d542100f33fe100eaf7f76437da) |
| E: escrow registered with the guard (records full funding) | [`e24c686e9921...`](https://stellar.expert/explorer/testnet/tx/e24c686e9921c580921513456b5b57262e95d10678ef33a3f84b6490b6fafbaf) |
| E: buyer approves the milestone | [`06a12e383dc6...`](https://stellar.expert/explorer/testnet/tx/06a12e383dc6dd101fa122f670a33f18680f928b07e9f532054c35be8e08e5f6) |
| E: guard records the approval | [`67fb12e65108...`](https://stellar.expert/explorer/testnet/tx/67fb12e65108a62b0247d8f4ad3b293b37de87a1dd1b5f7e8f6bf4c7f7507465) |
| E: seller opens a dispute | [`9b754501b6fc...`](https://stellar.expert/explorer/testnet/tx/9b754501b6fcad697308a600c7c00dac3e59763508c773ea5c21cb2d0feea577) |
| E: guard records the dispute (the 120 s contest window opens) | [`aec28f5e7e03...`](https://stellar.expert/explorer/testnet/tx/aec28f5e7e03c01208be727725ff32e703f5ac42a14afbe6f92f6114616f3cc7) |
| E: buyer calls `contest` on the guard inside the window | [`73587fb6c809...`](https://stellar.expert/explorer/testnet/tx/73587fb6c8096206f8a05368ea4dae84332a61f00ce227e5556503288ee93101) |
| **E: FAILED on chain.** seller payout through `resolve_dispute` while the buyer's contest stands, signed with the resolver key: `Error(Contract, #25)` `Contested` | [`e949dfc17f20...`](https://stellar.expert/explorer/testnet/tx/e949dfc17f20acb9a534e05626b813ca35cc1574295eb0d00b809b98cfb30183) |
| E: dispute resolved, whole balance to the buyer | [`035180159ee3...`](https://stellar.expert/explorer/testnet/tx/035180159ee3459bf0f30a73ad8ecf8f5a59bb1412db5296e00ec604df21216b) |
| E: platform tops up the two escrow fees (0.1 EURC), buyer nets 100% | [`477b2e4f1801...`](https://stellar.expert/explorer/testnet/tx/477b2e4f1801e1d131807155e97b712ba0af958d48aff389abfd2f06723833dc) |

Refused paths checked by enforce-mode simulation in `testnet:e2e` and `testnet:e2e-claims` (not
submitted), all with the expected codes: A release with a wrong fee address (`BadFeeAddr` = 15), A
release signed with the resolver key (auth trap, `Error(Auth, InvalidAction)`), B seller payout
without a claim (`NoClaim` = 8), C break-glass to the seller (`NotWholeToBuyer` = 13), D seller payout
without a claim (`NoClaim` = 8), D before the delay (`TooEarly` = 10), D with a tampered claim
(`NoClaim` = 8), E seller payout after the window while contested (`Contested` = 25). The release
before buyer approval was refused in record-mode simulation. Every refunded buyer netted the full
amount after the platform top-up (2 EURC for B and E, 0.8 EURC for C), and the script's summary for
D and E reads `silentBuyerPayoutLanded`, `claimRecheckOk`, `contestBlockedSellerPayout` and
`buyerRefunded` all true.

Claim re-check after the run (`npm run claims:recheck -- --from-state`, 29 Oct 2026, against live
testnet RPC): escrow D's depth-32 claim (batch `1793275117062`) and, with `--index 0`, escrow A's
claim (batch `1793274996744`) both return `ok: true`, `registryVerify: true` and
`anchoredAfterFunding: true`.

Run logs: [`docs/runs/e2e-2026-10-29T11-58-05-865Z.json`](runs/e2e-2026-10-29T11-58-05-865Z.json),
[`docs/runs/e2e-claims-2026-10-29T12-02-05-442Z.json`](runs/e2e-claims-2026-10-29T12-02-05-442Z.json),
[`docs/runs/refusals-2026-10-29T12-05-06-590Z.json`](runs/refusals-2026-10-29T12-05-06-590Z.json)
(public hashes only).

## Run 9: guard v0.10 on Circle testnet EURC, 29 Oct 2026, 19:03 to 19:10 UTC

Runs 4 to 8 ran guard v0.8 or v0.9; v0.10 had only been unit-tested. Run 9 deploys **guard v0.10**
(the v0.9 rules plus the seller payout no buyer leg can block, the platform fee cap and
mainnet-sized TTL upkeep) and a fresh claim registry v0.10 with
`npm run testnet:deploy -- --asset EURC:GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO --amount 2`
(29 Oct 2026, 19:03 UTC per `testnet-state.json`; `Cfg.max_platform_fee_bps` = 500, the deploy
default), then runs `npm run testnet:e2e` (A, B, C) and the new `npm run testnet:v010` (F, W). Same
runtime keys and the same Circle testnet EURC as run 8; the buyer held 13.9999 EURC on Horizon
testnet before the run (11.9999 when `testnet:v010` started), so 2 EURC orders were used. Platform
fee 470 bps plus Trustless Work's 0.3%, so a 2 EURC order pays the seller 1.9 EURC. Payout delay and
contest window 120 s (production 7 days). The delivered events came from the scripts' mock oracle.
Optimised Wasm sha256 as built and uploaded: guard v0.10
`2a21ef35e57f8505861296e2b93a09c5aa2117c66a5fb5d3d2cbcefe3087fbb5` (22,664 bytes), claim registry v0.10
`e829dc52672dbc8aebca65c6595416ca2b8fba5b787a575e4a487dda3d808870` (4,161 bytes).

What run 9 adds to runs 4 to 8, all on v0.10:

1. **A buyer-approved release** (`testnet:e2e` A): fund, register, buyer approval, release through
   the guard's Release key; the seller received 1.9 EURC.
2. **The seller-only `withdraw_remaining_funds` dispute payout** (`testnet:v010` W), in the
   dust/no-trustline scenario v0.10 was written for: a throwaway buyer account funds the escrow and
   then removes its EURC trustline, and 1 unit of dust is sent to the escrow, so every
   `resolve_dispute` would need a buyer leg (enforce-mode simulation: the token refuses with its own
   `Error(Contract, #13)`, the SAC's missing-trustline error, in record mode). After the claim's
   120 s delay the resolver pays the seller alone through `withdraw_remaining_funds`; the dust stays
   for the buyer and the registration closes, so a second seller withdrawal is refused
   (`Closed` = 17, simulation).
3. **The platform fee cap as a failed transaction** (`testnet:v010` F1): an escrow created at 501 bps
   fails `check_escrow` by simulation and its `register_escrow`, landed on purpose, FAILED on the
   ledger with `Error(Contract, #29)` `PlatformFeeOverCap` (confirmed from the ledger's diagnostic
   events by the script). An escrow at exactly 500 bps (F2) passes and registers.

| Contract | ID |
|---|---|
| Guard v0.10 (platform fee cap 500 bps) | [`CCRZHNU2...J2KVUZ`](https://stellar.expert/explorer/testnet/contract/CCRZHNU2CHN62BXALEFHAJEX57AURBB7OWYM37I7JSO7HLALHVJ2KVUZ) |
| Claim registry v0.10 | [`CC6K26NQ...Q5FBDX`](https://stellar.expert/explorer/testnet/contract/CC6K26NQGSD3UAIUS463ZJCEC7SGEF6V5R34OYZX3WHY6URFTKQ5FBDX) |
| Circle testnet EURC SAC (as run 8) | [`CCUUDM43...R4MCGZ`](https://stellar.expert/explorer/testnet/contract/CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ) |
| Escrow factory (Trustless Work testnet Wasm instance) | [`CCOAVZCG...SI3ZSC`](https://stellar.expert/explorer/testnet/contract/CCOAVZCGPYMDUZXRDBDG5Z3EAVS4HQAYSMXAQZA7YK3Q7Q5TYJSI3ZSC) |
| `testnet:e2e` escrow A (buyer-approved release) | [`CAN3PEKN...364CMD`](https://stellar.expert/explorer/testnet/contract/CAN3PEKNDM3HIXGAYZSRGWJ66ENF2IBDS67UZITMP3SQXA5PB4364CMD) |
| `testnet:e2e` escrow B (dispute refund) | [`CAKCR5RP...2SYQMJ`](https://stellar.expert/explorer/testnet/contract/CAKCR5RPGPYMDI2ER4VZPWUXBXMQEMZ6YX3MLUSZDX4H2UNBUM2SYQMJ) |
| `testnet:e2e` escrow C (partial funding, break-glass) | [`CCQDLJRW...SXQD6Q`](https://stellar.expert/explorer/testnet/contract/CCQDLJRWFAFVCSYA6GXB5ATQWCW2J5FYC6TIZWV4M6HVEF2VBTSXQD6Q) |
| `testnet:v010` escrow F1 (platform fee 501 bps, over the cap; never registered) | [`CBLCRKZJ...4FEPM7`](https://stellar.expert/explorer/testnet/contract/CBLCRKZJW74SGSF33QGETRI7S67CHPTPEAD5DRGW2N4U2XUETX4FEPM7) |
| `testnet:v010` escrow F2 (platform fee 500 bps, at the cap; registered at 1 unit of dust) | [`CBFQGF4U...BJC5J2`](https://stellar.expert/explorer/testnet/contract/CBFQGF4U4JGHAHCHFMS24UZ43IBU4Z2SWHMCEFPCBP7MAFQVRRBJC5J2) |
| `testnet:v010` escrow W (seller paid alone past a buyer with no trustline) | [`CCFF7GHT...6FRHRM`](https://stellar.expert/explorer/testnet/contract/CCFF7GHTZ7QFR33MNNQHVCMKDWKU3BSQCTMTN4U5LY65UH5T2Q6FRHRM) |

Deployment (`npm run testnet:deploy`):

| Step | Transaction |
|---|---|
| Trustlines (already present, re-asserted): buyer, seller, platform, twFee, third | [`3be6a7a902e5...`](https://stellar.expert/explorer/testnet/tx/3be6a7a902e526b1838c108882e742dd2f4d9b90cf9a2089cdd6f44b6b87c1c2), [`7ed415581dcd...`](https://stellar.expert/explorer/testnet/tx/7ed415581dcd436e715fb0691dc572571b2d20a8b0c4582784c28474a75cbcad), [`0a66e4d6774e...`](https://stellar.expert/explorer/testnet/tx/0a66e4d6774ec31c5934dc2cf93291b9b7009a3fbe881bda11c08c102f694204), [`dbff2d8edade...`](https://stellar.expert/explorer/testnet/tx/dbff2d8edade24a98354f92711b36ddc89957f18adc9314c5cfc0593c76f7c28), [`57b77d6d30a1...`](https://stellar.expert/explorer/testnet/tx/57b77d6d30a155dc5537460aa4cbd7ff22971f88ae235e41c455fc52e9eb60d0) |
| Claim registry v0.10 Wasm upload (fee-bump) | [`5c1e26a0c21c...`](https://stellar.expert/explorer/testnet/tx/5c1e26a0c21c0d872194ec839bf6cb5aff73b4e68ba2283776f51d5e41cb168d) |
| Claim registry deploy | [`0cae9fa697c5...`](https://stellar.expert/explorer/testnet/tx/0cae9fa697c560b2a56b093a25b000ed613ac9388f24b03cdfd18dc32b710e76) |
| Guard v0.10 Wasm upload (fee-bump) | [`004683bdbdc6...`](https://stellar.expert/explorer/testnet/tx/004683bdbdc6a1e1298c2eb98c2554498948fc6c0e9418f6afd04fa6f804c89f) |
| Guard deploy, `Cfg.max_platform_fee_bps` = 500 | [`8592b762278f...`](https://stellar.expert/explorer/testnet/tx/8592b762278f0ccb20f8362660be22c53e9cab8406cfa3c6a3ee4a2e453b69db) |
| Escrow factory deploy (Trustless Work testnet Wasm instance) | [`d92242881f99...`](https://stellar.expert/explorer/testnet/tx/d92242881f99e1bf37b16a57818eedbfc7b0432eff588034add2d6c39451efc3) |

Failed transaction (refusal landed on the ledger in EURC; code confirmed from the ledger's diagnostic events by the script):

| Refused call | Guard error | Failed transaction |
|---|---|---|
| F1: `register_escrow` of an escrow whose `platform_fee` (501 bps) is above `max_platform_fee_bps` (500) | `Error(Contract, #29)` `PlatformFeeOverCap` | [`54a5c520f859...`](https://stellar.expert/explorer/testnet/tx/54a5c520f8597780074919bbe09a4d8349ebafc8988f5bca733bd29c8dd65e4c) |

`npm run testnet:e2e` (A, B, C):

| Step | Transaction |
|---|---|
| A: escrow deploy+init through the Trustless Work deployer | [`8f727e83f54a...`](https://stellar.expert/explorer/testnet/tx/8f727e83f54a596bb81652868313043dc61199f15cc3643c0c3d9ef664e44435) |
| A: buyer funds 2 EURC | [`079f5b4bab2d...`](https://stellar.expert/explorer/testnet/tx/079f5b4bab2d2bf04e8022c540be9ef9ec02202a248606912ef5e536a5496964) |
| A: escrow registered with the guard | [`57d9793848ee...`](https://stellar.expert/explorer/testnet/tx/57d9793848ee31d7e7470f9cc02d745b4e1b1a7c6b747283033f4ad4ef25ea20) |
| A: buyer approves the milestone | [`cc7e01754d55...`](https://stellar.expert/explorer/testnet/tx/cc7e01754d55436ef459f0af5a8ebc26cadcdce31ba1bd5ab2d371436d19303e) |
| A: guard records the approval | [`a6c71f702a73...`](https://stellar.expert/explorer/testnet/tx/a6c71f702a73a4c100e6a2948d5c40ebcb2f9b30d0ff6b95c1d2c367a344c907) |
| A: delivery-claim batch anchored in the registry (proof depth 3) | [`503cfed12fba...`](https://stellar.expert/explorer/testnet/tx/503cfed12fba7df67b7f54ed1b2bd1f568ab2fb4b452646394608a0643420914) |
| **A: buyer-approved release through the guard v0.10** (3,109,456 instructions in simulation); seller received 1.9 EURC, claim re-check ok | [`f2cdbd2c87eb...`](https://stellar.expert/explorer/testnet/tx/f2cdbd2c87eb0d525efce66bd73d8e179afbfb50e5ac735a9c33b88a9e355618) |
| B: escrow deploy+init through the Trustless Work deployer | [`481673ac9457...`](https://stellar.expert/explorer/testnet/tx/481673ac9457edbbd7891babdd0efb3d3939a6becb41ae061985ec1fc74e8d2a) |
| B: buyer funds 2 EURC | [`6f5dc9b4707a...`](https://stellar.expert/explorer/testnet/tx/6f5dc9b4707a8862b4d492ccb9497b2129a91cf8da248bb4c01f279bb1f18f76) |
| B: escrow registered with the guard | [`40b252bd00f4...`](https://stellar.expert/explorer/testnet/tx/40b252bd00f47999705a92c74eb70e9992f765705d6488ae7a2b4a1f3fe4d3ad) |
| B: buyer opens a dispute | [`fd4e573eba2b...`](https://stellar.expert/explorer/testnet/tx/fd4e573eba2b071f2bde6a110eb4a645f02b3eb6e68f48dc7712878ac5724126) |
| B: guard records the dispute | [`79455a6f72a4...`](https://stellar.expert/explorer/testnet/tx/79455a6f72a434308ad525273f10e1df27b73fc1db49f8f132cfc5082a560656) |
| B: dispute resolved, whole balance to the buyer | [`4f800790d4cc...`](https://stellar.expert/explorer/testnet/tx/4f800790d4ccdf91e7d56e4d304b5a9cf663e7df3e7e309348d24d03de155771) |
| B: platform tops up the two escrow fees (0.1 EURC), buyer nets 100% | [`0685ca6f402d...`](https://stellar.expert/explorer/testnet/tx/0685ca6f402d5d03e3736f238b054b8d9c76d60b553555ac672bed3fee82887c) |
| C: escrow deploy+init through the Trustless Work deployer | [`535cfc206464...`](https://stellar.expert/explorer/testnet/tx/535cfc206464010c0c021228ef8cafc6cf009bcdf76f6b37d2ee0388d46155fa) |
| C: buyer funds 0.8 EURC (40%) | [`5ce244d537b1...`](https://stellar.expert/explorer/testnet/tx/5ce244d537b11441eaa60bfbda10e3bbf8919d7d178c3b444c343dd14a952b29) |
| C: escrow registered at 40% funding | [`0884c1e9c15a...`](https://stellar.expert/explorer/testnet/tx/0884c1e9c15a0b354af43c3f3633935a5cbaa441d70c8211abaf775826eed67e) |
| C: platform opens a dispute | [`f25a1c5d775a...`](https://stellar.expert/explorer/testnet/tx/f25a1c5d775a510479e673e7901dc7fca21af9be84b49c3566d787e8009a4a56) |
| C: break-glass refund, whole balance (0.8 EURC) to the buyer | [`19da3f4077e3...`](https://stellar.expert/explorer/testnet/tx/19da3f4077e39f0a83b0a90e3986ff156fb8113dd3c84ce2f3110851e7c91ae4) |
| C: platform tops up the two escrow fees (0.04 EURC), buyer nets 100% | [`5acbd45ebe3c...`](https://stellar.expert/explorer/testnet/tx/5acbd45ebe3c51ca98df4ae6280a0ce09cd6a436aefd16eb0290f772f41c8548) |

`npm run testnet:v010` (F, W):

| Step | Transaction |
|---|---|
| F1: escrow deploy+init with `platform_fee` 501 bps (one over the cap); `check_escrow` by simulation refuses it with `Error(Contract, #29)` | [`1d5996b27d9c...`](https://stellar.expert/explorer/testnet/tx/1d5996b27d9cad43eed437ba0787def3160580ecc966c4fa7a6abde5b1e52d03) |
| **F1: FAILED on chain.** `register_escrow` of the over-cap escrow: `Error(Contract, #29)` `PlatformFeeOverCap`; `registration(F1)` stays empty, so no guard branch can pay out of it | [`54a5c520f859...`](https://stellar.expert/explorer/testnet/tx/54a5c520f8597780074919bbe09a4d8349ebafc8988f5bca733bd29c8dd65e4c) |
| F2: escrow deploy+init with `platform_fee` 500 bps (exactly the cap); `check_escrow` passes | [`c60496945470...`](https://stellar.expert/explorer/testnet/tx/c60496945470a85bc1890c407ab526a066ec70c9454ed20a817f38b1ed5bb86d) |
| F2: buyer sends 1 unit (0.0000001 EURC) so the escrow can register | [`4990db059e85...`](https://stellar.expert/explorer/testnet/tx/4990db059e8550d3e594f0107e179b2ec5a954f9d7afb62f32434d728cd853eb) |
| F2: `register_escrow` at the cap succeeds | [`1bd128eb6dea...`](https://stellar.expert/explorer/testnet/tx/1bd128eb6dea7367d386c31c4bbbddc7a029b2a3b77d8438af0538d853175579) |
| W: throwaway buyer account (`GBQ542QM...3NCXY4`, friendbot-funded) adds the EURC trustline | [`727cf3ab15b1...`](https://stellar.expert/explorer/testnet/tx/727cf3ab15b1cc83e8dfae5e97e4f1bd8aa7165fc29bf33fadd98a5299583b9c) |
| W: buyer role sends the throwaway buyer 2 EURC | [`292a81927bd2...`](https://stellar.expert/explorer/testnet/tx/292a81927bd232b17f070be637f43dae3827c9496478a4cf864ac5b62f865405) |
| W: escrow deploy+init (approver = the throwaway buyer) | [`d3f035444377...`](https://stellar.expert/explorer/testnet/tx/d3f0354443779b510fbf4df4c719e45694c714f3419326ad8930ae986f83e45a) |
| W: throwaway buyer funds 2 EURC | [`eb7d3dd03556...`](https://stellar.expert/explorer/testnet/tx/eb7d3dd03556237e100bb306e71f47b727eb03147a043ffd2df451504be5d847) |
| W: escrow registered with the guard (records full funding) | [`2d0fa4438473...`](https://stellar.expert/explorer/testnet/tx/2d0fa4438473cd5b2751b09fce5548230c1679fd9b24c01ac6d48b9b400964f9) |
| W: throwaway buyer removes its EURC trustline (it can no longer receive EURC) | [`3338751a58da...`](https://stellar.expert/explorer/testnet/tx/3338751a58da915fc7e9c503dd9a25ac7600a2f767a3a3bef090bf9663371637) |
| W: 1 unit of dust sent to the escrow (SAC `transfer`) | [`fbc16d7460b4...`](https://stellar.expert/explorer/testnet/tx/fbc16d7460b4c085ed24d61a6a818ecadf39972799e8cf20306acd90defc14f9) |
| W: platform opens a dispute | [`7451ee35917f...`](https://stellar.expert/explorer/testnet/tx/7451ee35917f91bcd8bea42bbbb2746c97443a59cf7fb289113704a9a369948d) |
| W: guard records the dispute | [`ea8b1ac06cff...`](https://stellar.expert/explorer/testnet/tx/ea8b1ac06cffab9434664822d373923f93b05947dd177619d4c23f3b4a1fc7d2) |
| W: delivery-claim batch anchored in the registry (proof depth 3) | [`f3cba1f1042f...`](https://stellar.expert/explorer/testnet/tx/f3cba1f1042fd61dd5319b69c49b01e7466d5efd5c8fd542c9b7cfaf7ee05388) |
| **W: after the 120 s delay, `withdraw_remaining_funds` pays the seller alone** (ResolveSeller branch, claim verified in `__check_auth`, 4,332,912 instructions in simulation); seller received 1.9 EURC, 1 unit stays in the escrow for the buyer, the registration is closed | [`2d696d8b8ba7...`](https://stellar.expert/explorer/testnet/tx/2d696d8b8ba704ed3338c1cb061db6ea9519e2829ce2036abd06e3069a3ae972) |

Refused paths checked by enforce-mode simulation (not submitted), all with the expected codes: A
release before buyer approval (refused in record mode), A release with a wrong fee address
(`BadFeeAddr` = 15), A release signed with the resolver key (`Error(Auth, InvalidAction)`), B seller
payout without a claim (`NoClaim` = 8), C break-glass to the seller (`NotWholeToBuyer` = 13), F1
precheck (`PlatformFeeOverCap` = 29), W seller withdrawal without a claim (`NoClaim` = 8), W
`resolve_dispute` with the buyer leg the dust forces (the SAC's `Error(Contract, #13)`, trustline
missing), W `resolve_dispute` paying the seller the whole balance (`SellerOverAmount` = 28) and W's
second seller withdrawal (`Closed` = 17). B and C buyers netted 100% after the platform top-up. The
`testnet:v010` summary reads `feeCapRefusalLanded`, `atCapRegistered`, `sellerWithdrawalLanded`,
`registrationClosed`, `secondWithdrawalRefused` and `claimRecheckOk` all true; A's and W's claims
re-check `ok: true` with `registryVerify: true` and `anchoredAfterFunding: true`.

The throwaway buyer's key was generated in memory by the script and never stored; its account
(`GBQ542QMARB4MPZ3FFIKD6WNADRF5YQZJ44WQAO7OSII5ISDJM3NCXY4`) holds no EURC trustline after the run,
and the 1 unit left in escrow W is withdrawable to it only once it restores one. Escrow F2 keeps its 1
unit too. Summary: [`docs/runs/run-9.md`](runs/run-9.md). Run logs:
[`docs/runs/e2e-2026-10-29T19-05-40-912Z.json`](runs/e2e-2026-10-29T19-05-40-912Z.json),
[`docs/runs/v010-2026-10-29T19-09-34-500Z.json`](runs/v010-2026-10-29T19-09-34-500Z.json)
(public hashes only). The deployment transactions above come from the deploy console output, which
writes no run log.


## Sponsored accounts and fee-bumps (wallet lab, 24 Oct 2026)

These prove the `packages/eurc` and `packages/wallets` transaction shapes: a user account created
at 0 XLM with sponsored trustlines, and a user's Soroban call paid by a sponsor fee-bump while the
user signs only with a raw signature over the transaction hash.

| Step | Transaction |
|---|---|
| E1 sponsored account creation with sponsored trustlines (user holds 0 XLM) | [`8dccb9ab850b...`](https://stellar.expert/explorer/testnet/tx/8dccb9ab850b82f713cee6606e678ef9288d8719bceb65024a12db517a9aef36) |
| Deploy the lab asset SAC [`CBOS6FYH...IFSGDC`](https://stellar.expert/explorer/testnet/contract/CBOS6FYHXJZP623KSW7UQM7YN3DQ3AMPQ3VFZCKZ5IFLKOUMXGIFSGDC) | [`fb71617ce9ea...`](https://stellar.expert/explorer/testnet/tx/fb71617ce9ea8ac937e133498b4c2c4bd08f9a6154d7eb623628619a8b703765) |
| Issue the lab asset to the user | [`533a68e75c96...`](https://stellar.expert/explorer/testnet/tx/533a68e75c963500eee50cc80232771bd688d3b48016c97067b1113b792aa24e) |
| E2 user's Soroban transfer wrapped in a sponsor fee-bump | [`9e0d5cb54819...`](https://stellar.expert/explorer/testnet/tx/9e0d5cb5481929171c000b85a1077a754cb550885bcc38aa22f0c1c97fe1f5f7) |
| E4 plain account created with 1 XLM | [`fcd75db9279b...`](https://stellar.expert/explorer/testnet/tx/fcd75db9279b98daf9d60be6d17e1c8726d6a84abd83a2408f91347a8b173446) |
| E4 sponsored EURC trustline for that existing account | [`02c62e1c01df...`](https://stellar.expert/explorer/testnet/tx/02c62e1c01df13597e3b0b15dbee83e83f1047691a65f708cc3fb60665321fb3) |

Refused in the same lab, as expected: the sponsored create without the user's signature
(`op_bad_auth`), an unsponsored 0 XLM create (`op_low_reserve`), the user's Soroban call without a
fee-bump (`txInsufficientBalance`), and the sponsor trying to move the user's funds (`op_bad_auth`).

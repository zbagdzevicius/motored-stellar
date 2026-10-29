# Testnet proofs

Public Stellar **testnet** contract IDs and transaction hashes from the runs behind this code.
Runs 1 to 3 were copied from lab run logs. Runs 4 and 5 were produced by this repository's own
scripts (`npm run testnet:keys`, `testnet:deploy`, `testnet:e2e`, `testnet:e2e-claims`). Links go to [stellar.expert](https://stellar.expert/explorer/testnet).

Testnet is reset from time to time, and a reset erases these entries. The run notes, fees and
instruction counts stay in [verification.md](verification.md). To make a fresh proof, run
`npm run testnet:keys && npm run testnet:deploy && npm run testnet:e2e && npm run testnet:e2e-claims`
and append the output below with the date. Runs 4 and 5 are re-run and re-logged here after any reset, so their links stay live for reviewers.

Pinned Trustless Work escrow Wasm (used by every run and by the unit tests):
testnet `7c3f7b2af92ad86092708b23babf80f9e1308d7f3ce18b703b9499192ecc934b`,
mainnet reference only `96d51751f924c938a081deb740056dc1c5cc60c6e645672062531f82957ed2fe`.
Guard v0.8 optimised Wasm sha256 as deployed in run 3:
`6fb8e25dc3cba23bd3764cc6b4389982a956357e55b21b2a3a32ba527cebce77`.

In all runs a lab-issued asset (run 4: `XEUR`, issued by the run's own issuer account) stood in for EURC, and the seller-payout delay and
contest window were shortened to 120 s so a run fits in minutes. Production values are
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
`NotWholeToBuyer` = 13). Full run log: `scripts/out/` (public hashes only, git-ignored).

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
fully funded at 1793225305. Run log: `scripts/out/` (public hashes only, git-ignored).

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

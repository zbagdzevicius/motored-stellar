# Run 9: guard v0.10 on Circle testnet EURC

29 Oct 2026, 19:03 to 19:10 UTC, Stellar testnet. First testnet run of guard v0.10 (runs 4 to 8 ran
v0.8 or v0.9). Every transaction, with its stellar.expert link, is in
[testnet-proofs.md, Run 9](../testnet-proofs.md#run-9-guard-v010-on-circle-testnet-eurc-29-oct-2026-1903-to-1910-utc).

## Setup

- Asset: Circle's testnet EURC, issuer `GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO`,
  SAC `CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ`. The buyer held 13.9999 EURC on
  Horizon testnet before the run, so orders were 2 EURC.
- Deploy: `npm run testnet:deploy -- --asset EURC:GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO --amount 2`
  (platform fee 470 bps, `max_platform_fee_bps` 500, delay and contest window 120 s).
- Guard v0.10 [`CCRZHNU2CHN62BXALEFHAJEX57AURBB7OWYM37I7JSO7HLALHVJ2KVUZ`](https://stellar.expert/explorer/testnet/contract/CCRZHNU2CHN62BXALEFHAJEX57AURBB7OWYM37I7JSO7HLALHVJ2KVUZ),
  optimised Wasm sha256 `2a21ef35e57f8505861296e2b93a09c5aa2117c66a5fb5d3d2cbcefe3087fbb5`.
- Claim registry v0.10 [`CC6K26NQGSD3UAIUS463ZJCEC7SGEF6V5R34OYZX3WHY6URFTKQ5FBDX`](https://stellar.expert/explorer/testnet/contract/CC6K26NQGSD3UAIUS463ZJCEC7SGEF6V5R34OYZX3WHY6URFTKQ5FBDX),
  optimised Wasm sha256 `e829dc52672dbc8aebca65c6595416ca2b8fba5b787a575e4a487dda3d808870`.
- Escrow factory (Trustless Work testnet Wasm `7c3f7b2a...`) [`CCOAVZCGPYMDUZXRDBDG5Z3EAVS4HQAYSMXAQZA7YK3Q7Q5TYJSI3ZSC`](https://stellar.expert/explorer/testnet/contract/CCOAVZCGPYMDUZXRDBDG5Z3EAVS4HQAYSMXAQZA7YK3Q7Q5TYJSI3ZSC).

## Results

| Scenario | Script | Outcome | Key transaction |
|---|---|---|---|
| A: buyer-approved release | `testnet:e2e` | Seller received 1.9 EURC; claim re-check ok | [`f2cdbd2c87eb...`](https://stellar.expert/explorer/testnet/tx/f2cdbd2c87eb0d525efce66bd73d8e179afbfb50e5ac735a9c33b88a9e355618) |
| B: dispute refund | `testnet:e2e` | Buyer netted 2 EURC after the 0.1 EURC top-up | [`4f800790d4cc...`](https://stellar.expert/explorer/testnet/tx/4f800790d4ccdf91e7d56e4d304b5a9cf663e7df3e7e309348d24d03de155771) |
| C: partial funding, break-glass refund | `testnet:e2e` | Buyer netted 0.8 EURC after the 0.04 EURC top-up | [`19da3f4077e3...`](https://stellar.expert/explorer/testnet/tx/19da3f4077e39f0a83b0a90e3986ff156fb8113dd3c84ce2f3110851e7c91ae4) |
| F1: platform fee 501 bps, one over the cap | `testnet:v010` | `register_escrow` **FAILED** on the ledger with `Error(Contract, #29)` `PlatformFeeOverCap`; never registered | [`54a5c520f859...`](https://stellar.expert/explorer/testnet/tx/54a5c520f8597780074919bbe09a4d8349ebafc8988f5bca733bd29c8dd65e4c) |
| F2: platform fee 500 bps, at the cap | `testnet:v010` | Precheck passes; registered | [`1bd128eb6dea...`](https://stellar.expert/explorer/testnet/tx/1bd128eb6dea7367d386c31c4bbbddc7a029b2a3b77d8438af0538d853175579) |
| W: seller-only `withdraw_remaining_funds` past a buyer with no EURC trustline and 1 unit of dust | `testnet:v010` | Seller received 1.9 EURC alone against the anchored claim; 1 unit stays for the buyer; registration closed; second seller withdrawal refused (`Closed` = 17, simulation) | [`2d696d8b8ba7...`](https://stellar.expert/explorer/testnet/tx/2d696d8b8ba704ed3338c1cb061db6ea9519e2829ce2036abd06e3069a3ae972) |

Escrow IDs: A `CAN3PEKNDM3HIXGAYZSRGWJ66ENF2IBDS67UZITMP3SQXA5PB4364CMD`,
B `CAKCR5RPGPYMDI2ER4VZPWUXBXMQEMZ6YX3MLUSZDX4H2UNBUM2SYQMJ`,
C `CCQDLJRWFAFVCSYA6GXB5ATQWCW2J5FYC6TIZWV4M6HVEF2VBTSXQD6Q`,
F1 `CBLCRKZJW74SGSF33QGETRI7S67CHPTPEAD5DRGW2N4U2XUETX4FEPM7`,
F2 `CBFQGF4U4JGHAHCHFMS24UZ43IBU4Z2SWHMCEFPCBP7MAFQVRRBJC5J2`,
W `CCFF7GHTZ7QFR33MNNQHVCMKDWKU3BSQCTMTN4U5LY65UH5T2Q6FRHRM`.

## Run logs

- [`e2e-2026-10-29T19-05-40-912Z.json`](e2e-2026-10-29T19-05-40-912Z.json) (A, B, C)
- [`v010-2026-10-29T19-09-34-500Z.json`](v010-2026-10-29T19-09-34-500Z.json) (F, W)

Public transaction hashes only. The throwaway buyer of scenario W was generated in memory by the
script and its key was never stored.

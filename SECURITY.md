# Security policy

## Status

This repository is **testnet only** and **unaudited**. The guard contract and the claim
registry have unit tests that run against the escrow Wasm files Trustless Work has deployed,
and a testnet proof run (see [docs/verification.md](docs/verification.md)), but no external
audit yet. An external review is planned before any mainnet deployment. Until then, any
deployment that holds real value should cap exposure per order and in total, as described in
[docs/threat-model.md](docs/threat-model.md).

## Reporting a vulnerability

Please report security issues privately to **security@motored.lt** with the subject
`SECURITY: motored-stellar`. Include the affected component (contract, package or script),
the commit hash, and a reproduction (a failing test is ideal).

- We acknowledge reports within 3 working days.
- We aim to ship a fix or a mitigation within 30 days for high-severity issues.
- Please do not open a public issue or pull request for a vulnerability before a fix is out.

There is no bug bounty at this time.

## In scope

- `contracts/guard` (Soroban custom account that authorises escrow releases and resolutions)
- `contracts/claim-registry` (write-once Merkle roots of delivery claims)
- `packages/*` (escrow adapter, EURC helpers, wallets, ramps, claims, reconciler)
- `scripts/*` (testnet deploy, metric and claim re-check scripts)

## Out of scope

- Trustless Work's escrow contract and API (report to Trustless Work)
- Circle EURC, Bridge, Privy, Stellar Wallets Kit and Stellar Core (report to their owners)
- Findings that need a leaked private key, unless a key's documented limits are exceeded

## Key handling rules for contributors

- Never commit a Stellar secret key (`S...`), seed phrase, API key or `.env` file.
- Testnet keys are generated at runtime by `scripts/testnet/keys.ts` and written only to
  `.keys/` (git-ignored).
- CI runs without secrets. The testnet end-to-end run is manual.
- `scripts/check-secrets.sh` (CI and before every commit) fails on Stellar secret seeds,
  seed phrases, `.env` files, PEM private keys and JSON key files. `scripts/lint/docs-lint.mjs`
  also fails on secret-shaped strings.

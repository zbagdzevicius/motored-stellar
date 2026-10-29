# Delivery-claim leaf format

A delivery claim says: "the platform recorded the carrier's delivered event for the parcel of the
order paid through escrow E". Claims are batched into a Merkle tree; the root is anchored in the
claim registry with `anchor(batch_id, root)`. The guard rebuilds the leaf inside `__check_auth`
from the escrow address it is authorising, so a claim can only ever pay the escrow it was issued
for.

## Leaf

```
leaf = SHA-256( 0x01
              || XDR(ScVal::Address(E))
              || order_ref            (32 bytes)
              || parcels_commit       (32 bytes)
              || carrier_event_ref    (32 bytes)
              || u64_be(delivered_at) (8 bytes) )
```

| Field | Size | Meaning |
|---|---|---|
| `0x01` | 1 | Domain tag for a delivery-claim leaf |
| `E` | variable | The escrow contract address, encoded as the XDR of `ScVal::Address` (what `Address::to_xdr` produces in soroban-sdk) |
| `order_ref` | 32 | A random value per order. Never a database ID |
| `parcels_commit` | 32 | `HMAC-SHA256(key = per-order secret salt kept off-chain, msg = the order's parcel number)` |
| `carrier_event_ref` | 32 | `SHA-256(parcel number \|\| carrier status text \|\| carrier event time \|\| "lang=en")`, taken from the carrier's authenticated tracking response |
| `delivered_at` | 8 | Unix seconds, big-endian. Written by the platform; **not used for timing** (the guard uses the registry's `anchored_at`) |

The byte layout is identical to the guard v0.8 prototype, which used a carrier-specific name for
the fourth field; only the name changed.

Claims are issued only for terminal delivered statuses (for example "delivered to consignee" or
"picked up by consignee from a pickup point"), only when the carrier's event time parses, and only
for paid orders.

## Nodes and proofs

```
node = SHA-256( 0x02 || left || right )
```

A proof is a list of sibling hashes, at most 32 long. Starting from the leaf, for each sibling the
lowest remaining bit of `index` says whether the running hash is the right child (bit = 1: hash
`sibling || running`) or the left child (bit = 0: hash `running || sibling`); then shift `index`
right by one. The proof is valid when, after all siblings, `index == 0` and the running hash equals
the anchored root. Requiring `index == 0` means the index is fully consumed, so one leaf cannot be
proven at two positions.

`verify` returns `false` (never an error) for an unknown or revoked batch. It returns the
`ProofTooLong` error for proofs longer than 32.

## Domain tags

Tag `0x01` marks a delivery-claim leaf, `0x02` an internal node and `0x03` a padding leaf. Tag
`0x00` is reserved for field-level leaves of other record formats and is never a delivery claim, so
no two formats can collide even if both were ever anchored in one tree.

## Reference implementations

- Rust: `leaf()` in [`contracts/guard`](../contracts/guard) and `verify()` in
  [`contracts/claim-registry`](../contracts/claim-registry).
- TypeScript: [`packages/claims`](../packages/claims) builds leaves, trees and proofs, and is
  tested against the same vectors as the Rust code.
- Public re-check: [`scripts/claims/recheck.ts`](../scripts/claims) takes an escrow address, a
  claim and its proof, and checks inclusion and anchor time against the registry on testnet.

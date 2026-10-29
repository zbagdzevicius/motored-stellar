//! # claim-registry (v0.8)
//!
//! Write-once Merkle roots for batches of delivery claims, with the ledger time at which each
//! root was anchored, plus permanent revocation of a batch by a separate revoker key.
//!
//! * `anchor(batch_id, root)`: issuer only; a batch id can be anchored once (`RootExists`).
//! * `anchored_at(batch_id)`: the anchor ledger timestamp; `Revoked` for a revoked batch.
//! * `verify(batch_id, leaf, proof, index)`: Merkle inclusion proof against the anchored root.
//!   Internal nodes are `sha256(0x02 || left || right)`; the side at each level is taken from the
//!   bits of `index` (LSB first), and every bit of `index` must be consumed by the proof.
//!   A revoked or unknown batch verifies `false`. Proofs longer than 32 levels are refused.
//! * `revoke(batch_id)`: revoker only; a revoked batch never verifies again.
//!
//! The leaf format for delivery claims (tag 0x01) is specified in `docs/leaf-format.md` and
//! computed on chain by `motored_escrow_guard::leaf`.
//!
//! **Status: unaudited. Testnet only.**
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN,
    Env, Vec,
};

/// Domain tag for internal Merkle nodes (leaves use their own tag, 0x01 for delivery claims).
const TAG_NODE: u8 = 0x02;
/// Maximum proof length: 2^32 leaves per batch.
const MAX_DEPTH: u32 = 32;
/// TTL bump for anchored roots, in ledgers (~1 day at 5 s ledgers).
/// Testnet values: a production deployment sets these to cover the claim's whole useful life
/// (at least the escrow `delay` plus the dispute horizon) or runs a TTL keeper.
const TTL_THRESHOLD: u32 = 17_280;
const TTL_EXTEND_TO: u32 = 17_280 * 2;

#[contracttype]
enum Key {
    Issuer,
    Revoker,
    Root(u64),
    Revoked(u64),
}

/// An anchored root and the ledger timestamp at which it was anchored.
#[contracttype]
#[derive(Clone)]
pub struct RootRec {
    pub root: BytesN<32>,
    pub at: u64,
}

/// Registry errors. Codes are stable and part of the public interface.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 2,
    RootExists = 3,
    ProofTooLong = 4,
    NoRoot = 5,
    Revoked = 6,
}

#[contractevent]
pub struct BatchRevoked {
    pub batch_id: u64,
}

#[contract]
pub struct ClaimRegistry;

#[contractimpl]
impl ClaimRegistry {
    /// `issuer` anchors roots (the platform's online batching key); `revoker` is a separate,
    /// offline key that can only revoke.
    pub fn __constructor(env: Env, issuer: Address, revoker: Address) {
        env.storage().instance().set(&Key::Issuer, &issuer);
        env.storage().instance().set(&Key::Revoker, &revoker);
    }

    /// Anchors `root` for `batch_id`, once. Records the current ledger timestamp.
    pub fn anchor(env: Env, batch_id: u64, root: BytesN<32>) -> Result<(), Error> {
        let issuer: Address = env
            .storage()
            .instance()
            .get(&Key::Issuer)
            .ok_or(Error::NotInitialized)?;
        issuer.require_auth();
        let key = Key::Root(batch_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::RootExists);
        }
        env.storage().persistent().set(
            &key,
            &RootRec {
                root,
                at: env.ledger().timestamp(),
            },
        );
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Permanently revokes `batch_id`. Separate (offline) revoker key.
    pub fn revoke(env: Env, batch_id: u64) -> Result<(), Error> {
        let r: Address = env
            .storage()
            .instance()
            .get(&Key::Revoker)
            .ok_or(Error::NotInitialized)?;
        r.require_auth();
        env.storage()
            .persistent()
            .set(&Key::Revoked(batch_id), &true);
        BatchRevoked { batch_id }.publish(&env);
        Ok(())
    }

    /// Ledger timestamp at which `batch_id` was anchored.
    pub fn anchored_at(env: Env, batch_id: u64) -> Result<u64, Error> {
        if env.storage().persistent().has(&Key::Revoked(batch_id)) {
            return Err(Error::Revoked);
        }
        let r: RootRec = env
            .storage()
            .persistent()
            .get(&Key::Root(batch_id))
            .ok_or(Error::NoRoot)?;
        Ok(r.at)
    }

    /// True if `leaf` at position `index` is included under the root anchored for `batch_id`.
    pub fn verify(
        env: Env,
        batch_id: u64,
        leaf: BytesN<32>,
        proof: Vec<BytesN<32>>,
        index: u32,
    ) -> Result<bool, Error> {
        if proof.len() > MAX_DEPTH {
            return Err(Error::ProofTooLong);
        }
        if env.storage().persistent().has(&Key::Revoked(batch_id)) {
            return Ok(false);
        }
        let Some(rec) = env
            .storage()
            .persistent()
            .get::<_, RootRec>(&Key::Root(batch_id))
        else {
            return Ok(false);
        };
        let mut h = leaf;
        let mut i = index as u64;
        for sib in proof.iter() {
            let mut buf = Bytes::from_array(&env, &[TAG_NODE]);
            if i & 1 == 1 {
                buf.append(&sib.into());
                buf.append(&h.into());
            } else {
                buf.append(&h.into());
                buf.append(&sib.into());
            }
            h = env.crypto().sha256(&buf).into();
            i >>= 1;
        }
        Ok(i == 0 && h == rec.root)
    }
}

#[cfg(test)]
mod test;

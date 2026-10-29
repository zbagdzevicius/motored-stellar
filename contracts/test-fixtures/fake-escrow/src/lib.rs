//! # fake-escrow (test fixture, never deploy)
//!
//! A look-alike "escrow" used by the guard's negative tests. It returns whatever escrow value
//! was stored with `set()`, so it can impersonate a perfectly shaped Trustless Work escrow while
//! running a different Wasm. `release_funds` asks the given `release_signer` (the guard) for
//! authorization. The guard must refuse to register it (pinned Wasm hash) and therefore refuse to
//! authorize anything on it.
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, Val};

#[contract]
pub struct FakeEscrow;

#[contractimpl]
impl FakeEscrow {
    /// Stores the value `get_escrow` will return.
    pub fn set(env: Env, escrow: Val) {
        env.storage().instance().set(&0u32, &escrow);
    }

    /// Returns the stored value verbatim.
    pub fn get_escrow(env: Env) -> Val {
        env.storage().instance().get(&0u32).unwrap()
    }

    /// Requires authorization from `release_signer`, as a Trustless Work release would.
    pub fn release_funds(_env: Env, release_signer: Address) {
        release_signer.require_auth();
    }
}

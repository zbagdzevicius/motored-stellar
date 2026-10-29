//! Claim registry tests: write-once anchoring, issuer/revoker separation, revocation,
//! proof-length bound, and Merkle verification against an off-chain reference tree.
extern crate std;

use super::*;
use sha2::{Digest, Sha256};
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    IntoVal,
};
use std::vec::Vec as StdVec;

struct Ctx {
    env: Env,
    c: ClaimRegistryClient<'static>,
    issuer: Address,
    revoker: Address,
}

fn setup() -> Ctx {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_800_000_000);
    let issuer = Address::generate(&env);
    let revoker = Address::generate(&env);
    let id = env.register(ClaimRegistry, (issuer.clone(), revoker.clone()));
    let c = ClaimRegistryClient::new(&env, &id);
    Ctx {
        env,
        c,
        issuer,
        revoker,
    }
}

fn b32(env: &Env, a: [u8; 32]) -> BytesN<32> {
    BytesN::from_array(env, &a)
}

/// Off-chain reference node hash: sha256(0x02 || left || right).
fn node(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([TAG_NODE]);
    h.update(l);
    h.update(r);
    h.finalize().into()
}

/// A complete binary tree over `leaves` (length must be a power of two).
/// Returns the root and, for every leaf, its proof (siblings from the bottom up).
fn tree(leaves: &[[u8; 32]]) -> ([u8; 32], StdVec<StdVec<[u8; 32]>>) {
    assert!(leaves.len().is_power_of_two());
    let mut levels: StdVec<StdVec<[u8; 32]>> = std::vec![leaves.to_vec()];
    while levels.last().unwrap().len() > 1 {
        let prev = levels.last().unwrap();
        let next = prev.chunks(2).map(|p| node(&p[0], &p[1])).collect();
        levels.push(next);
    }
    let root = levels.last().unwrap()[0];
    let proofs = (0..leaves.len())
        .map(|mut i| {
            let mut p = StdVec::new();
            for lvl in &levels[..levels.len() - 1] {
                p.push(lvl[i ^ 1]);
                i >>= 1;
            }
            p
        })
        .collect();
    (root, proofs)
}

fn proof_vec(env: &Env, p: &[[u8; 32]]) -> Vec<BytesN<32>> {
    let mut v = Vec::new(env);
    for s in p {
        v.push_back(b32(env, *s));
    }
    v
}

fn sample_leaves() -> StdVec<[u8; 32]> {
    (0u8..8).map(|i| Sha256::digest([0x01, i]).into()).collect()
}

#[test]
fn verifies_every_leaf_of_a_reference_tree() {
    let t = setup();
    t.env.mock_all_auths();
    let leaves = sample_leaves();
    let (root, proofs) = tree(&leaves);
    t.c.anchor(&1, &b32(&t.env, root));
    for (i, leaf) in leaves.iter().enumerate() {
        assert!(t.c.verify(
            &1,
            &b32(&t.env, *leaf),
            &proof_vec(&t.env, &proofs[i]),
            &(i as u32)
        ));
    }
}

#[test]
fn rejects_wrong_index_tampered_leaf_and_unknown_batch() {
    let t = setup();
    t.env.mock_all_auths();
    let leaves = sample_leaves();
    let (root, proofs) = tree(&leaves);
    t.c.anchor(&1, &b32(&t.env, root));
    let leaf = b32(&t.env, leaves[0]);
    let p = proof_vec(&t.env, &proofs[0]);
    assert!(t.c.verify(&1, &leaf, &p, &0));
    // wrong index
    assert!(!t.c.verify(&1, &leaf, &p, &1));
    // index bits above the proof depth must not alias to a valid position
    assert!(!t.c.verify(&1, &leaf, &p, &8));
    // tampered leaf
    let mut bad = leaves[0];
    bad[0] ^= 1;
    assert!(!t.c.verify(&1, &b32(&t.env, bad), &p, &0));
    // unknown batch
    assert!(!t.c.verify(&2, &leaf, &p, &0));
}

#[test]
fn root_is_write_once() {
    let t = setup();
    t.env.mock_all_auths();
    t.c.anchor(&5, &b32(&t.env, [7; 32]));
    assert_eq!(
        t.c.try_anchor(&5, &b32(&t.env, [8; 32])),
        Err(Ok(Error::RootExists))
    );
    // the original root still verifies as a single-leaf tree (leaf == root, empty proof)
    assert!(t.c.verify(&5, &b32(&t.env, [7; 32]), &Vec::new(&t.env), &0));
    assert!(!t.c.verify(&5, &b32(&t.env, [8; 32]), &Vec::new(&t.env), &0));
}

#[test]
fn only_issuer_can_anchor() {
    let t = setup();
    let r = b32(&t.env, [1; 32]);
    // no authorization at all
    assert!(t.c.try_anchor(&1, &r).is_err());
    // the revoker cannot anchor
    t.env.mock_auths(&[MockAuth {
        address: &t.revoker,
        invoke: &MockAuthInvoke {
            contract: &t.c.address,
            fn_name: "anchor",
            args: (1u64, r.clone()).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert!(t.c.try_anchor(&1, &r).is_err());
    // the issuer can, and is the recorded authorizer
    t.env.mock_auths(&[MockAuth {
        address: &t.issuer,
        invoke: &MockAuthInvoke {
            contract: &t.c.address,
            fn_name: "anchor",
            args: (1u64, r.clone()).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    t.c.anchor(&1, &r);
    assert_eq!(t.env.auths()[0].0, t.issuer);
}

#[test]
fn only_revoker_can_revoke() {
    let t = setup();
    t.env.mock_all_auths();
    t.c.anchor(&3, &b32(&t.env, [3; 32]));
    // no authorization at all
    t.env.set_auths(&[]);
    assert!(t.c.try_revoke(&3).is_err());
    // the issuer cannot revoke
    t.env.mock_auths(&[MockAuth {
        address: &t.issuer,
        invoke: &MockAuthInvoke {
            contract: &t.c.address,
            fn_name: "revoke",
            args: (3u64,).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert!(t.c.try_revoke(&3).is_err());
    // the revoker can
    t.env.mock_auths(&[MockAuth {
        address: &t.revoker,
        invoke: &MockAuthInvoke {
            contract: &t.c.address,
            fn_name: "revoke",
            args: (3u64,).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    t.c.revoke(&3);
    assert_eq!(t.env.auths()[0].0, t.revoker);
}

#[test]
fn revoked_batch_never_verifies_and_has_no_anchor_time() {
    let t = setup();
    t.env.mock_all_auths();
    let leaves = sample_leaves();
    let (root, proofs) = tree(&leaves);
    t.c.anchor(&9, &b32(&t.env, root));
    let leaf = b32(&t.env, leaves[3]);
    let p = proof_vec(&t.env, &proofs[3]);
    assert!(t.c.verify(&9, &leaf, &p, &3));
    t.c.revoke(&9);
    assert!(!t.c.verify(&9, &leaf, &p, &3));
    assert_eq!(t.c.try_anchored_at(&9), Err(Ok(Error::Revoked)));
    // revocation is permanent: the batch id cannot be re-anchored either
    assert_eq!(
        t.c.try_anchor(&9, &b32(&t.env, root)),
        Err(Ok(Error::RootExists))
    );
}

#[test]
fn anchored_at_is_the_ledger_timestamp() {
    let t = setup();
    t.env.mock_all_auths();
    assert_eq!(t.c.try_anchored_at(&4), Err(Ok(Error::NoRoot)));
    t.env.ledger().with_mut(|l| l.timestamp = 1_800_123_456);
    t.c.anchor(&4, &b32(&t.env, [4; 32]));
    t.env.ledger().with_mut(|l| l.timestamp += 3_600);
    assert_eq!(t.c.anchored_at(&4), 1_800_123_456);
}

#[test]
fn proof_length_is_bounded_at_32() {
    let t = setup();
    t.env.mock_all_auths();
    let leaf = b32(&t.env, [0; 32]);
    // depth 32 is accepted (and simply does not match this root)
    t.c.anchor(&1, &b32(&t.env, [0xAB; 32]));
    let mut p = Vec::new(&t.env);
    for _ in 0..32 {
        p.push_back(b32(&t.env, [0; 32]));
    }
    assert_eq!(t.c.try_verify(&1, &leaf, &p, &0), Ok(Ok(false)));
    // depth 33 is refused
    p.push_back(b32(&t.env, [0; 32]));
    assert_eq!(
        t.c.try_verify(&1, &leaf, &p, &0),
        Err(Ok(Error::ProofTooLong))
    );
}

#![cfg(test)]
//! Guard v0.8 tests against Trustless Work's DEPLOYED single-release v1 Wasm files:
//!   testnet 7c3f7b2a... (release/resolve/withdraw take trustless_work_address as arg 1)
//!   mainnet 96d51751... (fee account GBWWSOAT... hardcoded)
//! Each test in the `lineage!` macro runs for both lineages (modules `tn` and `mn`): 2 x 32 tests,
//! plus m01 and m02, 66 in total.
//!
//! Prerequisites (see contracts/README.md):
//!   ./third_party/tw-wasm/fetch.sh     the two Trustless Work Wasm files, verified by SHA-256
//!   stellar contract build            claim_registry.wasm, fake_escrow.wasm, motored_escrow_guard.wasm
//!
//! The ed25519 guard keys below come from fixed byte seeds ([1; 32], [2; 32], [3; 32]) so the tests are
//! deterministic. These seeds are public: never use them for a deployed guard.
extern crate std;
use std::println;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    xdr::{
        self, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits,
        ScAddress, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
        SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, WriteXdr,
    },
    IntoVal, String as SStr, Val,
};

mod regc {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/claim_registry.wasm");
}
mod fakec {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/fake_escrow.wasm");
}
mod tnc {
    soroban_sdk::contractimport!(file = "../third_party/tw-wasm/tw_testnet_7c3f7b2a.wasm");
}
mod mnc {
    soroban_sdk::contractimport!(file = "../third_party/tw-wasm/tw_mainnet_96d51751.wasm");
}
const TN_WASM: &[u8] = include_bytes!("../../third_party/tw-wasm/tw_testnet_7c3f7b2a.wasm");
const MN_WASM: &[u8] = include_bytes!("../../third_party/tw-wasm/tw_mainnet_96d51751.wasm");
/// Trustless Work fee account hardcoded in the mainnet Wasm 96d51751... (public address).
const TW_FEE_G: &str = "GBWWSOATPLIC72ZBOIM7WJCT7VCAHNWW4QUBZ2H4FORMCCIUM5ZVKSZN";
const DAY: u64 = 86_400;
const GUARD_WASM: &[u8] =
    include_bytes!("../../target/wasm32v1-none/release/motored_escrow_guard.wasm");
const AMT: i128 = 100_0000000; // 100 units, 7 decimals
const PFEE: u32 = 470; // platform fee bps

pub struct W {
    pub env: Env,
    pub token: Address,
    pub asset: xdr::Asset,
    pub reg: Address,
    pub guard: Address,
    pub escrow: Address,
    pub buyer: Address,
    pub seller: Address,
    pub platform: Address,
    pub fee: Address,
    #[allow(dead_code)] // kept so tests can reach the guard admin when they need it
    pub admin: Address,
    pub resolver_admin: Address,
    pub k_rel: SigningKey,
    pub k_res: SigningKey,
    pub k_bg: SigningKey,
    nonce: core::cell::Cell<i64>,
}

fn pk(env: &Env, k: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &k.verifying_key().to_bytes())
}
fn sha(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

/// Common world. `wasm` is the TW production Wasm; `fee_arg` = testnet lineage.
pub fn world(wasm: &[u8], fee_arg: bool) -> W {
    world_opts(wasm, fee_arg, false)
}
pub fn world_opts(wasm: &[u8], fee_arg: bool, wasm_guard: bool) -> W {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.timestamp = 1_800_000_000;
        l.sequence_number = 1000;
    });
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = sac.address();
    let reg_issuer = Address::generate(&env);
    let reg_revoker = Address::generate(&env);
    let reg = env.register(regc::WASM, (reg_issuer, reg_revoker));
    let (k_rel, k_res, k_bg) = (
        SigningKey::from_bytes(&[1; 32]),
        SigningKey::from_bytes(&[2; 32]),
        SigningKey::from_bytes(&[3; 32]),
    );
    let admin = Address::generate(&env);
    let resolver_admin = Address::generate(&env);
    let fee = if fee_arg {
        Address::generate(&env)
    } else {
        Address::from_str(&env, TW_FEE_G)
    };
    let platform = Address::generate(&env);
    let cfg = Cfg {
        admin: admin.clone(),
        resolver_admin: resolver_admin.clone(),
        release_pk: pk(&env, &k_rel),
        resolver_pk: pk(&env, &k_res),
        breakglass_pk: pk(&env, &k_bg),
        registry: reg.clone(),
        token: token.clone(),
        platform: platform.clone(),
        tw_wasm: BytesN::from_array(&env, &sha(wasm)),
        tw_fee: if fee_arg { Some(fee.clone()) } else { None },
        delay: 7 * DAY,
        rotate_delay: 7 * DAY,
        contest_window: 7 * DAY,
    };
    let guard = if wasm_guard {
        env.register(GUARD_WASM, (cfg,))
    } else {
        env.register(Guard, (cfg,))
    };
    let escrow = env.register(wasm, ());
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    W {
        asset: sac.asset(),
        env,
        token,
        reg,
        guard,
        escrow,
        buyer,
        seller,
        platform,
        fee,
        admin,
        resolver_admin,
        k_rel,
        k_res,
        k_bg,
        nonce: core::cell::Cell::new(1),
    }
}

/// Gives the hardcoded mainnet fee account GBWWSOAT... an authorised trustline for the test asset.
pub fn give_gbww_trustline(w: &W) {
    use soroban_sdk::xdr::*;
    use std::rc::Rc;
    let a = Address::from_str(&w.env, TW_FEE_G);
    let id = match ScAddress::try_from(a).unwrap() {
        ScAddress::Account(id) => id,
        _ => panic!(),
    };
    let ak = Rc::new(LedgerKey::Account(LedgerKeyAccount {
        account_id: id.clone(),
    }));
    let av = Rc::new(LedgerEntry {
        data: LedgerEntryData::Account(AccountEntry {
            account_id: id.clone(),
            balance: 100_000_000,
            flags: 0,
            home_domain: Default::default(),
            inflation_dest: None,
            num_sub_entries: 1,
            seq_num: SequenceNumber(0),
            thresholds: Thresholds([1; 4]),
            signers: VecM::default(),
            ext: AccountEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: LedgerEntryExt::V0,
    });
    w.env.host().add_ledger_entry(&ak, &av, None).unwrap();
    let ta = match &w.asset {
        Asset::CreditAlphanum4(x) => TrustLineAsset::CreditAlphanum4(x.clone()),
        Asset::CreditAlphanum12(x) => TrustLineAsset::CreditAlphanum12(x.clone()),
        _ => panic!(),
    };
    let tk = Rc::new(LedgerKey::Trustline(LedgerKeyTrustLine {
        account_id: id.clone(),
        asset: ta.clone(),
    }));
    let tv = Rc::new(LedgerEntry {
        data: LedgerEntryData::Trustline(TrustLineEntry {
            account_id: id,
            asset: ta,
            balance: 0,
            limit: i64::MAX,
            flags: 1,
            ext: TrustLineEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: LedgerEntryExt::V0,
    });
    w.env.host().add_ledger_entry(&tk, &tv, None).unwrap();
}

impl W {
    pub fn bal(&self, a: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(a)
    }
    pub fn mint(&self, to: &Address, amt: i128) {
        self.env.mock_all_auths();
        StellarAssetClient::new(&self.env, &self.token).mint(to, &amt);
    }
    pub fn guardc(&self) -> GuardClient<'_> {
        GuardClient::new(&self.env, &self.guard)
    }
    pub fn regc(&self) -> regc::Client<'_> {
        regc::Client::new(&self.env, &self.reg)
    }
    pub fn reg_of(&self) -> Reg {
        self.guardc().registration(&self.escrow).unwrap()
    }
    /// Sends `amt` of the token to the escrow from a third party (plain SAC transfer, not fund_escrow).
    pub fn dust(&self, amt: i128) {
        let a = Address::generate(&self.env);
        self.mint(&a, amt);
        self.env.mock_all_auths();
        TokenClient::new(&self.env, &self.token).transfer(&a, &self.escrow, &amt);
    }
    pub fn contest(&self) -> bool {
        self.env.mock_all_auths();
        let r = self
            .guardc()
            .try_contest(&self.escrow, &BytesN::from_array(&self.env, &[0xEE; 32]));
        if let Err(ref e) = r {
            println!("    contest err: {:?}", e);
        }
        matches!(r, Ok(Ok(())))
    }
    /// True if the guard's last refusal carried guard error `code` (read from diagnostic events).
    pub fn guard_err(&self, code: u32) -> bool {
        let evs = self.env.host().get_diagnostic_events().unwrap();
        let g = ScAddress::try_from(self.guard.clone()).unwrap();
        evs.0.iter().rev().take(80).any(|ev| {
            let t = std::format!("{:?}", ev.event.body);
            ev.event
                .contract_id
                .as_ref()
                .map(|c| ScAddress::Contract(c.clone()) == g)
                .unwrap_or(false)
                && t.contains("__check_auth")
                && t.contains(&std::format!("data: Error(Contract({}))", code))
        })
    }
    pub fn register(&self) -> bool {
        let r = self.guardc().try_register_escrow(&self.escrow);
        if let Err(ref e) = r {
            println!("    register err: {:?}", e);
        }
        matches!(r, Ok(Ok(_)))
    }

    /// Builds and anchors a depth-`depth` claim for escrow `e` as batch `batch`.
    pub fn anchor_claim(&self, e: &Address, batch: u64, depth: u32, seed: u8) -> Claim {
        let env = &self.env;
        let mut c = Claim {
            order_ref: BytesN::from_array(env, &[seed; 32]),
            parcels_commit: BytesN::from_array(env, &[seed.wrapping_add(1); 32]),
            carrier_event_ref: BytesN::from_array(env, &[seed.wrapping_add(2); 32]),
            delivered_at: 1_799_990_000,
            batch_id: batch,
            proof: soroban_sdk::Vec::new(env),
            index: (0x5A5A_5A5Au64 & ((1u64 << depth) - 1)) as u32,
        };
        let mut h: [u8; 32] = leaf(env, e, &c).to_array();
        let mut i = c.index as u64;
        for d in 0..depth {
            let sib = [seed ^ (d as u8) ^ 0x77; 32];
            c.proof.push_back(BytesN::from_array(env, &sib));
            let mut hasher = Sha256::new();
            hasher.update([0x02u8]);
            if i & 1 == 1 {
                hasher.update(sib);
                hasher.update(h);
            } else {
                hasher.update(h);
                hasher.update(sib);
            }
            h = hasher.finalize().into();
            i >>= 1;
        }
        env.mock_all_auths();
        self.regc().anchor(&batch, &BytesN::from_array(env, &h));
        c
    }

    /// A real enforcing-mode auth entry for the guard over `escrow.fn_name(args)`.
    pub fn guard_auth(
        &self,
        fn_name: &str,
        args: soroban_sdk::Vec<Val>,
        kind: u32,
        sk: &SigningKey,
        claim: Option<Claim>,
    ) -> SorobanAuthorizationEntry {
        let env = &self.env;
        let nonce = self.nonce.get();
        self.nonce.set(nonce + 1);
        let exp = env.ledger().sequence() + 100;
        let sc_args: std::vec::Vec<ScVal> = args
            .iter()
            .map(|v| ScVal::try_from_val(env, &v).unwrap())
            .collect();
        let inv = SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::try_from(self.escrow.clone()).unwrap(),
                function_name: xdr::ScSymbol(fn_name.try_into().unwrap()),
                args: sc_args.try_into().unwrap(),
            }),
            sub_invocations: xdr::VecM::default(),
        };
        let pre = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(env.ledger().network_id().to_array()),
            nonce,
            signature_expiration_ledger: exp,
            invocation: inv.clone(),
        });
        let payload = sha(&pre.to_xdr(Limits::none()).unwrap());
        let s = BytesN::from_array(env, &sk.sign(&payload).to_bytes());
        let gs = match kind {
            0 => GuardSig::Release(s),
            1 => match claim {
                None => GuardSig::Resolve(s),
                Some(c) => GuardSig::ResolveSeller(ResolveSig { sig: s, claim: c }),
            },
            _ => GuardSig::BreakGlass(s),
        };
        let sv: Val = gs.into_val(env);
        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::try_from(self.guard.clone()).unwrap(),
                nonce,
                signature_expiration_ledger: exp,
                signature: ScVal::try_from_val(env, &sv).unwrap(),
            }),
            root_invocation: inv,
        }
    }
}

pub const K_REL: u32 = 0;
pub const K_RES: u32 = 1;
pub const K_BG: u32 = 2;

/// Lineage-specific glue (calls differ only by the trustless_work_address argument).
macro_rules! lineage {
    ($m:ident, $c:ident, $wasm:expr, $fee_arg:expr, $other_wasm:expr) => {
mod $m {
    use super::*;
    use super::$c as twc;
    #[allow(unused_imports)]
    use soroban_sdk::{testutils::{Address as _, Ledger}, IntoVal, String as SStr, Val, Map, BytesN, Symbol, Address};

    pub fn props(w: &W, status: &str, token: &Address) -> twc::Escrow {
        let e = &w.env;
        let mut ms = soroban_sdk::Vec::new(e);
        ms.push_back(twc::Milestone { description: SStr::from_str(e, "part delivered"), status: SStr::from_str(e, status), evidence: SStr::from_str(e, ""), approved: false });
        twc::Escrow {
            engagement_id: SStr::from_str(e, "rand-order-ref"), title: SStr::from_str(e, "order"), description: SStr::from_str(e, "part"),
            // roles: buyer = approver; seller = service_provider and receiver
            roles: twc::Roles { approver: w.buyer.clone(), service_provider: w.seller.clone(), platform: w.platform.clone(), release_signer: w.guard.clone(), dispute_resolver: w.guard.clone(), receiver: w.seller.clone() },
            amount: AMT, platform_fee: PFEE, milestones: ms,
            flags: twc::Flags { disputed: false, released: false, resolved: false },
            trustline: twc::Trustline { address: token.clone() }, receiver_memo: 0,
        }
    }
    pub fn setup_status(status: &str) -> W {
        let w = world($wasm, $fee_arg);
        if !$fee_arg { give_gbww_trustline(&w); }
        w.env.mock_all_auths();
        let p = props(&w, status, &w.token);
        twc::Client::new(&w.env, &w.escrow).initialize_escrow(&p);
        w
    }
    pub fn setup() -> W { setup_status("awaiting delivery") }
    pub fn tw(w: &W) -> twc::Client<'_> { twc::Client::new(&w.env, &w.escrow) }
    pub fn fund(w: &W, amt: i128) -> bool {
        w.mint(&w.buyer, amt); w.env.mock_all_auths();
        let e = tw(w).get_escrow();
        let r = tw(w).try_fund_escrow(&w.buyer, &e, &amt);
        if let Err(ref e) = r { println!("    fund err: {:?}", e); }
        matches!(r, Ok(Ok(_)))
    }
    /// The buyer approves (status was set non-empty before funding).
    pub fn ship_and_approve(w: &W) -> bool {
        w.env.mock_all_auths();
        let r = tw(w).try_approve_milestone(&0, &w.buyer);
        if let Err(ref e) = r { println!("    approve err: {:?}", e); }
        matches!(r, Ok(Ok(_)))
    }
    pub fn dispute(w: &W, who: &Address) -> bool { w.env.mock_all_auths(); let r = tw(w).try_dispute_escrow(who); if let Err(ref e) = r { println!("    dispute err: {:?}", e); } matches!(r, Ok(Ok(_))) }
    pub fn fee_for_call(w: &W, ok_fee: bool) -> Address { if ok_fee { w.fee.clone() } else { Address::generate(&w.env) } }

    pub fn release(w: &W, kind: u32, sk: &SigningKey, ok_fee: bool) -> bool {
        let f = fee_for_call(w, ok_fee);
        let args: soroban_sdk::Vec<Val> = if $fee_arg { soroban_sdk::vec![&w.env, w.guard.into_val(&w.env), f.into_val(&w.env)] } else { soroban_sdk::vec![&w.env, w.guard.into_val(&w.env)] };
        let a = w.guard_auth("release_funds", args, kind, sk, None);
        w.env.set_auths(&[a]);
        let r = rel_call(w, &f);
        if let Err(ref e) = r { println!("    release err: {}", e); }
        r.is_ok()
    }
    pub fn resolve(w: &W, fname: &str, d: &Map<Address, i128>, kind: u32, sk: &SigningKey, claim: Option<Claim>, ok_fee: bool) -> bool {
        let f = fee_for_call(w, ok_fee);
        let args: soroban_sdk::Vec<Val> = if $fee_arg { soroban_sdk::vec![&w.env, w.guard.into_val(&w.env), f.into_val(&w.env), d.into_val(&w.env)] } else { soroban_sdk::vec![&w.env, w.guard.into_val(&w.env), d.into_val(&w.env)] };
        let a = w.guard_auth(fname, args, kind, sk, claim);
        w.env.set_auths(&[a]);
        let r = if fname == "resolve_dispute" { res_call(w, &f, d) } else { wrf_call(w, &f, d) };
        if let Err(ref e) = r { println!("    {} err: {}", fname, e); }
        r.is_ok()
    }
    pub fn other_wasm_escrow(w: &W) -> Address { let a = w.env.register($other_wasm, ()); a }

    // ---------------------------------------------------------------- tests
    #[test]
    fn t01_release_needs_buyer_approval_and_release_key_and_pays_fixed_split() {
        let w = setup();
        assert!(fund(&w, AMT));
        assert!(w.register());
        // no approval: TW refuses (EscrowNotCompleted) even with the release key
        assert!(!release(&w, K_REL, &w.k_rel, true));
        assert!(ship_and_approve(&w));
        // wrong key in the release branch traps (fails closed)
        assert!(!release(&w, K_REL, &w.k_res, true));
        if $fee_arg { assert!(!release(&w, K_REL, &w.k_rel, false), "fee address argument must be pinned"); }
        assert!(release(&w, K_REL, &w.k_rel, true));
        let tw_fee = AMT * 30 / 10000; let pf = AMT * (PFEE as i128) / 10000;
        println!("[{}] release: seller {} platform {} tw {} (of {})", stringify!($m), w.bal(&w.seller), w.bal(&w.platform), w.bal(&w.fee), AMT);
        assert_eq!(w.bal(&w.seller), AMT - tw_fee - pf);
        assert_eq!(w.bal(&w.platform), pf);
        assert_eq!(w.bal(&w.fee), tw_fee);
        assert_eq!(w.bal(&w.escrow), 0);
        assert!(w.guardc().registration(&w.escrow).unwrap().closed);
    }

    #[test]
    fn t02_resolver_limits_recipients_claim_and_seven_days() {
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 60);
        assert!(dispute(&w, &w.platform));
        let third = Address::generate(&w.env);
        let mut d = Map::new(&w.env); d.set(third.clone(), AMT);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true), "third address");
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true), "seller without claim");
        let claim = w.anchor_claim(&w.escrow, 7, 32, 5);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, Some(claim.clone()), true), "seller before anchor + 7 days");
        let other = Address::generate(&w.env);
        let claim_other = w.anchor_claim(&other, 8, 4, 9);
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, Some(claim_other), true), "claim for another escrow");
        if $fee_arg { assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, Some(claim.clone()), false), "fee arg pinned"); }
        assert!(resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, Some(claim), true));
        println!("[{}] seller resolution after 7 days: seller {}", stringify!($m), w.bal(&w.seller));
        assert!(w.bal(&w.seller) > 0);
    }

    #[test]
    fn t03_claim_anchored_before_registration_is_refused() {
        let w = setup();
        // pre-anchored claim for the escrow address (attacker controlling deployment knows it)
        let claim = w.anchor_claim(&w.escrow, 11, 8, 3);
        w.env.ledger().with_mut(|l| l.timestamp += 60);
        assert!(fund(&w, AMT)); assert!(w.register());
        assert!(dispute(&w, &w.platform));
        w.env.ledger().with_mut(|l| l.timestamp += 8 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, Some(claim), true));
    }

    #[test]
    fn t04_revoked_batch_never_verifies() {
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 60);
        let claim = w.anchor_claim(&w.escrow, 21, 8, 4);
        w.env.mock_all_auths(); w.regc().revoke(&21);
        assert!(dispute(&w, &w.platform));
        w.env.ledger().with_mut(|l| l.timestamp += 8 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, Some(claim), true));
    }

    #[test]
    fn t05_partial_funding_registers_and_breakglass_refunds_buyer() {
        let w = setup();
        let part = AMT * 4 / 10;
        assert!(fund(&w, part));
        assert!(w.register(), "register at balance > 0");
        // break-glass needs an open dispute; the guard itself cannot open one
        let mut d = Map::new(&w.env); d.set(w.buyer.clone(), part);
        assert!(!resolve(&w, "resolve_dispute", &d, K_BG, &w.k_bg, None, true), "no dispute open yet");
        assert!(!dispute(&w, &w.guard), "guard cannot open a dispute (DisputeResolverCannotDisputeTheEscrow)");
        assert!(dispute(&w, &w.platform));
        let mut ds = Map::new(&w.env); ds.set(w.seller.clone(), part);
        assert!(!resolve(&w, "resolve_dispute", &ds, K_BG, &w.k_bg, None, true), "break-glass to seller");
        let before = w.bal(&w.buyer);
        assert!(resolve(&w, "resolve_dispute", &d, K_BG, &w.k_bg, None, true));
        let got = w.bal(&w.buyer) - before;
        println!("[{}] break-glass refund of a 40% funded escrow: buyer got {} of {} (fees deducted pro rata; top-up off-escrow)", stringify!($m), got, part);
        assert_eq!(got, part - part * 30 / 10000 - part * (PFEE as i128) / 10000);
    }

    #[test]
    fn t06_withdraw_remaining_funds_only_to_buyer() {
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        assert!(dispute(&w, &w.platform));
        let mut ds = Map::new(&w.env); ds.set(w.seller.clone(), AMT / 10);
        assert!(!resolve(&w, "withdraw_remaining_funds", &ds, K_RES, &w.k_res, None, true), "partial withdraw to seller during dispute");
        let mut db = Map::new(&w.env); db.set(w.buyer.clone(), AMT / 10);
        assert!(resolve(&w, "withdraw_remaining_funds", &db, K_RES, &w.k_res, None, true), "TW allows partial withdraw while disputed; guard allows buyer only");
        println!("[{}] partial withdraw to buyer during open dispute: escrow left {}", stringify!($m), w.bal(&w.escrow));
    }

    #[test]
    fn t07_overfunding_excess_back_to_buyer_after_release_and_closed() {
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        assert!(ship_and_approve(&w));
        assert!(release(&w, K_REL, &w.k_rel, true));
        // third-party deposit after release
        w.mint(&w.platform, 5_0000000); w.env.mock_all_auths();
        TokenClient::new(&w.env, &w.token).transfer(&w.platform, &w.escrow, &5_0000000);
        let mut ds = Map::new(&w.env); ds.set(w.seller.clone(), 5_0000000);
        assert!(!resolve(&w, "withdraw_remaining_funds", &ds, K_RES, &w.k_res, None, true));
        let mut db = Map::new(&w.env); db.set(w.buyer.clone(), 5_0000000);
        assert!(resolve(&w, "withdraw_remaining_funds", &db, K_RES, &w.k_res, None, true));
        assert_eq!(w.bal(&w.escrow), 0);
    }

    #[test]
    fn t08_wasm_and_token_pins() {
        let w = setup();
        // escrow running the other TW lineage, same roles
        let o = other_wasm_escrow(&w);
        assert!(w.guardc().try_check_escrow(&o).is_err());
        // look-alike contract returning a perfect Escrow value
        let fake = w.env.register(fakec::WASM, ());
        w.env.mock_all_auths();
        let p = props(&w, "x", &w.token);
        fakec::Client::new(&w.env, &fake).set(&p.into_val(&w.env));
        let r = w.guardc().try_register_escrow(&fake);
        println!("[{}] fake escrow registration: {:?}", stringify!($m), r);
        assert!(r.is_err());
        // a TW escrow on the pinned Wasm but another token
        let issuer2 = Address::generate(&w.env);
        let tok2 = w.env.register_stellar_asset_contract_v2(issuer2).address();
        let e2 = w.env.register($wasm, ());
        w.env.mock_all_auths();
        twc::Client::new(&w.env, &e2).initialize_escrow(&props(&w, "", &tok2));
        let r2 = w.guardc().try_check_escrow(&e2);
        println!("[{}] wrong-token escrow precheck: {:?}", stringify!($m), r2);
        assert!(r2.is_err());
        // the real one passes the precheck before funding
        assert!(matches!(w.guardc().try_check_escrow(&w.escrow), Ok(Ok(()))));
    }

    #[test]
    fn t09_cancel_arbiter_and_dispute_before_funding() {
        // (a) unfunded: platform edits the escrow; the buyer's pre-built funding (old expected_escrow) then fails
        let w = setup();
        let old = tw(&w).get_escrow();
        w.env.mock_all_auths();
        let mut p = props(&w, "", &w.token); p.title = SStr::from_str(&w.env, "cancelled");
        assert!(matches!(tw(&w).try_update_escrow(&w.platform, &p), Ok(Ok(_))));
        w.mint(&w.buyer, AMT); w.env.mock_all_auths();
        assert!(tw(&w).try_fund_escrow(&w.buyer, &old, &AMT).is_err(), "EscrowPropertiesMismatch");
        // (b) funded: the same edit fails, so 'cancel' proves the escrow is still unfunded
        let w = setup();
        assert!(fund(&w, AMT));
        w.env.mock_all_auths();
        let mut p = props(&w, "", &w.token); p.title = SStr::from_str(&w.env, "cancelled");
        assert!(tw(&w).try_update_escrow(&w.platform, &p).is_err());
        // (c) a dispute opened before funding makes the buyer's funding (flags false) fail
        let w = setup();
        let old = tw(&w).get_escrow();
        assert!(dispute(&w, &w.buyer));
        assert!(w.guardc().try_check_escrow(&w.escrow).is_err(), "precheck refuses a disputed escrow");
        w.mint(&w.buyer, AMT); w.env.mock_all_auths();
        assert!(tw(&w).try_fund_escrow(&w.buyer, &old, &AMT).is_err());
    }

    #[test]
    fn t10_platform_can_append_milestone_while_funded_blocking_release_recover_by_refund() {
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        w.env.mock_all_auths();
        let mut e = tw(&w).get_escrow();
        e.milestones.push_back(twc::Milestone { description: SStr::from_str(&w.env, "extra"), status: SStr::from_str(&w.env, ""), evidence: SStr::from_str(&w.env, ""), approved: false });
        let r = tw(&w).try_update_escrow(&w.platform, &e);
        println!("[{}] append milestone while funded: ok={}", stringify!($m), matches!(r, Ok(Ok(_))));
        assert!(matches!(r, Ok(Ok(_))));
        assert!(ship_and_approve(&w));
        assert!(!release(&w, K_REL, &w.k_rel, true), "release blocked by the appended milestone");
        assert!(w.register(), "re-registration: buyer, seller, amount unchanged");
        assert!(dispute(&w, &w.platform));
        let mut d = Map::new(&w.env); d.set(w.buyer.clone(), AMT);
        assert!(resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
    }

    #[test]
    fn t11_dispute_cannot_be_withdrawn() {
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        assert!(dispute(&w, &w.buyer));
        assert!(ship_and_approve(&w));
        assert!(!release(&w, K_REL, &w.k_rel, true), "EscrowOpenedForDisputeResolution");
    }

    #[test]
    fn t12_key_rotation_timelock_and_resolver_holder() {
        let w = setup();
        let nk = BytesN::from_array(&w.env, &[9; 32]);
        w.env.mock_all_auths();
        w.guardc().propose_keys(&nk, &nk, &nk);
        assert!(w.guardc().try_apply_keys().is_err(), "timelocked");
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        assert!(matches!(w.guardc().try_apply_keys(), Ok(Ok(()))));
        w.env.mock_all_auths();
        w.guardc().rotate_resolver(&nk);
        let auths = w.env.auths();
        assert_eq!(auths[0].0, w.resolver_admin);
    }

    #[test]
    fn t14_empty_milestone_status_is_permanent_unless_platform_fixes_it_before_funding() {
        // what the v1 API is documented to deploy if it passes no status
        let w = setup_status("");
        assert!(w.guardc().try_check_escrow(&w.escrow).is_err(), "precheck refuses an empty status");
        w.env.mock_all_auths();
        let r = tw(&w).try_change_milestone_status(&0, &SStr::from_str(&w.env, "shipped"), &None, &w.seller);
        println!("[{}] change_milestone_status from an EMPTY status: {:?}", stringify!($m), r);
        assert!(r.is_err());
        assert!(tw(&w).try_approve_milestone(&0, &w.buyer).is_err());
        // fix while unfunded: the platform sets the status through update_escrow
        let p = props(&w, "awaiting delivery", &w.token);
        assert!(matches!(tw(&w).try_update_escrow(&w.platform, &p), Ok(Ok(_))));
        assert!(matches!(w.guardc().try_check_escrow(&w.escrow), Ok(Ok(()))));
        assert!(fund(&w, AMT)); assert!(w.register());
        assert!(ship_and_approve(&w));
        assert!(release(&w, K_REL, &w.k_rel, true));
    }

    #[test]
    fn t13_atomic_deploy_through_tw_deployer_then_precheck() {
        let w = setup();
        let h = w.env.deployer().upload_contract_wasm($wasm);
        let p = props(&w, "awaiting delivery", &w.token);
        let deployer = Address::generate(&w.env);
        // the deployer entry point runs only on an UNINITIALISED instance (EscrowAlreadyInitialized otherwise)
        let factory = w.env.register($wasm, ());
        w.env.mock_all_auths();
        let (addr, _) = twc::Client::new(&w.env, &factory).tw_new_single_release_escrow(&deployer, &h, &BytesN::from_array(&w.env, &[7; 32]),
            &Symbol::new(&w.env, "initialize_escrow"), &soroban_sdk::vec![&w.env, p.into_val(&w.env)], &soroban_sdk::vec![&w.env]);
        assert!(matches!(w.guardc().try_check_escrow(&addr), Ok(Ok(()))));
        // initialize_escrow itself needs no auth, so a separate init tx could be front-run:
        let e3 = w.env.register($wasm, ());
        w.env.set_auths(&[]);
        let r = twc::Client::new(&w.env, &e3).try_initialize_escrow(&props(&w, "", &w.token));
        println!("[{}] initialize_escrow with NO auth entries: ok={}", stringify!($m), matches!(r, Ok(Ok(_))));
    }
    // ------------------------------------------------ v0.7: pins, dust, approval path and contest

    /// Builds a second escrow on the pinned Wasm with edited roles, funded by the buyer.
    fn escrow_with(w: &W, f: impl Fn(&mut twc::Escrow)) -> Address {
        let e2 = w.env.register($wasm, ());
        let mut p = props(w, "awaiting delivery", &w.token);
        f(&mut p);
        w.env.mock_all_auths();
        twc::Client::new(&w.env, &e2).initialize_escrow(&p);
        e2
    }

    #[test]
    fn t15_platform_and_receiver_pins() {
        let w = setup();
        // (1) another platform address: refused by the precheck and by registration once funded
        let rogue = Address::generate(&w.env);
        let e2 = escrow_with(&w, |p| p.roles.platform = rogue.clone());
        let r = w.guardc().try_check_escrow(&e2);
        println!("[{}] precheck, escrow with another platform: {:?}", stringify!($m), r);
        assert_eq!(r, Err(Ok(GErr::BadPlatform)));
        w.mint(&w.buyer, AMT); w.env.mock_all_auths();
        let snap = twc::Client::new(&w.env, &e2).get_escrow();
        twc::Client::new(&w.env, &e2).fund_escrow(&w.buyer, &snap, &AMT);
        assert_eq!(w.guardc().try_register_escrow(&e2), Err(Ok(GErr::BadPlatform)), "a funded escrow with another platform never registers");
        // receiver must equal service_provider (the seller)
        let other = Address::generate(&w.env);
        let e3 = escrow_with(&w, |p| p.roles.receiver = other.clone());
        assert_eq!(w.guardc().try_check_escrow(&e3), Err(Ok(GErr::BadRoles)));
        // the honest escrow passes
        assert_eq!(w.guardc().try_check_escrow(&w.escrow), Ok(Ok(())));
    }

    #[test]
    fn t16_dust_before_funding_gives_no_head_start_and_dust_goes_to_buyer() {
        let w = setup();
        let snap = tw(&w).get_escrow(); // what the buyer's funding call commits to
        w.dust(1);
        assert_eq!(w.guardc().try_check_escrow(&w.escrow), Err(Ok(GErr::NotEmpty)), "dusted escrow is never shown to a buyer");
        assert!(w.register(), "dust registers the escrow (roles are frozen)...");
        assert!(w.reg_of().funded_at.is_none(), "...but it is not funded");
        w.env.ledger().with_mut(|l| l.timestamp += 60);
        let early = w.anchor_claim(&w.escrow, 31, 8, 7); // anchored after registration, before the buyer funds
        w.env.ledger().with_mut(|l| l.timestamp += 60);
        // dust does not change the stored escrow, so the buyer's pre-built funding still lands
        w.mint(&w.buyer, AMT); w.env.mock_all_auths();
        assert!(matches!(tw(&w).try_fund_escrow(&w.buyer, &snap, &AMT), Ok(Ok(_))));
        assert!(w.register());
        let fa = w.reg_of().funded_at.unwrap();
        println!("[{}] dust: registered_at {} funded_at {} (claim anchored in between)", stringify!($m), w.reg_of().registered_at, fa);
        assert!(dispute(&w, &w.platform));
        w.env.ledger().with_mut(|l| l.timestamp += 8 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT); d.set(w.buyer.clone(), 1);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, Some(early), true), "claim anchored before full funding");
        assert!(w.guard_err(16), "ClaimPredatesEscrow");
        w.env.ledger().with_mut(|l| l.timestamp += 60);
        let good = w.anchor_claim(&w.escrow, 32, 8, 8);
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        let b0 = w.bal(&w.buyer);
        assert!(resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, Some(good), true));
        println!("[{}] dust split: seller {} buyer +{}", stringify!($m), w.bal(&w.seller), w.bal(&w.buyer) - b0);
        assert_eq!(w.bal(&w.buyer) - b0, 1, "the dust goes to the buyer, fee-free at 1 unit");
        let net = AMT - AMT * 30 / 10000 - AMT * (PFEE as i128) / 10000;
        assert!(w.bal(&w.seller) >= net && w.bal(&w.seller) <= net + 2, "per-recipient fee floors: at most a few units in the seller's favour");
        assert_eq!(w.bal(&w.escrow), 0);
    }

    #[test]
    fn t17_dust_after_release_is_withdrawn_to_buyer_only() {
        let w = setup();
        let snap = tw(&w).get_escrow();
        w.dust(3);
        w.mint(&w.buyer, AMT); w.env.mock_all_auths();
        assert!(matches!(tw(&w).try_fund_escrow(&w.buyer, &snap, &AMT), Ok(Ok(_))));
        assert!(w.register());
        assert!(ship_and_approve(&w));
        assert!(release(&w, K_REL, &w.k_rel, true));
        assert_eq!(w.bal(&w.escrow), 3, "release pays escrow.amount; the dust stays");
        let mut ds = Map::new(&w.env); ds.set(w.seller.clone(), 3);
        assert!(!resolve(&w, "withdraw_remaining_funds", &ds, K_RES, &w.k_res, None, true));
        assert!(w.guard_err(9), "BadRecipient");
        let mut db = Map::new(&w.env); db.set(w.buyer.clone(), 3);
        let b0 = w.bal(&w.buyer);
        assert!(resolve(&w, "withdraw_remaining_funds", &db, K_RES, &w.k_res, None, true));
        assert_eq!(w.bal(&w.buyer) - b0, 3);
    }

    #[test]
    fn t18_dusted_unfunded_escrow_is_cancelled_by_platform_dispute() {
        let w = setup();
        let snap = tw(&w).get_escrow();
        w.dust(1);
        // the title-edit cancel (earlier design) fails once any balance exists
        w.env.mock_all_auths();
        let mut p = props(&w, "awaiting delivery", &w.token); p.title = SStr::from_str(&w.env, "cancelled");
        assert!(tw(&w).try_update_escrow(&w.platform, &p).is_err(), "update lock from dust");
        // v0.7 arbiter when the buyer has funded nothing: platform opens a dispute
        assert!(dispute(&w, &w.platform));
        w.mint(&w.buyer, AMT); w.env.mock_all_auths();
        assert!(tw(&w).try_fund_escrow(&w.buyer, &snap, &AMT).is_err(), "buyer's pre-built funding call now fails");
        assert!(w.guardc().try_check_escrow(&w.escrow).is_err());
        // residual: a buyer who deliberately builds a NEW funding call can still pay in; it is refunded whole
        let cur = tw(&w).get_escrow();
        w.env.mock_all_auths();
        let late = tw(&w).try_fund_escrow(&w.buyer, &cur, &AMT);
        println!("[{}] fresh funding into a disputed (cancelled) escrow: ok={}", stringify!($m), matches!(late, Ok(Ok(_))));
        assert!(w.register());
        let mut d = Map::new(&w.env); d.set(w.buyer.clone(), w.bal(&w.escrow));
        assert!(resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        assert_eq!(w.bal(&w.escrow), 0);
    }

    #[test]
    fn t19_dust_before_status_fix_makes_the_escrow_unusable_so_fields_are_final_at_deploy() {
        let w = setup_status("");
        w.dust(1);
        w.env.mock_all_auths();
        let p = props(&w, "awaiting delivery", &w.token);
        assert!(tw(&w).try_update_escrow(&w.platform, &p).is_err(), "status can no longer be fixed");
        assert!(w.guardc().try_check_escrow(&w.escrow).is_err(), "never shown to a buyer; abandoned");
        // the deployer path sets every field in the deploy transaction, so no edit is ever needed
        let h = w.env.deployer().upload_contract_wasm($wasm);
        let factory = w.env.register($wasm, ());
        w.env.mock_all_auths();
        let (addr, _) = twc::Client::new(&w.env, &factory).tw_new_single_release_escrow(&Address::generate(&w.env), &h, &BytesN::from_array(&w.env, &[8; 32]),
            &Symbol::new(&w.env, "initialize_escrow"), &soroban_sdk::vec![&w.env, p.into_val(&w.env)], &soroban_sdk::vec![&w.env]);
        assert_eq!(w.guardc().try_check_escrow(&addr), Ok(Ok(())));
    }

    /// Seller (service provider) opens a dispute after the buyer approved: release is blocked by TW.
    fn approved_then_seller_dispute() -> W {
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        assert!(ship_and_approve(&w));
        assert!(w.register());
        assert!(w.reg_of().approved_at.is_some());
        assert!(dispute(&w, &w.seller));
        assert!(!release(&w, K_REL, &w.k_rel, true), "EscrowOpenedForDisputeResolution");
        w
    }

    #[test]
    fn t20_seller_dispute_after_buyer_approval_pays_seller_after_window() {
        let w = approved_then_seller_dispute();
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT);
        w.env.ledger().with_mut(|l| l.timestamp += 8 * DAY);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        assert!(w.guard_err(27), "NoDisputeSeen: the clock starts only when the dispute is recorded");
        assert!(w.register());
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        assert!(w.guard_err(10), "TooEarly");
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY - 1);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true), "one second early");
        assert!(!resolve(&w, "resolve_dispute", &d, K_BG, &w.k_bg, None, true), "break-glass never pays the seller");
        w.env.ledger().with_mut(|l| l.timestamp += 1);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_rel, None, true), "release key cannot sign a resolution");
        assert!(resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        println!("[{}] approved + seller dispute, no contest, after window: seller {} (release would pay {})", stringify!($m), w.bal(&w.seller), AMT - AMT * 30 / 10000 - AMT * (PFEE as i128) / 10000);
        assert_eq!(w.bal(&w.seller), AMT - AMT * 30 / 10000 - AMT * (PFEE as i128) / 10000, "same net as the blocked release");
        assert!(w.reg_of().closed);
    }

    #[test]
    fn t21_buyer_contest_restores_the_claim_rule() {
        let w = approved_then_seller_dispute();
        assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += DAY);
        // only the buyer can contest
        w.env.set_auths(&[]);
        assert!(w.guardc().try_contest(&w.escrow, &BytesN::from_array(&w.env, &[1; 32])).is_err(), "no buyer auth");
        assert!(w.contest());
        assert_eq!(w.env.auths()[0].0, w.buyer, "contest is authorised by the stored buyer");
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        assert!(w.guard_err(25), "Contested");
        // the ordinary claim rule still pays the seller...
        let claim = w.anchor_claim(&w.escrow, 41, 8, 11);
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        assert!(resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, Some(claim), true));
        assert!(w.bal(&w.seller) > 0);
    }

    #[test]
    fn t22_contest_window_closes_and_refund_stays_open() {
        let w = approved_then_seller_dispute();
        assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        assert!(!w.contest(), "ContestTooLate");
        // until the resolution lands, the resolver can still refund the buyer instead
        let mut d = Map::new(&w.env); d.set(w.buyer.clone(), AMT);
        assert!(resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        assert!(!w.contest(), "closed");
    }

    #[test]
    fn t23_no_approval_or_partial_funding_never_uses_the_approval_path() {
        // (a) silent buyer: no approval, seller dispute, window long past: still needs a claim
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        assert!(dispute(&w, &w.seller)); assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 30 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        assert!(w.guard_err(8), "NoClaim");
        // (b) TW lets the buyer approve DURING a dispute; the window then runs from the approval
        assert!(ship_and_approve(&w));
        assert!(w.register());
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true), "window restarts at approval");
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        assert!(resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        // (c) partial funding + approval + dispute: never pays the seller without full funding
        let w = setup();
        assert!(fund(&w, AMT / 2)); assert!(w.register());
        assert!(ship_and_approve(&w));
        assert!(dispute(&w, &w.seller)); assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 8 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT / 2);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        assert!(w.guard_err(3), "NotFunded");
        let mut db = Map::new(&w.env); db.set(w.buyer.clone(), AMT / 2);
        assert!(resolve(&w, "resolve_dispute", &db, K_RES, &w.k_res, None, true));
    }

    #[test]
    fn t24_buyer_dispute_after_approval_needs_the_buyer_contest_too() {
        // TW stores only a dispute FLAG, not who opened it, so the guard cannot tell a buyer dispute from a
        // seller dispute. The platform's UI therefore has the buyer sign guard.contest together with any buyer dispute.
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        assert!(ship_and_approve(&w));
        assert!(dispute(&w, &w.buyer), "the approver can still open a dispute after approving");
        assert!(w.register());
        assert!(w.contest(), "buyer UI: dispute + contest");
        w.env.ledger().with_mut(|l| l.timestamp += 30 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        assert!(w.guard_err(25), "Contested: no claimless seller payout");
        // without the contest the same on-chain state would be payable to the seller after the window
        let w2 = setup();
        assert!(fund(&w2, AMT)); assert!(w2.register());
        assert!(ship_and_approve(&w2));
        assert!(dispute(&w2, &w2.buyer)); assert!(w2.register());
        w2.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        let mut d2 = Map::new(&w2.env); d2.set(w2.seller.clone(), AMT);
        assert!(resolve(&w2, "resolve_dispute", &d2, K_RES, &w2.k_res, None, true), "uncontested buyer dispute after approval: payable like the approved release");
    }

    #[test]
    fn t25_third_party_full_funding_sets_funded_at_but_never_pays_the_seller_alone() {
        // fund_escrow accepts any signer. The guard sees only the balance; "paid" is the adapter's rule
        // (the buyer's own fund_escrow, signer == approver, for exactly the amount). This test pins what the
        // guard alone does when someone else funds in full: no seller payout without a claim or the buyer's approval.
        let w = setup();
        let third = Address::generate(&w.env);
        w.mint(&third, AMT); w.env.mock_all_auths();
        let snap = tw(&w).get_escrow();
        assert!(matches!(tw(&w).try_fund_escrow(&third, &snap, &AMT), Ok(Ok(_))), "TW accepts a non-buyer funder");
        assert!(w.register());
        assert!(w.reg_of().funded_at.is_some());
        assert!(dispute(&w, &w.seller)); assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 30 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        assert!(w.guard_err(8), "NoClaim: no approval on record and no claim (the platform issues claims only for orders paid by the buyer)");
        assert!(!release(&w, K_REL, &w.k_rel, true), "no buyer approval, no release");
        let mut db = Map::new(&w.env); db.set(w.buyer.clone(), AMT);
        assert!(resolve(&w, "resolve_dispute", &db, K_RES, &w.k_res, None, true), "unwound to the buyer");
    }

    // ------------------------------------------------ adversarial tests (expect SAFE behaviour; v0.8 fixes)
    fn net(x: i128) -> i128 { x - x * 30 / 10000 - x * (PFEE as i128) / 10000 }

    #[test]
    fn x01_overfunded_approval_path_must_not_pay_seller_more_than_release() {
        // buyer funds twice (double submit: expected_escrow does not change on funding), approves; seller disputes
        let w = setup();
        assert!(fund(&w, AMT)); assert!(fund(&w, AMT)); assert!(w.register());
        assert!(ship_and_approve(&w)); assert!(w.register());
        assert!(dispute(&w, &w.seller)); assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), 2 * AMT);
        let paid = resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true);
        let e28 = w.guard_err(28);
        println!("[{}] x01 approval path, balance 2x amount, map seller=2x: ok={} seller={} (release net {})", stringify!($m), paid, w.bal(&w.seller), net(AMT));
        assert!(!paid, "guard must cap the seller share at the approved amount"); assert!(e28, "SellerOverAmount");
        // honest split still works
        let mut d2 = Map::new(&w.env); d2.set(w.seller.clone(), AMT); d2.set(w.buyer.clone(), AMT);
        assert!(resolve(&w, "resolve_dispute", &d2, K_RES, &w.k_res, None, true));
    }

    #[test]
    fn x02_dust_must_not_reach_seller_in_approval_path() {
        let w = setup();
        assert!(fund(&w, AMT)); w.dust(5); assert!(w.register());
        assert!(ship_and_approve(&w)); assert!(dispute(&w, &w.seller)); assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT + 5);
        let paid = resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true);
        println!("[{}] x02 dust to seller via approval path: ok={}", stringify!($m), paid);
        assert!(!paid, "'dust always ends with the buyer' must be enforced on-chain"); assert!(w.guard_err(28));
    }

    #[test]
    fn x03_overfunded_claim_path_must_not_pay_seller_more_than_amount() {
        let w = setup();
        assert!(fund(&w, AMT)); assert!(fund(&w, AMT)); assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 60);
        assert!(dispute(&w, &w.platform));
        let claim = w.anchor_claim(&w.escrow, 91, 8, 13);
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), 2 * AMT);
        let paid = resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, Some(claim), true);
        println!("[{}] x03 claim path, seller=2x amount: ok={}", stringify!($m), paid);
        assert!(!paid); assert!(w.guard_err(28));
    }

    #[test]
    fn x04_contest_first_then_dispute_is_safe_ordering() {
        // two transactions cannot be atomic (one InvokeHostFunction per tx); contest BEFORE the dispute works
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        assert!(ship_and_approve(&w));
        assert!(w.contest(), "contest with no dispute on record is accepted");
        assert!(dispute(&w, &w.buyer)); assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 30 * DAY);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        assert!(w.guard_err(25));
    }

    #[test]
    fn x05_contest_on_unregistered_escrow_fails() {
        let w = setup();
        assert!(fund(&w, AMT)); // nobody called register_escrow
        assert!(ship_and_approve(&w));
        let ok = w.contest();
        println!("[{}] x05 contest before any registration: ok={}", stringify!($m), ok);
        assert!(!ok, "NotRegistered: the dispute screen must register first (or contest should self-register)");
    }

    #[test]
    fn x06_window_boundary_and_late_registration() {
        let w = setup();
        assert!(fund(&w, AMT)); assert!(w.register());
        assert!(ship_and_approve(&w)); assert!(dispute(&w, &w.seller));
        // nobody records the dispute for 3 days: the window starts only at recording, never earlier
        w.env.ledger().with_mut(|l| l.timestamp += 3 * DAY);
        assert!(w.register());
        let s = w.reg_of().disputed_at.unwrap();
        assert_eq!(s, w.env.ledger().timestamp());
        w.env.ledger().with_mut(|l| l.timestamp = s + 7 * DAY - 1);
        let mut d = Map::new(&w.env); d.set(w.seller.clone(), AMT);
        assert!(!resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true));
        w.env.ledger().with_mut(|l| l.timestamp = s + 7 * DAY);
        assert!(!w.contest(), "contest refused at exactly s + window");
        assert!(resolve(&w, "resolve_dispute", &d, K_RES, &w.k_res, None, true), "payout allowed at exactly s + window: no overlap, no gap");
    }

    #[test]
    fn x07_guard_auth_cannot_be_used_on_a_non_tw_contract() {
        // a fake escrow on another Wasm cannot be registered, so __check_auth for it fails NotRegistered
        let w = setup();
        let fake = w.env.register(fakec::WASM, ());
        w.env.mock_all_auths();
        fakec::Client::new(&w.env, &fake).set(&props(&w, "x", &w.token).into_val(&w.env));
        assert!(w.guardc().try_register_escrow(&fake).is_err());
        assert!(w.guardc().registration(&fake).is_none());
    }

}
    };
}

pub type R = Result<(), std::string::String>;
pub fn ok<T: core::fmt::Debug>(r: T, okp: bool) -> R {
    if okp {
        Ok(())
    } else {
        Err(std::format!("{:?}", r))
    }
}
pub fn rel_call_tn(w: &W, f: &Address) -> R {
    let r = tnc::Client::new(&w.env, &w.escrow).try_release_funds(&w.guard, f);
    let b = matches!(r, Ok(Ok(_)));
    ok(r, b)
}
pub fn res_call_tn(w: &W, f: &Address, d: &Map<Address, i128>) -> R {
    let r = tnc::Client::new(&w.env, &w.escrow).try_resolve_dispute(&w.guard, f, d);
    let b = matches!(r, Ok(Ok(_)));
    ok(r, b)
}
pub fn wrf_call_tn(w: &W, f: &Address, d: &Map<Address, i128>) -> R {
    let r = tnc::Client::new(&w.env, &w.escrow).try_withdraw_remaining_funds(&w.guard, f, d);
    let b = matches!(r, Ok(Ok(_)));
    ok(r, b)
}
pub fn rel_call_mn(w: &W, _f: &Address) -> R {
    let r = mnc::Client::new(&w.env, &w.escrow).try_release_funds(&w.guard);
    let b = matches!(r, Ok(Ok(_)));
    ok(r, b)
}
pub fn res_call_mn(w: &W, _f: &Address, d: &Map<Address, i128>) -> R {
    let r = mnc::Client::new(&w.env, &w.escrow).try_resolve_dispute(&w.guard, d);
    let b = matches!(r, Ok(Ok(_)));
    ok(r, b)
}
pub fn wrf_call_mn(w: &W, _f: &Address, d: &Map<Address, i128>) -> R {
    let r = mnc::Client::new(&w.env, &w.escrow).try_withdraw_remaining_funds(&w.guard, d);
    let b = matches!(r, Ok(Ok(_)));
    ok(r, b)
}

mod tn_glue {
    pub use super::{rel_call_tn as rel_call, res_call_tn as res_call, wrf_call_tn as wrf_call};
}
mod mn_glue {
    pub use super::{rel_call_mn as rel_call, res_call_mn as res_call, wrf_call_mn as wrf_call};
}

mod tn_wrap {
    pub use super::tn_glue::*;
    pub use super::*;
    lineage!(tn, tnc, TN_WASM, true, MN_WASM);
}
mod mn_wrap {
    pub use super::mn_glue::*;
    pub use super::*;
    lineage!(mn, mnc, MN_WASM, false, TN_WASM);
}

/// Mainnet lineage only: with no EURC trustline on the hardcoded fee account, EVERY exit reverts,
/// break-glass included. Deployment runbook: give the fee account a EURC trustline first.
#[test]
fn m01_mainnet_wasm_without_fee_account_trustline_blocks_every_exit() {
    let w = world(MN_WASM, false); // no give_gbww_trustline
    w.env.mock_all_auths();
    let tw = mnc::Client::new(&w.env, &w.escrow);
    let mut ms = soroban_sdk::Vec::new(&w.env);
    ms.push_back(mnc::Milestone {
        description: SStr::from_str(&w.env, "p"),
        status: SStr::from_str(&w.env, "awaiting delivery"),
        evidence: SStr::from_str(&w.env, ""),
        approved: false,
    });
    tw.initialize_escrow(&mnc::Escrow {
        engagement_id: SStr::from_str(&w.env, "r"),
        title: SStr::from_str(&w.env, "t"),
        description: SStr::from_str(&w.env, "d"),
        roles: mnc::Roles {
            approver: w.buyer.clone(),
            service_provider: w.seller.clone(),
            platform: w.platform.clone(),
            release_signer: w.guard.clone(),
            dispute_resolver: w.guard.clone(),
            receiver: w.seller.clone(),
        },
        amount: AMT,
        platform_fee: PFEE,
        milestones: ms,
        flags: mnc::Flags {
            disputed: false,
            released: false,
            resolved: false,
        },
        trustline: mnc::Trustline {
            address: w.token.clone(),
        },
        receiver_memo: 0,
    });
    w.mint(&w.buyer, AMT);
    w.env.mock_all_auths();
    let e = tw.get_escrow();
    tw.fund_escrow(&w.buyer, &e, &AMT);
    assert!(w.register());
    w.env.mock_all_auths();
    tw.approve_milestone(&0, &w.buyer);
    let a = w.guard_auth(
        "release_funds",
        soroban_sdk::vec![&w.env, w.guard.into_val(&w.env)],
        K_REL,
        &w.k_rel,
        None,
    );
    w.env.set_auths(&[a]);
    let r = tw.try_release_funds(&w.guard);
    println!("[m01] release with no fee-account trustline: {:?}", r);
    for ev in w
        .env
        .host()
        .get_diagnostic_events()
        .unwrap()
        .0
        .iter()
        .rev()
        .take(40)
    {
        let t = std::format!("{:?}", ev.event);
        if t.contains("trustline") {
            println!("[m01] diag: {}", &t[..t.len().min(300)]);
            break;
        }
    }
    assert!(r.is_err());
    w.env.mock_all_auths();
    tw.dispute_escrow(&w.platform);
    let mut d = Map::new(&w.env);
    d.set(w.buyer.clone(), AMT);
    let a = w.guard_auth(
        "resolve_dispute",
        soroban_sdk::vec![&w.env, w.guard.into_val(&w.env), d.into_val(&w.env)],
        K_BG,
        &w.k_bg,
        None,
    );
    w.env.set_auths(&[a]);
    let r = tw.try_resolve_dispute(&w.guard, &d);
    println!(
        "[m01] break-glass refund with no fee-account trustline: {:?}",
        r
    );
    assert!(r.is_err());
    give_gbww_trustline(&w);
    let a = w.guard_auth(
        "resolve_dispute",
        soroban_sdk::vec![&w.env, w.guard.into_val(&w.env), d.into_val(&w.env)],
        K_BG,
        &w.k_bg,
        None,
    );
    w.env.set_auths(&[a]);
    let r = tw.try_resolve_dispute(&w.guard, &d);
    println!(
        "[m01] same refund after the trustline exists: ok={}",
        matches!(r, Ok(Ok(_)))
    );
    assert!(matches!(r, Ok(Ok(_))));
}

/// Metering: the guard compiled to Wasm, TW testnet production Wasm, seller resolution with a depth-32 proof.
#[test]
fn m02_metering_wasm_guard_depth32_seller_resolution_and_release() {
    for (lin, wasm, fee_arg) in [("tn", TN_WASM, true), ("mn", MN_WASM, false)] {
        let w = world_opts(wasm, fee_arg, true);
        if !fee_arg {
            give_gbww_trustline(&w);
        }
        w.env.mock_all_auths();
        let mut ms = soroban_sdk::Vec::new(&w.env);
        // build the escrow via the testnet module types (identical v1 layout) using raw invoke
        ms.push_back(tnc::Milestone {
            description: SStr::from_str(&w.env, "p"),
            status: SStr::from_str(&w.env, "awaiting delivery"),
            evidence: SStr::from_str(&w.env, ""),
            approved: false,
        });
        let p = tnc::Escrow {
            engagement_id: SStr::from_str(&w.env, "r"),
            title: SStr::from_str(&w.env, "t"),
            description: SStr::from_str(&w.env, "d"),
            roles: tnc::Roles {
                approver: w.buyer.clone(),
                service_provider: w.seller.clone(),
                platform: w.platform.clone(),
                release_signer: w.guard.clone(),
                dispute_resolver: w.guard.clone(),
                receiver: w.seller.clone(),
            },
            amount: AMT,
            platform_fee: PFEE,
            milestones: ms,
            flags: tnc::Flags {
                disputed: false,
                released: false,
                resolved: false,
            },
            trustline: tnc::Trustline {
                address: w.token.clone(),
            },
            receiver_memo: 0,
        };
        let _: Val = w.env.invoke_contract(
            &w.escrow,
            &Symbol::new(&w.env, "initialize_escrow"),
            soroban_sdk::vec![&w.env, p.into_val(&w.env)],
        );
        w.mint(&w.buyer, AMT);
        w.env.mock_all_auths();
        let e: Val = w.env.invoke_contract(
            &w.escrow,
            &Symbol::new(&w.env, "get_escrow"),
            soroban_sdk::vec![&w.env],
        );
        let _: Val = w.env.invoke_contract(
            &w.escrow,
            &Symbol::new(&w.env, "fund_escrow"),
            soroban_sdk::vec![&w.env, w.buyer.into_val(&w.env), e, AMT.into_val(&w.env)],
        );
        assert!(w.register());
        w.env.ledger().with_mut(|l| l.timestamp += 60);
        let _: Val = w.env.invoke_contract(
            &w.escrow,
            &Symbol::new(&w.env, "dispute_escrow"),
            soroban_sdk::vec![&w.env, w.platform.into_val(&w.env)],
        );
        let claim = w.anchor_claim(&w.escrow, 77, 32, 6);
        w.env.ledger().with_mut(|l| l.timestamp += 7 * DAY);
        let mut d = Map::new(&w.env);
        d.set(w.seller.clone(), AMT);
        let args: soroban_sdk::Vec<Val> = if fee_arg {
            soroban_sdk::vec![
                &w.env,
                w.guard.into_val(&w.env),
                w.fee.into_val(&w.env),
                d.into_val(&w.env)
            ]
        } else {
            soroban_sdk::vec![&w.env, w.guard.into_val(&w.env), d.into_val(&w.env)]
        };
        let a = w.guard_auth(
            "resolve_dispute",
            args.clone(),
            K_RES,
            &w.k_res,
            Some(claim),
        );
        w.env.set_auths(&[a]);
        w.env.cost_estimate().budget().reset_default();
        let _: Val =
            w.env
                .invoke_contract(&w.escrow, &Symbol::new(&w.env, "resolve_dispute"), args);
        let b = w.env.cost_estimate().budget();
        println!(
            "[m02 {}] seller resolution, Wasm guard, depth-32 proof: cpu_insns={} mem_bytes={}",
            lin,
            b.cpu_instruction_cost(),
            b.memory_bytes_cost()
        );
        assert!(w.bal(&w.seller) > 0);
    }
}

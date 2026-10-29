//! # motored-escrow-guard (v0.9)
//!
//! A Soroban custom account (`__check_auth`) that holds both the `release_signer` and the
//! `dispute_resolver` role of a Trustless Work v1 **single-release** escrow and narrows what
//! those roles can do:
//!
//! * **Release** (`release_funds`): signed by the release key. Trustless Work itself requires
//!   every milestone approved by the buyer (the escrow `approver`) and no open dispute.
//! * **Resolve** (`resolve_dispute`, `withdraw_remaining_funds`): signed by the resolver key.
//!   Payouts may go only to the escrow's buyer and seller. Any seller share needs either
//!   (a) a delivery claim anchored in the claim registry after full funding and at least
//!   `delay` old, or (b) the buyer's approval on record, a dispute seen afterwards and no
//!   buyer `contest` within `contest_window`. The seller never receives more than the escrow
//!   amount; `withdraw_remaining_funds` may only ever pay the buyer.
//! * **Break-glass** (`resolve_dispute` only): signed by a separate, offline key. Refund only:
//!   the whole distribution goes to the buyer.
//!
//! The guard only registers escrows that run the pinned Trustless Work Wasm hash, use the pinned
//! token (EURC) and the pinned platform fee account, and name the guard in both roles.
//!
//! The tests in `src/test.rs` run every rule against Trustless Work's deployed v1 Wasm files
//! (testnet `7c3f7b2a...`, mainnet `96d51751...`), fetched by hash.
//!
//! **TTL upkeep (v0.9).** Every state-changing entry point extends the guard's instance (and code)
//! TTL, and every entry point that loads an escrow registration (`register_escrow`, `contest`,
//! `__check_auth`) extends that `Reg` entry's TTL, by [`TTL_THRESHOLD`] / [`TTL_EXTEND_TO`]. The
//! read-only views (`check_escrow`, `registration`) do not: they are run by simulation, where an
//! extension never reaches the ledger. The extension changes no rule: it runs on data the entry
//! point already loaded and never alters a stored value.
//!
//! **Status: unaudited. Testnet only.** See `docs/threat-model.md` and `docs/trust-model.md`.
#![no_std]
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    crypto::Hash,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Executable, Map, Symbol, TryFromVal, Val, Vec,
};

pub mod tw {
    //! Minimal mirror of the Trustless Work v1 single-release `storage/types.rs`
    //! (github.com/Trustless-Work/trustlesswork-smart-contract-stellar, branch
    //! single-release-main, commit 6e4d40e25057dc51fcffd9c5cbee05eaf369380a).
    //! Only the shapes needed to decode `get_escrow`; field order and names must match upstream.
    use soroban_sdk::{contracttype, Address, String, Vec};

    #[contracttype]
    #[derive(Clone)]
    pub struct Escrow {
        pub engagement_id: String,
        pub title: String,
        pub roles: Roles,
        pub description: String,
        pub amount: i128,
        pub platform_fee: u32,
        pub milestones: Vec<Milestone>,
        pub flags: Flags,
        pub trustline: Trustline,
        pub receiver_memo: u32,
    }

    #[contracttype]
    #[derive(Clone)]
    pub struct Milestone {
        pub description: String,
        pub status: String,
        pub evidence: String,
        pub approved: bool,
    }

    #[contracttype]
    #[derive(Clone)]
    pub struct Roles {
        pub approver: Address,
        pub service_provider: Address,
        pub platform: Address,
        pub release_signer: Address,
        pub dispute_resolver: Address,
        pub receiver: Address,
    }

    #[contracttype]
    #[derive(Clone)]
    pub struct Flags {
        pub disputed: bool,
        pub released: bool,
        pub resolved: bool,
    }

    #[contracttype]
    #[derive(Clone)]
    pub struct Trustline {
        pub address: Address,
    }
}

/// The one Trustless Work entry point the guard reads.
#[contractclient(name = "EscrowClient")]
pub trait EscrowIface {
    fn get_escrow(env: Env) -> tw::Escrow;
}

/// The claim registry entry points the guard reads (see the `claim-registry` crate).
/// Both trap on a registry error (for example a revoked batch in `anchored_at`), which fails
/// the authorization closed.
#[contractclient(name = "RegistryClient")]
pub trait RegistryIface {
    fn verify(
        env: Env,
        batch_id: u64,
        leaf: BytesN<32>,
        proof: Vec<BytesN<32>>,
        index: u32,
    ) -> bool;
    fn anchored_at(env: Env, batch_id: u64) -> u64;
}

/// Deployment configuration, fixed at construction except for the three ed25519 keys.
#[contracttype]
#[derive(Clone)]
pub struct Cfg {
    /// Offline key. Rotates the three guard keys, behind the `rotate_delay` timelock.
    pub admin: Address,
    /// The resolver-key holder (the platform or a licensed party). Rotates only the resolver key, at once.
    pub resolver_admin: Address,
    /// ed25519 public key for the release branch.
    pub release_pk: BytesN<32>,
    /// ed25519 public key for the resolver branches.
    pub resolver_pk: BytesN<32>,
    /// ed25519 public key for the refund-only break-glass branch.
    pub breakglass_pk: BytesN<32>,
    /// Claim registry contract.
    pub registry: Address,
    /// Settlement token: the EURC Stellar Asset Contract on this network.
    pub token: Address,
    /// Platform fee account (the Trustless Work `platform` role) on this network.
    pub platform: Address,
    /// Pinned Trustless Work single-release v1 Wasm hash on this network.
    pub tw_wasm: BytesN<32>,
    /// `Some(a)`: this Wasm lineage takes `trustless_work_address` as argument 1 and it must equal `a`.
    /// `None`: the Wasm hardcodes its fee account.
    pub tw_fee: Option<Address>,
    /// Seller payout without buyer approval: allowed once `now >= anchored_at + delay` (7 days).
    pub delay: u64,
    /// Timelock on admin key rotation.
    pub rotate_delay: u64,
    /// Buyer approval on record and a dispute seen: the seller is payable without a claim after this
    /// window (7 days) unless the buyer contested.
    pub contest_window: u64,
}

/// What the guard has observed about one escrow. Every timestamp is a ledger time at which
/// `register_escrow` first saw the condition on chain.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Reg {
    pub buyer: Address,
    pub seller: Address,
    pub amount: i128,
    /// First seen with balance > 0 (may be third-party dust).
    pub registered_at: u64,
    /// First seen with balance >= amount; seller claims must be anchored after this.
    pub funded_at: Option<u64>,
    /// First seen with every milestone approved (only the buyer can approve).
    pub approved_at: Option<u64>,
    /// First seen with the Trustless Work dispute flag set.
    pub disputed_at: Option<u64>,
    /// Buyer-signed `contest()` on the guard.
    pub contested_at: Option<u64>,
    /// Set once the guard has authorized a final payout.
    pub closed: bool,
}

/// A pending key rotation proposed by `admin`.
#[contracttype]
#[derive(Clone)]
pub struct Pending {
    pub release: BytesN<32>,
    pub resolver: BytesN<32>,
    pub breakglass: BytesN<32>,
    pub eta: u64,
}

#[contracttype]
enum DK {
    Cfg,
    Esc(Address),
    Pending,
}

/// A delivery claim for one escrow, proven against a root anchored in the claim registry.
/// The leaf layout is specified in `docs/leaf-format.md` and computed by [`leaf`].
#[contracttype]
#[derive(Clone)]
pub struct Claim {
    /// Opaque 32-byte order reference (no personal data).
    pub order_ref: BytesN<32>,
    /// Salted commitment to the parcel identifiers.
    pub parcels_commit: BytesN<32>,
    /// Hash of the carrier's delivered event reference.
    pub carrier_event_ref: BytesN<32>,
    /// Carrier delivery time, unix seconds.
    pub delivered_at: u64,
    pub batch_id: u64,
    pub proof: Vec<BytesN<32>>,
    pub index: u32,
}

/// Explicit branch selector: `ed25519_verify` traps on mismatch, so a branch cannot be found by trial.
#[contracttype]
#[derive(Clone)]
pub enum GuardSig {
    Release(BytesN<64>),
    /// Resolver payout with no delivery claim: to the buyer, or to the seller only on the
    /// approved-and-uncontested path.
    Resolve(BytesN<64>),
    /// Resolver payout that includes the seller on the strength of a delivery claim.
    ResolveSeller(ResolveSig),
    BreakGlass(BytesN<64>),
}

#[contracttype]
#[derive(Clone)]
pub struct ResolveSig {
    pub sig: BytesN<64>,
    pub claim: Claim,
}

/// Guard errors. Codes are stable and part of the public interface.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GErr {
    NotRegistered = 1,
    WrongRole = 2,
    NotFunded = 3,
    Changed = 4,
    BadContext = 5,
    BadFn = 6,
    NoClaim = 8,
    BadRecipient = 9,
    TooEarly = 10,
    BadToken = 11,
    BadWasm = 12,
    NotWholeToBuyer = 13,
    BadArgs = 14,
    BadFeeAddr = 15,
    ClaimPredatesEscrow = 16,
    Closed = 17,
    AlreadySettled = 18,
    NoPending = 19,
    Timelocked = 20,
    BadMilestone = 21,
    BadPlatform = 22,
    BadRoles = 23,
    NotEmpty = 24,
    Contested = 25,
    ContestTooLate = 26,
    NoDisputeSeen = 27,
    SellerOverAmount = 28,
}

#[contractevent]
pub struct KeysProposed {
    pub release: BytesN<32>,
    pub resolver: BytesN<32>,
    pub breakglass: BytesN<32>,
    pub eta: u64,
}

#[contractevent]
pub struct KeysApplied {
    pub release: BytesN<32>,
    pub resolver: BytesN<32>,
    pub breakglass: BytesN<32>,
}

#[contractevent]
pub struct ResolverRotated {
    pub resolver: BytesN<32>,
}

#[contractevent]
pub struct BuyerContested {
    #[topic]
    pub escrow: Address,
    pub evidence: BytesN<32>,
}

/// Ledgers per day at the ~5 s target ledger close time.
pub const LEDGERS_PER_DAY: u32 = 17_280;
/// TTL upkeep threshold: an entry whose remaining TTL is at or below 30 days is extended.
pub const TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;
/// TTL upkeep target: such an entry is extended to 60 days from the current ledger. The longest
/// unattended stretch the rules need is `delay` + `contest_window` (7 + 7 days with the deployed
/// configuration), well inside both values, and `register_escrow` is permissionless, so anyone
/// can top an escrow's registration up. The host clamps a persistent extension to the network's
/// maximum entry TTL, and a network minimum above these values makes the call a no-op.
pub const TTL_EXTEND_TO: u32 = 60 * LEDGERS_PER_DAY;

#[contract]
pub struct Guard;

fn cfg(env: &Env) -> Cfg {
    env.storage().instance().get(&DK::Cfg).unwrap()
}

/// Extends the guard's instance and code TTL (no-op while above the threshold).
fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Extends the TTL of one escrow registration (no-op while above the threshold).
fn bump_reg(env: &Env, k: &DK) {
    env.storage()
        .persistent()
        .extend_ttl(k, TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Delivery-claim leaf:
/// `sha256(0x01 || XDR(ScVal::Address(escrow)) || order_ref || parcels_commit || carrier_event_ref || u64_be(delivered_at))`.
pub fn leaf(env: &Env, escrow: &Address, c: &Claim) -> BytesN<32> {
    let mut b = Bytes::from_array(env, &[0x01]);
    b.append(&escrow.clone().to_xdr(env));
    b.append(&c.order_ref.clone().into());
    b.append(&c.parcels_commit.clone().into());
    b.append(&c.carrier_event_ref.clone().into());
    b.append(&Bytes::from_array(env, &c.delivered_at.to_be_bytes()));
    env.crypto().sha256(&b).into()
}

/// Checks the `trustless_work_address` argument (if this Wasm lineage has one) and returns the
/// index of the distributions argument (or of the end of args for `release_funds`).
fn fee_arg_ok(env: &Env, c: &Cfg, args: &Vec<Val>) -> Result<u32, GErr> {
    match &c.tw_fee {
        None => Ok(1),
        Some(f) => {
            let a = Address::try_from_val(env, &args.get(1).ok_or(GErr::BadArgs)?)
                .map_err(|_| GErr::BadArgs)?;
            if &a != f {
                return Err(GErr::BadFeeAddr);
            }
            Ok(2)
        }
    }
}

/// Decodes the distributions map, which must be the last argument at index `i`.
fn dist_at(env: &Env, args: &Vec<Val>, i: u32) -> Result<Map<Address, i128>, GErr> {
    if args.len() != i + 1 {
        return Err(GErr::BadArgs);
    }
    Map::<Address, i128>::try_from_val(env, &args.get(i).ok_or(GErr::BadArgs)?)
        .map_err(|_| GErr::BadArgs)
}

/// Pinned-Wasm check, then decode and check roles, token and platform.
fn inspect(env: &Env, c: &Cfg, escrow: &Address) -> Result<tw::Escrow, GErr> {
    match escrow.executable() {
        Some(Executable::Wasm(h)) if h == c.tw_wasm => {}
        _ => return Err(GErr::BadWasm),
    }
    let e = EscrowClient::new(env, escrow).get_escrow();
    let me = env.current_contract_address();
    if e.roles.release_signer != me || e.roles.dispute_resolver != me {
        return Err(GErr::WrongRole);
    }
    if e.trustline.address != c.token {
        return Err(GErr::BadToken);
    }
    if e.roles.platform != c.platform {
        return Err(GErr::BadPlatform);
    }
    if e.roles.receiver != e.roles.service_provider {
        return Err(GErr::BadRoles);
    }
    Ok(e)
}

/// Start of the buyer's contest window: both the approval and the dispute must have been seen.
fn window_start(r: &Reg) -> Option<u64> {
    match (r.approved_at, r.disputed_at) {
        (Some(a), Some(d)) => Some(if a > d { a } else { d }),
        _ => None,
    }
}

#[contractimpl]
impl Guard {
    pub fn __constructor(env: Env, cfg: Cfg) {
        env.storage().instance().set(&DK::Cfg, &cfg);
        bump_instance(&env);
    }

    /// Read-only precheck, run by simulation BEFORE any funding transaction is handed out:
    /// pinned Wasm, mirror-type decode, guard in both roles, token, platform, receiver equals service
    /// provider, all flags false, statuses set, and a ZERO balance (a dusted escrow is frozen early
    /// and is abandoned).
    pub fn check_escrow(env: Env, escrow: Address) -> Result<(), GErr> {
        let c = cfg(&env);
        let e = inspect(&env, &c, &escrow)?;
        if soroban_sdk::token::TokenClient::new(&env, &c.token).balance(&escrow) != 0 {
            return Err(GErr::NotEmpty);
        }
        if e.flags.disputed || e.flags.released || e.flags.resolved {
            return Err(GErr::AlreadySettled);
        }
        // Trustless Work v1: an empty milestone status can never be changed or approved,
        // so release would be impossible.
        for m in e.milestones.iter() {
            if m.status.len() == 0 || m.approved {
                return Err(GErr::BadMilestone);
            }
        }
        Ok(())
    }

    /// What the guard has recorded for `escrow`, if registered.
    pub fn registration(env: Env, escrow: Address) -> Option<Reg> {
        env.storage().persistent().get(&DK::Esc(escrow))
    }

    /// Permissionless register-or-refresh, outside `__check_auth` (the guard cannot read the escrow
    /// there). Registers at balance > 0 (Trustless Work freezes roles, amount, fee and receiver once
    /// balance > 0), then records, once each and only from on-chain state: `funded_at`
    /// (balance >= amount), `approved_at` (every milestone approved; only the buyer can approve) and
    /// `disputed_at` (dispute flag). Late calls only delay the seller.
    pub fn register_escrow(env: Env, escrow: Address) -> Result<Reg, GErr> {
        let c = cfg(&env);
        bump_instance(&env);
        let e = inspect(&env, &c, &escrow)?;
        if e.flags.released || e.flags.resolved {
            return Err(GErr::AlreadySettled);
        }
        let bal = soroban_sdk::token::TokenClient::new(&env, &c.token).balance(&escrow);
        let k = DK::Esc(escrow.clone());
        let now = env.ledger().timestamp();
        let mut reg = match env.storage().persistent().get::<_, Reg>(&k) {
            Some(old) => {
                if old.buyer != e.roles.approver
                    || old.seller != e.roles.receiver
                    || old.amount != e.amount
                {
                    return Err(GErr::Changed);
                }
                old
            }
            None => {
                if bal <= 0 {
                    return Err(GErr::NotFunded);
                }
                Reg {
                    buyer: e.roles.approver.clone(),
                    seller: e.roles.receiver.clone(),
                    amount: e.amount,
                    registered_at: now,
                    funded_at: None,
                    approved_at: None,
                    disputed_at: None,
                    contested_at: None,
                    closed: false,
                }
            }
        };
        if reg.closed {
            bump_reg(&env, &k);
            return Ok(reg);
        }
        if reg.funded_at.is_none() && bal >= reg.amount {
            reg.funded_at = Some(now);
        }
        if reg.approved_at.is_none()
            && !e.milestones.is_empty()
            && e.milestones.iter().all(|m| m.approved)
        {
            reg.approved_at = Some(now);
        }
        if reg.disputed_at.is_none() && e.flags.disputed {
            reg.disputed_at = Some(now);
        }
        env.storage().persistent().set(&k, &reg);
        bump_reg(&env, &k);
        Ok(reg)
    }

    /// The buyer's own signature on the guard: switches off the approved-and-uncontested seller path
    /// for this escrow, so a seller payout needs a delivery claim again (or the resolver refunds).
    /// Allowed until the contest window closes. `evidence` is a hash of what the buyer submitted to
    /// the platform.
    pub fn contest(env: Env, escrow: Address, evidence: BytesN<32>) -> Result<(), GErr> {
        let c = cfg(&env);
        let k = DK::Esc(escrow.clone());
        let mut reg: Reg = env
            .storage()
            .persistent()
            .get(&k)
            .ok_or(GErr::NotRegistered)?;
        reg.buyer.require_auth();
        bump_instance(&env);
        bump_reg(&env, &k);
        if reg.closed {
            return Err(GErr::Closed);
        }
        if let Some(s) = window_start(&reg) {
            if env.ledger().timestamp() >= s + c.contest_window {
                return Err(GErr::ContestTooLate);
            }
        }
        if reg.contested_at.is_none() {
            reg.contested_at = Some(env.ledger().timestamp());
        }
        env.storage().persistent().set(&k, &reg);
        BuyerContested { escrow, evidence }.publish(&env);
        Ok(())
    }

    /// Admin proposes new release, resolver and break-glass keys; applicable after `rotate_delay`.
    pub fn propose_keys(
        env: Env,
        release: BytesN<32>,
        resolver: BytesN<32>,
        breakglass: BytesN<32>,
    ) {
        let c = cfg(&env);
        c.admin.require_auth();
        bump_instance(&env);
        let eta = env.ledger().timestamp() + c.rotate_delay;
        env.storage().instance().set(
            &DK::Pending,
            &Pending {
                release: release.clone(),
                resolver: resolver.clone(),
                breakglass: breakglass.clone(),
                eta,
            },
        );
        KeysProposed {
            release,
            resolver,
            breakglass,
            eta,
        }
        .publish(&env);
    }

    /// Permissionless: applies the pending key set once its timelock has passed.
    pub fn apply_keys(env: Env) -> Result<(), GErr> {
        let mut c = cfg(&env);
        let p: Pending = env
            .storage()
            .instance()
            .get(&DK::Pending)
            .ok_or(GErr::NoPending)?;
        if env.ledger().timestamp() < p.eta {
            return Err(GErr::Timelocked);
        }
        bump_instance(&env);
        c.release_pk = p.release.clone();
        c.resolver_pk = p.resolver.clone();
        c.breakglass_pk = p.breakglass.clone();
        env.storage().instance().set(&DK::Cfg, &c);
        env.storage().instance().remove(&DK::Pending);
        KeysApplied {
            release: p.release,
            resolver: p.resolver,
            breakglass: p.breakglass,
        }
        .publish(&env);
        Ok(())
    }

    /// The resolver-key holder replaces the resolver key at once (for example after a compromise).
    pub fn rotate_resolver(env: Env, resolver: BytesN<32>) {
        let mut c = cfg(&env);
        c.resolver_admin.require_auth();
        bump_instance(&env);
        c.resolver_pk = resolver.clone();
        env.storage().instance().set(&DK::Cfg, &c);
        ResolverRotated { resolver }.publish(&env);
    }
}

#[contractimpl]
impl CustomAccountInterface for Guard {
    type Signature = GuardSig;
    type Error = GErr;

    fn __check_auth(
        env: Env,
        payload: Hash<32>,
        sig: GuardSig,
        ctx: Vec<Context>,
    ) -> Result<(), GErr> {
        let c = cfg(&env);
        // Exactly one contract call, on a registered escrow.
        if ctx.len() != 1 {
            return Err(GErr::BadContext);
        }
        let cc = match ctx.get(0).unwrap() {
            Context::Contract(cc) => cc,
            _ => return Err(GErr::BadContext),
        };
        let escrow = cc.contract.clone();
        let k = DK::Esc(escrow.clone());
        let mut reg: Reg = env
            .storage()
            .persistent()
            .get(&k)
            .ok_or(GErr::NotRegistered)?;
        // TTL upkeep only (v0.9). A refused authorization fails the transaction, so the
        // extension lands only together with an authorized call.
        bump_instance(&env);
        bump_reg(&env, &k);
        let msg: Bytes = payload.to_bytes().into();
        let rel = Symbol::new(&env, "release_funds");
        let res = Symbol::new(&env, "resolve_dispute");
        let wrf = Symbol::new(&env, "withdraw_remaining_funds");
        match sig {
            // Break-glass: first and minimal. resolve_dispute only, whole map to the buyer
            // (Trustless Work enforces sum == balance).
            GuardSig::BreakGlass(s) => {
                if cc.fn_name != res {
                    return Err(GErr::BadFn);
                }
                env.crypto().ed25519_verify(&c.breakglass_pk, &msg, &s);
                let i = fee_arg_ok(&env, &c, &cc.args)?;
                let d = dist_at(&env, &cc.args, i)?;
                if d.len() != 1 || !d.contains_key(reg.buyer.clone()) {
                    return Err(GErr::NotWholeToBuyer);
                }
                reg.closed = true;
                env.storage().persistent().set(&k, &reg);
                Ok(())
            }
            // Release: Trustless Work itself requires every milestone approved by the buyer and no
            // open dispute.
            GuardSig::Release(s) => {
                if cc.fn_name != rel {
                    return Err(GErr::BadFn);
                }
                if reg.closed {
                    return Err(GErr::Closed);
                }
                env.crypto().ed25519_verify(&c.release_pk, &msg, &s);
                let i = fee_arg_ok(&env, &c, &cc.args)?;
                if cc.args.len() != i {
                    return Err(GErr::BadArgs);
                }
                reg.closed = true;
                env.storage().persistent().set(&k, &reg);
                Ok(())
            }
            GuardSig::Resolve(_) | GuardSig::ResolveSeller(_) => {
                let (s, claim) = match sig {
                    GuardSig::Resolve(s) => (s, None),
                    GuardSig::ResolveSeller(rs) => (rs.sig, Some(rs.claim)),
                    _ => unreachable!(),
                };
                if cc.fn_name != res && cc.fn_name != wrf {
                    return Err(GErr::BadFn);
                }
                env.crypto().ed25519_verify(&c.resolver_pk, &msg, &s);
                let i = fee_arg_ok(&env, &c, &cc.args)?;
                let d = dist_at(&env, &cc.args, i)?;
                if cc.fn_name == wrf {
                    // withdraw_remaining_funds also works while merely disputed, partially, with no
                    // Trustless Work event: it may only ever pay the buyer.
                    for (a, _) in d.iter() {
                        if a != reg.buyer {
                            return Err(GErr::BadRecipient);
                        }
                    }
                    return Ok(());
                }
                if reg.closed {
                    return Err(GErr::Closed);
                }
                let mut to_seller = false;
                for (a, _) in d.iter() {
                    if a == reg.seller {
                        to_seller = true;
                        // v0.8: the seller never receives more than the escrow amount the buyer
                        // committed to; any excess (overfunding, dust) can only go to the buyer.
                        if d.get(a).unwrap() > reg.amount {
                            return Err(GErr::SellerOverAmount);
                        }
                    } else if a != reg.buyer {
                        return Err(GErr::BadRecipient);
                    }
                }
                if to_seller {
                    // Any seller payout needs the escrow to have been seen fully funded.
                    let funded_at = reg.funded_at.ok_or(GErr::NotFunded)?;
                    let now = env.ledger().timestamp();
                    match claim {
                        // (a) Silent buyer: a delivery claim anchored after full funding, `delay` old.
                        Some(cl) => {
                            let r = RegistryClient::new(&env, &c.registry);
                            if !r.verify(
                                &cl.batch_id,
                                &leaf(&env, &escrow, &cl),
                                &cl.proof,
                                &cl.index,
                            ) {
                                return Err(GErr::NoClaim);
                            }
                            let at = r.anchored_at(&cl.batch_id);
                            if at <= funded_at {
                                return Err(GErr::ClaimPredatesEscrow);
                            }
                            if now < at + c.delay {
                                return Err(GErr::TooEarly);
                            }
                        }
                        // (b) Anti-griefing: the buyer approved every milestone, a dispute then
                        // blocked release, and the buyer did not contest within the window.
                        None => {
                            if reg.approved_at.is_none() {
                                return Err(GErr::NoClaim);
                            }
                            if reg.disputed_at.is_none() {
                                return Err(GErr::NoDisputeSeen);
                            }
                            if reg.contested_at.is_some() {
                                return Err(GErr::Contested);
                            }
                            if now < window_start(&reg).unwrap() + c.contest_window {
                                return Err(GErr::TooEarly);
                            }
                        }
                    }
                }
                reg.closed = true;
                env.storage().persistent().set(&k, &reg);
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod test_vectors;

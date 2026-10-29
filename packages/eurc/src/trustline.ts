/**
 * Trustline checks.
 *
 * A Stellar account can hold EURC only through a trustline, and its owner can
 * remove that trustline at any time (once the balance is zero). So every flow
 * that pays EURC to a G-address checks the trustline first and, when it is
 * missing, offers a sponsored trustline (see `sponsorship.ts`).
 *
 * Contract addresses (C...) need no trustline: a SAC transfer to a fresh
 * contract address simulates successfully, while a transfer to a G-address
 * without a trustline fails (lab: wallets-xcheck/sim.mjs). That is why an
 * escrow contract can receive EURC without any setup.
 */
import { StrKey, type Asset } from "@stellar/stellar-sdk";
import type { AccountReader, BalanceLine } from "./ports.js";

export type TrustlineStatus =
  /** The account does not exist on the ledger. */
  | { readonly kind: "no-account" }
  /** The account exists but holds no trustline to the asset. */
  | { readonly kind: "missing" }
  /** The trustline exists but the issuer has deauthorised (frozen) it. */
  | { readonly kind: "frozen"; readonly line: BalanceLine }
  /** The trustline exists and is usable. */
  | { readonly kind: "present"; readonly line: BalanceLine };

function matches(line: BalanceLine, asset: Asset): boolean {
  return line.assetCode === asset.getCode() && line.assetIssuer === asset.getIssuer();
}

/** Inspect `account`'s trustline to `asset`. */
export async function trustlineStatus(
  reader: AccountReader,
  account: string,
  asset: Asset,
): Promise<TrustlineStatus> {
  if (asset.isNative()) throw new Error("XLM needs no trustline");
  const snap = await reader.loadAccount(account);
  if (!snap) return { kind: "no-account" };
  const line = snap.balances.find((b) => matches(b, asset));
  if (!line) return { kind: "missing" };
  if (line.authorized === false) return { kind: "frozen", line };
  return { kind: "present", line };
}

/** True when `account` exists and has a usable trustline to `asset`. */
export async function hasTrustline(reader: AccountReader, account: string, asset: Asset): Promise<boolean> {
  return (await trustlineStatus(reader, account, asset)).kind === "present";
}

export type ReceiveCheck =
  | { readonly ok: true; readonly reason: "contract-address" | "trustline-present" }
  | { readonly ok: false; readonly reason: "no-account" | "missing-trustline" | "frozen-trustline" | "invalid-address" };

/**
 * Can `destination` receive `asset` through its SAC (or a classic payment)?
 * Contract addresses always can; G-addresses need an existing account with an
 * authorised trustline. Run this before building a payout or refund so that a
 * missing trustline turns into a "re-sponsor the trustline" step instead of a
 * failed transaction.
 */
export async function canReceive(reader: AccountReader, destination: string, asset: Asset): Promise<ReceiveCheck> {
  if (StrKey.isValidContract(destination)) return { ok: true, reason: "contract-address" };
  if (!StrKey.isValidEd25519PublicKey(destination)) return { ok: false, reason: "invalid-address" };
  const s = await trustlineStatus(reader, destination, asset);
  switch (s.kind) {
    case "present":
      return { ok: true, reason: "trustline-present" };
    case "no-account":
      return { ok: false, reason: "no-account" };
    case "missing":
      return { ok: false, reason: "missing-trustline" };
    case "frozen":
      return { ok: false, reason: "frozen-trustline" };
  }
}

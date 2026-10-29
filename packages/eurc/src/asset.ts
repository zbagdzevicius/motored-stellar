/**
 * EURC asset constants and Stellar Asset Contract (SAC) address derivation.
 *
 * EURC is Circle's euro stablecoin, issued on Stellar as a classic credit
 * asset. Soroban contracts (such as a Trustless Work escrow) move it through
 * its SAC, whose contract id is a pure function of the asset and the network
 * passphrase.
 */
import { Asset, StrKey, hash, xdr } from "@stellar/stellar-sdk";
import { MAINNET_REFERENCE, TESTNET } from "./network.js";

/** Asset code shared by testnet and mainnet EURC. */
export const EURC_CODE = "EURC";

/**
 * Circle's testnet EURC issuer. Testnet EURC comes from Circle's faucet,
 * which may not be reachable from every environment; see `STANDIN_CODE`.
 */
export const EURC_TESTNET_ISSUER = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";

/**
 * Circle's mainnet EURC issuer (home domain circle.com). Documented reference
 * only: nothing in this package submits to mainnet.
 */
export const EURC_MAINNET_ISSUER = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";

/**
 * SAC contract id of mainnet EURC. Documented reference only; the test suite
 * re-derives it from the issuer and the public passphrase.
 */
export const EURC_MAINNET_SAC = "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV";

/**
 * Issuer account flags of mainnet EURC, as read from public Horizon data
 * (`/accounts/GDHU6WRG...`). `auth_required=false` means holders need no
 * issuer approval to open a trustline, so a sponsored trustline is usable at
 * once. `auth_revocable=true` means the issuer can freeze a trustline (the
 * "Circle freeze" case in docs/threat-model.md). Clawback is not enabled.
 *
 * TODO(verify): issuer flags can change; re-read Horizon before mainnet.
 */
export const EURC_MAINNET_ISSUER_FLAGS = Object.freeze({
  auth_required: false,
  auth_revocable: true,
  auth_immutable: false,
  auth_clawback_enabled: false,
});

/**
 * Asset code of the testnet stand-in. Demos issue XEUR from a runtime issuer
 * key when testnet EURC cannot be obtained; it behaves like EURC for every
 * flow in this repo (classic trustline plus SAC), but it is not Circle's asset.
 */
export const STANDIN_CODE = "XEUR";

/** Testnet EURC as a stellar-sdk Asset. */
export function eurcTestnet(): Asset {
  return new Asset(EURC_CODE, EURC_TESTNET_ISSUER);
}

/** Mainnet EURC as a stellar-sdk Asset (reference only). */
export function eurcMainnetReference(): Asset {
  return new Asset(EURC_CODE, EURC_MAINNET_ISSUER);
}

/** The XEUR stand-in for a given runtime issuer. */
export function standinAsset(issuerPublicKey: string): Asset {
  return new Asset(STANDIN_CODE, issuerPublicKey);
}

/**
 * Derive the SAC contract id (C... strkey) for a classic asset.
 *
 * contractId = SHA-256(XDR(HashIdPreimage::ContractId {
 *   networkId: SHA-256(passphrase),
 *   contractIdPreimage: FromAsset(asset),
 * }))
 *
 * This mirrors stellar-sdk's `Asset.contractId`, written out so that the
 * derivation is auditable and testable on its own.
 */
export function sacContractId(asset: Asset, networkPassphrase: string): string {
  const networkId = hash(Buffer.from(networkPassphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(asset.toXDRObject()),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/** SAC id of testnet EURC. */
export function eurcTestnetSac(): string {
  return sacContractId(eurcTestnet(), TESTNET.passphrase);
}

/** SAC id of mainnet EURC, derived (reference only). */
export function eurcMainnetSacDerived(): string {
  return sacContractId(eurcMainnetReference(), MAINNET_REFERENCE.passphrase);
}

/** True when two assets are the same classic asset (code and issuer). */
export function sameAsset(a: Asset, b: Asset): boolean {
  return a.equals(b);
}

/** EURC uses 7 decimals on Stellar, like every classic asset. */
export const DECIMALS = 7;

/** Convert integer 7-decimal units (stroop-like) to a classic amount string. */
export function unitsToAmount(units: bigint): string {
  if (units < 0n) throw new RangeError("amount must not be negative");
  const s = units.toString().padStart(DECIMALS + 1, "0");
  return `${s.slice(0, -DECIMALS)}.${s.slice(-DECIMALS)}`;
}

/** Convert a classic amount string ("12.5") to integer 7-decimal units. */
export function amountToUnits(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount);
  if (!m) throw new RangeError(`not a classic amount: ${amount}`);
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").padEnd(DECIMALS, "0");
  return BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(frac);
}

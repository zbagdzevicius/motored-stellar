/**
 * Privy embedded Stellar wallets.
 *
 * Privy supports Stellar as a raw-signing ("Tier 2") chain: it creates an
 * Ed25519 wallet and signs 32-byte hashes, and the app builds, hashes and
 * submits the Stellar transaction itself.
 * Sources: https://docs.privy.io/wallets/overview/chains,
 * https://docs.privy.io/recipes/tier-2-wallet-integration#stellar,
 * https://docs.privy.io/api-reference/wallets/create,
 * https://docs.privy.io/api-reference/wallets/raw-sign.
 *
 * Two halves, both behind injectable ports so this package never holds Privy
 * credentials and never imports Privy's SDKs:
 *
 * - Server: `EmbeddedWalletService` creates a wallet owned by the user alone
 *   (owner = the Privy user ID; no app authorisation key, no additional
 *   signers), and only after a caller-supplied eligibility predicate passes.
 *   `PrivyRestClient` is a fetch-based `PrivyClient`; `InMemoryPrivyClient`
 *   is the test/demo double.
 * - Browser: `PrivyWalletProvider` signs with the user's session through
 *   Privy's `signRawHash` (from `useSignRawHash()` in
 *   `@privy-io/react-auth/extended-chains`), passed in as a plain function.
 */
import { Buffer } from 'buffer';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

import { WalletError } from './errors.js';
import { type Hex0x, bytesToHex0x, hexToBytes } from './raw-signature.js';
import { RawHashWallet } from './raw-hash-wallet.js';
import type { BeforeSignHook } from './review.js';

// ---------------------------------------------------------------------------
// Browser side: signing
// ---------------------------------------------------------------------------

/**
 * The function returned by Privy's `useSignRawHash()` hook
 * (`@privy-io/react-auth/extended-chains`). Documented signature:
 * `signRawHash({ address, chainType, hash }) => Promise<{ signature: HexString }>`,
 * where the signature is `0x`-prefixed hex.
 */
export type PrivySignRawHash = (input: {
  address: string;
  chainType: 'stellar';
  hash: Hex0x;
}) => Promise<{ signature: string }>;

export interface PrivyWalletProviderOptions {
  /** The embedded wallet's Stellar address, from the user's linked accounts or `EmbeddedWalletService`. */
  address: string;
  signRawHash: PrivySignRawHash;
  /** Defaults to testnet. */
  networkPassphrase?: string;
  /** Show the decoded transaction (escrow ID, amount, asset) before Privy's signing prompt. */
  beforeSign?: BeforeSignHook;
}

/**
 * Embedded wallet signer. Hashes the transaction locally, asks Privy to sign
 * the hash in the user's session and attaches the result as an Ed25519
 * DecoratedSignature, verified before it is returned.
 */
export class PrivyWalletProvider extends RawHashWallet {
  constructor(options: PrivyWalletProviderOptions) {
    const { signRawHash } = options;
    super({
      kind: 'privy-embedded',
      address: options.address,
      networkPassphrase: options.networkPassphrase,
      beforeSign: options.beforeSign,
      signRawHash: async ({ address, hash }) => {
        const result = await signRawHash({ address, chainType: 'stellar', hash });
        if (!result || typeof result.signature !== 'string') {
          throw new WalletError('PROVIDER_ERROR', 'Privy signRawHash returned no signature');
        }
        return result.signature;
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Server side: wallet creation
// ---------------------------------------------------------------------------

export interface PrivyWallet {
  /** Privy's wallet ID (used for later API calls, never shown on-chain). */
  id: string;
  /** The Stellar account address (`G...`). */
  address: string;
  chainType: string;
  /** Key quorum that owns the wallet; Privy creates one containing the owner user. */
  ownerId: string | null;
  /** Must be empty for a user-only wallet. */
  additionalSigners: unknown[];
}

export interface CreatePrivyWalletInput {
  chainType: 'stellar';
  /** Privy user ID of the owner. */
  ownerUserId: string;
  /** Makes retries safe; derive it from your own user record, not from personal data. */
  idempotencyKey?: string;
}

/** Port for the server-side Privy wallet API. */
export interface PrivyClient {
  createWallet(input: CreatePrivyWalletInput): Promise<PrivyWallet>;
}

export interface PrivyRestConfig {
  appId: string;
  /** Server secret. Injected from the host's secret store; never hard-coded or logged. */
  appSecret: string;
  /** Defaults to https://api.privy.io. */
  baseUrl?: string;
  /** Injected for tests and non-Node runtimes. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

interface PrivyCreateWalletResponse {
  id?: unknown;
  address?: unknown;
  chain_type?: unknown;
  owner_id?: unknown;
  additional_signers?: unknown;
}

/**
 * `PrivyClient` over Privy's REST API.
 *
 * `POST /v1/wallets` with HTTP Basic auth (`appId:appSecret`) and the
 * `privy-app-id` header; body `{ chain_type, owner: { user_id } }`.
 */
export class PrivyRestClient implements PrivyClient {
  readonly #appId: string;
  readonly #authorization: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(config: PrivyRestConfig) {
    if (!config.appId || !config.appSecret) {
      throw new WalletError('PROVIDER_ERROR', 'Privy appId and appSecret are required');
    }
    this.#appId = config.appId;
    this.#authorization = `Basic ${Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64')}`;
    this.#baseUrl = (config.baseUrl ?? 'https://api.privy.io').replace(/\/+$/, '');
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async createWallet(input: CreatePrivyWalletInput): Promise<PrivyWallet> {
    const body: Record<string, unknown> = {
      chain_type: input.chainType,
      owner: { user_id: input.ownerUserId },
    };
    // TODO(verify, D2): Privy's create-wallet reference lists `idempotency_key` as a
    // body field; its idempotency guide may prefer a `privy-idempotency-key`
    // header. Confirm before relying on retries.
    if (input.idempotencyKey) body.idempotency_key = input.idempotencyKey;

    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/v1/wallets`, {
        method: 'POST',
        headers: {
          Authorization: this.#authorization,
          'privy-app-id': this.#appId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new WalletError('PROVIDER_ERROR', 'Privy request failed', { cause });
    }
    if (!res.ok) {
      // Status only: response bodies can echo request data.
      throw new WalletError('PROVIDER_ERROR', `Privy create wallet failed with HTTP ${res.status}`);
    }
    const json = (await res.json()) as PrivyCreateWalletResponse;
    return {
      id: typeof json.id === 'string' ? json.id : '',
      address: typeof json.address === 'string' ? json.address : '',
      chainType: typeof json.chain_type === 'string' ? json.chain_type : '',
      ownerId: typeof json.owner_id === 'string' ? json.owner_id : null,
      additionalSigners: Array.isArray(json.additional_signers) ? json.additional_signers : [],
    };
  }
}

// ---------------------------------------------------------------------------
// Wallet creation policy
// ---------------------------------------------------------------------------

export type WalletRole = 'buyer' | 'seller';

export interface WalletSubject {
  /** Privy user ID that will own the wallet. */
  privyUserId: string;
  role: WalletRole;
}

export type EligibilityDecision = boolean | { allowed: boolean; reason?: string };

/**
 * Caller-supplied gate, run before any wallet is created. A marketplace would
 * check, for example, a verified email for buyers and completed seller
 * verification for sellers. This package does not know how those are stored.
 */
export type WalletEligibility = (subject: WalletSubject) => Promise<EligibilityDecision> | EligibilityDecision;

export interface EmbeddedWalletServiceOptions {
  client: PrivyClient;
  isEligible: WalletEligibility;
}

export class EmbeddedWalletService {
  readonly #client: PrivyClient;
  readonly #isEligible: WalletEligibility;

  constructor(options: EmbeddedWalletServiceOptions) {
    this.#client = options.client;
    this.#isEligible = options.isEligible;
  }

  /**
   * Creates a Stellar wallet owned by the user alone, after the eligibility
   * gate passes, and checks Privy's response: Stellar chain, a valid `G...`
   * address and no additional signers.
   */
  async createForUser(subject: WalletSubject, options: { idempotencyKey?: string } = {}): Promise<PrivyWallet> {
    const decision = await this.#isEligible(subject);
    const allowed = typeof decision === 'boolean' ? decision : decision.allowed;
    if (!allowed) {
      const reason = typeof decision === 'object' && decision.reason ? `: ${decision.reason}` : '';
      throw new WalletError('NOT_ELIGIBLE', `wallet creation refused for this ${subject.role}${reason}`);
    }

    const wallet = await this.#client.createWallet({
      chainType: 'stellar',
      ownerUserId: subject.privyUserId,
      idempotencyKey: options.idempotencyKey,
    });

    if (!wallet.id) throw new WalletError('PROVIDER_ERROR', 'Privy returned a wallet without an id');
    if (wallet.chainType !== 'stellar') {
      throw new WalletError('PROVIDER_ERROR', `Privy returned a ${wallet.chainType || 'unknown'} wallet, expected stellar`);
    }
    if (!StrKey.isValidEd25519PublicKey(wallet.address)) {
      throw new WalletError('PROVIDER_ERROR', 'Privy returned an invalid Stellar address');
    }
    if (wallet.additionalSigners.length > 0) {
      throw new WalletError('PROVIDER_ERROR', 'wallet has additional signers; user-only ownership is required');
    }
    return wallet;
  }
}

// ---------------------------------------------------------------------------
// In-memory double
// ---------------------------------------------------------------------------

/**
 * In-memory stand-in for Privy, for tests and the runnable example.
 *
 * `createWallet` makes a random key per owner (idempotent per owner and per
 * idempotency key); `signRawHashFor(privyUserId)` returns a function with the
 * same shape as Privy's browser `signRawHash`, which only that owner's session
 * would have. Keys live in memory only and are never exposed.
 */
export class InMemoryPrivyClient implements PrivyClient {
  readonly #byOwner = new Map<string, { wallet: PrivyWallet; keypair: Keypair }>();
  readonly #byIdempotencyKey = new Map<string, string>();
  #counter = 0;

  async createWallet(input: CreatePrivyWalletInput): Promise<PrivyWallet> {
    const priorOwner = input.idempotencyKey ? this.#byIdempotencyKey.get(input.idempotencyKey) : undefined;
    const owner = priorOwner ?? input.ownerUserId;
    const existing = this.#byOwner.get(owner);
    if (existing) return { ...existing.wallet };

    const keypair = Keypair.random();
    this.#counter += 1;
    const wallet: PrivyWallet = {
      id: `mem-wallet-${this.#counter}`,
      address: keypair.publicKey(),
      chainType: input.chainType,
      ownerId: `mem-quorum-${this.#counter}`,
      additionalSigners: [],
    };
    this.#byOwner.set(input.ownerUserId, { wallet, keypair });
    if (input.idempotencyKey) this.#byIdempotencyKey.set(input.idempotencyKey, input.ownerUserId);
    return { ...wallet };
  }

  /** The signing function the owner's browser session would get from `useSignRawHash()`. */
  signRawHashFor(privyUserId: string): PrivySignRawHash {
    return async ({ address, chainType, hash }) => {
      const entry = this.#byOwner.get(privyUserId);
      if (!entry || entry.wallet.address !== address || chainType !== 'stellar') {
        throw new WalletError('PROVIDER_ERROR', 'no stellar wallet with that address for this user');
      }
      const digest = hexToBytes(hash);
      if (digest.length !== 32) throw new WalletError('PROVIDER_ERROR', 'hash must be 32 bytes');
      return { signature: bytesToHex0x(entry.keypair.sign(Buffer.from(digest))) };
    };
  }
}

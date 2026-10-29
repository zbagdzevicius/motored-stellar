// SPDX-License-Identifier: Apache-2.0
//
// Trustless Work v1 REST client for single-release escrows (SCF deliverable D1).
//
// Request shapes follow Trustless Work's published API reference
// (docs.trustlesswork.com, "API REST > Single Release Escrow", and the payload
// types under "Developer resources > Types"):
//
//   POST /deployer/single-release                    initialize (deploy + init)
//   POST /escrow/single-release/fund-escrow          { contractId, signer, amount }
//   POST /escrow/single-release/approve-milestone    { contractId, milestoneIndex, approver }
//   POST /escrow/single-release/dispute-escrow       { contractId, signer }
//   POST /escrow/single-release/release-funds        { contractId, releaseSigner }
//   POST /escrow/single-release/resolve-dispute      { contractId, disputeResolver, distributions }
//   PUT  /escrow/single-release/update-escrow        { signer, contractId, escrow }
//   GET  /helper/get-escrow-by-contract-ids          ?contractIds=...&validateOnChain=true
//   POST /helper/send-transaction                    { signedXdr }
//
// Headers: `Content-Type: application/json` and `x-api-key: <key>`. Base URL
// https://dev.api.trustlesswork.com on testnet. Every write returns
// `{ status, unsignedTransaction }`: an unsigned envelope the named signer signs.
//
// The API key is injected through the constructor. This package never reads it
// from the environment. Request a testnet key in Trustless Work's dApp
// (docs: "Request API Key").

import type { EscrowSnapshot } from './escrow-types.js';
import type {
  ApproveMilestoneRequest,
  DisputeEscrowRequest,
  EscrowApi,
  FundEscrowRequest,
  InitializeEscrowRequest,
  ReleaseFundsRequest,
  ResolveDisputeRequest,
  SendResult,
  UnsignedTx,
  UpdateEscrowRequest,
} from './ports.js';
import { formatUnits, parseUnits } from './units.js';

/**
 * How domain values map to the REST API's JSON numbers.
 *
 * TODO(verify): the API types `amount` and `platformFee` as plain numbers. We
 * assume `amount` is in whole tokens (decimal, e.g. 100.5 EURC) and `platformFee`
 * is a percentage (the API error reads "The platform fee cannot exceed 99%"),
 * which the contract stores in basis points. Confirm both with Trustless Work
 * before relying on the REST path; the on-chain deployer path takes units and
 * basis points directly.
 */
export interface RestUnitCodec {
  amountToRest(units: bigint): number;
  amountFromRest(value: number | string): bigint;
  feeBpsToRest(bps: number): number;
  feeBpsFromRest(value: number | string): number;
}

export const DEFAULT_REST_UNITS: RestUnitCodec = {
  amountToRest: (u) => Number(formatUnits(u)),
  amountFromRest: (v) => parseUnits(typeof v === 'number' ? v.toFixed(7) : v),
  feeBpsToRest: (bps) => bps / 100,
  feeBpsFromRest: (v) => Math.round(Number(v) * 100),
};

export interface TrustlessWorkRestConfig {
  /** e.g. TESTNET.trustlessWorkApiBase. */
  baseUrl: string;
  /** Trustless Work API key, injected by the caller. Never logged. */
  apiKey: string;
  /**
   * The token as the REST API identifies it.
   * TODO(verify): whether `trustline.address` must be the asset issuer (G...) or the SAC (C...).
   * Trustless Work's mainnet checklist refers to the "asset issuer", so pass the issuer.
   */
  trustline: { address: string; symbol: string };
  fetch?: typeof fetch;
  timeoutMs?: number;
  units?: RestUnitCodec;
}

export class TrustlessWorkApiError extends Error {
  constructor(public readonly status: number, public readonly path: string, public readonly body: unknown) {
    super(`Trustless Work API ${path} returned HTTP ${status}${typeof body === 'object' && body && 'message' in body ? `: ${String((body as { message: unknown }).message)}` : ''}`);
    this.name = 'TrustlessWorkApiError';
  }
}

interface RestEscrow {
  contractId?: string;
  engagementId: string;
  title: string;
  description: string;
  roles: {
    approver: string;
    serviceProvider: string;
    platformAddress: string;
    releaseSigner: string;
    disputeResolver: string;
    receiver: string;
  };
  amount: number | string;
  platformFee: number | string;
  balance?: number | string;
  milestones: Array<{ description: string; status?: string; evidence?: string; approved?: boolean }>;
  flags?: { disputed?: boolean; released?: boolean; resolved?: boolean };
  trustline: { address: string; symbol?: string };
  receiverMemo?: number;
}

export class TrustlessWorkRestClient implements EscrowApi {
  private readonly fetchImpl: typeof fetch;
  private readonly units: RestUnitCodec;

  constructor(private readonly cfg: TrustlessWorkRestConfig) {
    if (!cfg.apiKey) throw new Error('Trustless Work API key is required');
    this.fetchImpl = cfg.fetch ?? globalThis.fetch;
    this.units = cfg.units ?? DEFAULT_REST_UNITS;
  }

  async initialize(req: InitializeEscrowRequest): Promise<UnsignedTx> {
    const e = req.escrow;
    // Per the API reference, milestones are sent without `approved`/`status`.
    // TODO(verify): whether the API accepts a `status` per milestone at deploy time.
    // If it does not, the lifecycle sets a non-empty status with update-escrow
    // before the precheck (an empty status can never be approved in v1).
    return this.write('POST', '/deployer/single-release', {
      signer: req.signer,
      engagementId: e.engagementId,
      title: e.title,
      description: e.description,
      roles: this.rolesToRest(e.roles),
      amount: this.units.amountToRest(e.amount),
      platformFee: this.units.feeBpsToRest(e.platformFeeBps),
      milestones: e.milestones.map((m) => ({ description: m.description })),
      trustline: { address: this.cfg.trustline.address, symbol: req.trustlineSymbol || this.cfg.trustline.symbol },
    });
  }

  fund(req: FundEscrowRequest): Promise<UnsignedTx> {
    return this.write('POST', '/escrow/single-release/fund-escrow', {
      contractId: req.contractId,
      signer: req.signer,
      amount: this.units.amountToRest(req.amount),
    });
  }

  approve(req: ApproveMilestoneRequest): Promise<UnsignedTx> {
    return this.write('POST', '/escrow/single-release/approve-milestone', {
      contractId: req.contractId,
      milestoneIndex: String(req.milestoneIndex),
      approver: req.approver,
    });
  }

  changeDisputeFlag(req: DisputeEscrowRequest): Promise<UnsignedTx> {
    return this.write('POST', '/escrow/single-release/dispute-escrow', { contractId: req.contractId, signer: req.signer });
  }

  release(req: ReleaseFundsRequest): Promise<UnsignedTx> {
    return this.write('POST', '/escrow/single-release/release-funds', { contractId: req.contractId, releaseSigner: req.releaseSigner });
  }

  resolve(req: ResolveDisputeRequest): Promise<UnsignedTx> {
    // TODO(verify): the OpenAPI schema types `distributions` as an array of arrays,
    // the TypeScript payload type as [{ address, amount }]. We send the latter.
    return this.write('POST', '/escrow/single-release/resolve-dispute', {
      contractId: req.contractId,
      disputeResolver: req.disputeResolver,
      distributions: req.distributions.map(([address, amount]) => ({ address, amount: this.units.amountToRest(amount) })),
    });
  }

  updateEscrow(req: UpdateEscrowRequest): Promise<UnsignedTx> {
    const e = req.escrow;
    // TODO(verify): field set of `escrow` for single-release update (OpenAPI marks
    // `flags`, `isActive` and `receiverMemo` required; milestone item type differs
    // between the OpenAPI schema and the TypeScript payload type).
    return this.write('PUT', '/escrow/single-release/update-escrow', {
      signer: req.signer,
      contractId: req.contractId,
      escrow: {
        engagementId: e.engagementId,
        title: e.title,
        description: e.description,
        roles: this.rolesToRest(e.roles),
        amount: this.units.amountToRest(e.amount),
        platformFee: this.units.feeBpsToRest(e.platformFeeBps),
        milestones: e.milestones.map((m) => ({ description: m.description, status: m.status, evidence: m.evidence, approved: m.approved })),
        flags: { ...e.flags },
        isActive: true,
        receiverMemo: e.receiverMemo,
        trustline: { address: this.cfg.trustline.address, symbol: this.cfg.trustline.symbol },
      },
    });
  }

  /**
   * Reads an escrow through Trustless Work's indexer with on-chain validation.
   * For guard decisions read the contract directly (`get_escrow` by simulation,
   * see precheck.ts); this is a convenience view.
   * TODO(verify): response envelope (bare array assumed, object with `data` accepted).
   */
  async getEscrow(contractId: string): Promise<EscrowSnapshot> {
    const qs = new URLSearchParams();
    qs.append('contractIds', contractId);
    qs.append('validateOnChain', 'true');
    const body = await this.request('GET', `/helper/get-escrow-by-contract-ids?${qs.toString()}`);
    const list = (Array.isArray(body) ? body : (body as { data?: unknown })?.data) as RestEscrow[] | undefined;
    const found = list?.find((x) => !x.contractId || x.contractId === contractId);
    if (!found) throw new TrustlessWorkApiError(404, '/helper/get-escrow-by-contract-ids', body);
    return this.escrowFromRest(contractId, found);
  }

  async sendTransaction(signedXdr: string): Promise<SendResult> {
    const body = (await this.request('POST', '/helper/send-transaction', { signedXdr })) as Record<string, unknown>;
    return {
      status: body.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      message: typeof body.message === 'string' ? body.message : undefined,
      // TODO(verify): which response field carries the new escrow's ID after a deploy.
      contractId: typeof body.contractId === 'string' ? body.contractId : undefined,
      txHash: typeof body.hash === 'string' ? body.hash : undefined,
    };
  }

  private rolesToRest(r: InitializeEscrowRequest['escrow']['roles']) {
    return {
      approver: r.approver,
      serviceProvider: r.serviceProvider,
      platformAddress: r.platform,
      releaseSigner: r.releaseSigner,
      disputeResolver: r.disputeResolver,
      receiver: r.receiver,
    };
  }

  private escrowFromRest(contractId: string, r: RestEscrow): EscrowSnapshot {
    return {
      contractId,
      engagementId: r.engagementId,
      title: r.title,
      description: r.description,
      roles: {
        approver: r.roles.approver,
        serviceProvider: r.roles.serviceProvider,
        platform: r.roles.platformAddress,
        releaseSigner: r.roles.releaseSigner,
        disputeResolver: r.roles.disputeResolver,
        receiver: r.roles.receiver,
      },
      amount: this.units.amountFromRest(r.amount),
      platformFeeBps: this.units.feeBpsFromRest(r.platformFee),
      balance: r.balance === undefined ? 0n : this.units.amountFromRest(r.balance),
      milestones: r.milestones.map((m) => ({
        description: m.description,
        status: m.status ?? '',
        evidence: m.evidence ?? '',
        approved: m.approved ?? false,
      })),
      flags: { disputed: !!r.flags?.disputed, released: !!r.flags?.released, resolved: !!r.flags?.resolved },
      trustline: r.trustline.address,
      receiverMemo: r.receiverMemo ?? 0,
    };
  }

  private async write(method: 'POST' | 'PUT', path: string, body: unknown): Promise<UnsignedTx> {
    const res = (await this.request(method, path, body)) as { unsignedTransaction?: unknown };
    if (typeof res?.unsignedTransaction !== 'string') throw new TrustlessWorkApiError(200, path, res);
    return { unsignedXdr: res.unsignedTransaction };
  }

  private async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 10_000);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.cfg.apiKey },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        /* keep the raw text */
      }
      if (!res.ok) throw new TrustlessWorkApiError(res.status, path.split('?')[0] ?? path, parsed);
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}

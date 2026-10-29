/**
 * Thin HTTP layer for the Bridge API.
 *
 * Documented conventions this file encodes:
 *   - base URLs: production `https://api.bridge.xyz/v0`, sandbox
 *     `https://api.sandbox.bridge.xyz/v0`;
 *   - authentication by an `Api-Key` header;
 *   - an `Idempotency-Key` header on every POST;
 *   - sandbox keys are prefixed `sk-test`;
 *   - errors carry `{ code, message, source? }`.
 *
 * The API key is injected by configuration and never logged, echoed in errors
 * or written anywhere by this package.
 */

import { randomUUID } from "node:crypto";
import { BridgeApiError, RampError } from "../errors.js";
import type { HttpClient, IdempotencyKeyFactory } from "../ports.js";

export const BRIDGE_PRODUCTION_BASE_URL = "https://api.bridge.xyz/v0";
export const BRIDGE_SANDBOX_BASE_URL = "https://api.sandbox.bridge.xyz/v0";

export type BridgeEnvironment = "sandbox" | "production";

export interface BridgeConfig {
  /** API key from the gateway dashboard. Supply from a secret store, never from source. */
  apiKey: string;
  /** Defaults to "sandbox". */
  environment?: BridgeEnvironment;
  /** Overrides the base URL (for a proxy or a recorded-fixture server). */
  baseUrl?: string;
  /**
   * Must be true to target production. This repository is sandbox and
   * testnet only; the flag exists so production use is always deliberate.
   */
  allowProduction?: boolean;
  /** Defaults to the global `fetch`. */
  http?: HttpClient;
  /** Defaults to `crypto.randomUUID`. */
  idempotencyKey?: IdempotencyKeyFactory;
}

export class BridgeHttp {
  readonly baseUrl: string;
  readonly environment: BridgeEnvironment;
  readonly #apiKey: string;
  readonly #http: HttpClient;
  readonly #newKey: IdempotencyKeyFactory;

  constructor(config: BridgeConfig) {
    const environment = config.environment ?? "sandbox";
    if (!config.apiKey) throw new RampError("CONFIG_INVALID", "Bridge apiKey is required");
    if (environment === "production" && !config.allowProduction) {
      throw new RampError(
        "CONFIG_INVALID",
        "production environment requested without allowProduction: true",
      );
    }
    if (environment === "sandbox" && !config.apiKey.startsWith("sk-test")) {
      // Prevents a live key from being used against what the caller believes is the sandbox.
      throw new RampError("CONFIG_INVALID", "sandbox requires an API key prefixed sk-test");
    }
    this.environment = environment;
    this.baseUrl = (
      config.baseUrl ??
      (environment === "production" ? BRIDGE_PRODUCTION_BASE_URL : BRIDGE_SANDBOX_BASE_URL)
    ).replace(/\/+$/, "");
    this.#apiKey = config.apiKey;
    const globalFetch = (globalThis as unknown as { fetch?: HttpClient }).fetch;
    const http = config.http ?? globalFetch?.bind(globalThis);
    if (!http) throw new RampError("CONFIG_INVALID", "no HttpClient supplied and no global fetch");
    this.#http = http;
    this.#newKey = config.idempotencyKey ?? (() => randomUUID());
  }

  /** POST with a JSON body and an Idempotency-Key. */
  post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    return this.#send<T>("POST", path, body, idempotencyKey ?? this.#newKey());
  }

  /** GET without a body. */
  get<T>(path: string): Promise<T> {
    return this.#send<T>("GET", path, undefined, undefined);
  }

  async #send<T>(
    method: string,
    path: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Api-Key": this.#apiKey,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;

    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await this.#http(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    let json: unknown = undefined;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const err = (json ?? {}) as { code?: string; message?: string; source?: { location: string; key: string } };
      throw new BridgeApiError({
        status: res.status,
        code: err.code ?? "http_error",
        message: err.message ?? (text.slice(0, 200) || "no body"),
        path,
        source: err.source,
      });
    }
    return json as T;
  }
}

/** Encodes one path segment (resource ids come from responses, still never trusted raw). */
export function seg(id: string): string {
  if (!id) throw new RampError("CONFIG_INVALID", "empty resource id");
  return encodeURIComponent(id);
}

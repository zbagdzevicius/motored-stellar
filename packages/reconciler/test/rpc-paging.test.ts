/**
 * `RpcChainReader.getTransfers` paging against a scripted RPC. Testnet RPC
 * scans a bounded ledger range per getEvents request and can return a short
 * page with a cursor well before its latest ledger (run 7 metric, 29 Oct
 * 2026); the reader must keep paging until the cursor stops moving or reaches
 * the latest ledger.
 */
import { Address, Keypair, StrKey, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RpcChainReader, eventCursorLedger, type RpcReaderServer } from "../src/adapters/rpc.js";

const SAC = StrKey.encodeContract(randomBytes(32));
const ESCROW = StrKey.encodeContract(randomBytes(32));
const BUYER = Keypair.random().publicKey();
const LATEST = 5_460_000;

/** An RPC event cursor at `ledger` (TOID: ledger in the high 32 bits). */
const cursorAt = (ledger: number) => `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-0000000001`;

function transferEvent(ledger: number, amount: bigint): rpc.Api.EventResponse {
  return {
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-10-29T09:30:00Z",
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: `${ledger}`.padStart(64, "0"),
    id: `${cursorAt(ledger)}`,
    topic: [xdr.ScVal.scvSymbol("transfer"), new Address(BUYER).toScVal(), new Address(ESCROW).toScVal(), xdr.ScVal.scvString("XEUR")],
    value: nativeToScVal(amount, { type: "i128" }),
  } as unknown as rpc.Api.EventResponse;
}

interface Page {
  events: rpc.Api.EventResponse[];
  cursor: string;
}

/** Returns `pages` in order and records each request. */
function scripted(pages: Page[]) {
  const requests: Array<{ cursor?: string; startLedger?: number }> = [];
  const server = {
    getHealth: async () => ({ status: "healthy", oldestLedger: 5_340_000, latestLedger: LATEST, ledgerRetentionWindow: 120_960 }),
    getEvents: async (req: { cursor?: string; startLedger?: number }) => {
      requests.push({ cursor: req.cursor, startLedger: req.startLedger });
      const p = pages[requests.length - 1] ?? { events: [], cursor: req.cursor ?? cursorAt(LATEST) };
      return { events: p.events, cursor: p.cursor, latestLedger: LATEST, oldestLedger: 5_340_000 };
    },
  } as unknown as RpcReaderServer;
  return { server, requests };
}

const reader = (server: RpcReaderServer, pageSize = 100) =>
  new RpcChainReader({ rpcUrl: "https://rpc.invalid", eurcSac: SAC, eurc: { code: "XEUR", issuer: BUYER }, startLedger: 5_431_300, pageSize, server });

describe("RpcChainReader.getTransfers paging", () => {
  it("reads the cursor's ledger from the TOID", () => {
    expect(eventCursorLedger(cursorAt(5_441_300))).toBe(5_441_300);
    expect(eventCursorLedger("not-a-cursor")).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps paging after a short page whose cursor is behind the latest ledger", async () => {
    // Page 1: short (1 of 100) and stops near 5,441,300. Page 2 holds the later transfers.
    const { server, requests } = scripted([
      { events: [transferEvent(5_431_400, 1_000n)], cursor: cursorAt(5_441_300) },
      { events: [transferEvent(5_450_000, 2_000n), transferEvent(5_455_000, 3_000n)], cursor: cursorAt(LATEST) },
    ]);
    const out = await reader(server).getTransfers(BUYER);
    expect(out.map((t) => t.amount)).toEqual([1_000n, 2_000n, 3_000n]);
    expect(requests).toEqual([{ startLedger: 5_431_300, cursor: undefined }, { cursor: cursorAt(5_441_300), startLedger: undefined }]);
  });

  it("stops when the cursor stops moving", async () => {
    const stuck = cursorAt(5_441_300);
    const { server, requests } = scripted([
      { events: [transferEvent(5_431_400, 1_000n)], cursor: stuck },
      { events: [], cursor: stuck },
    ]);
    const out = await reader(server).getTransfers(BUYER);
    expect(out).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it("keeps paging on full pages and stops on a short page at the latest ledger", async () => {
    const { server, requests } = scripted([
      { events: [transferEvent(5_432_000, 1n), transferEvent(5_433_000, 2n)], cursor: cursorAt(5_433_000) },
      { events: [transferEvent(5_459_000, 3n)], cursor: cursorAt(LATEST) },
      { events: [transferEvent(5_459_999, 4n)], cursor: cursorAt(LATEST + 1) },
    ]);
    const out = await reader(server, 2).getTransfers(BUYER);
    expect(out.map((t) => t.amount)).toEqual([1n, 2n, 3n]);
    expect(requests).toHaveLength(2);
  });
});

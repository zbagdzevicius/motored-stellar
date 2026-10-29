// RpcSubmitter against a fake RPC server: the same retry, expiry and idempotency rules
// as the escrow package's RpcSubmitter, including resending an evicted envelope.
import { Account, Keypair, Networks, Operation, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { RpcSubmitter, sendErrorCode, transactionHash, transactionMaxTime, type RpcSubmitterServer } from "../src/index.js";

const source = Keypair.random();
const MAX_TIME = 1_800_000_000;

function signedTx(seq = "100"): Transaction {
  const tx = new TransactionBuilder(new Account(source.publicKey(), seq), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: MAX_TIME },
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
    .build();
  tx.sign(source);
  return tx;
}

const txResult = (code: "txBadSeq" | "txInsufficientFee") =>
  new xdr.TransactionResult({ feeCharged: 0n, result: xdr.TransactionResultResult[code](), ext: xdr.TransactionResultExt.v0() });

type Get = { status: "SUCCESS" | "FAILED" | "NOT_FOUND" };
const notFound = (n: number): Get[] => Array.from({ length: n }, () => ({ status: "NOT_FOUND" }));

function fake(o: { sends: Array<{ status: string; errorResult?: xdr.TransactionResult }>; gets?: Get[]; accountSeq?: string }) {
  const log: string[] = [];
  const hashes: string[] = [];
  let clock = (MAX_TIME - 600) * 1000;
  let sends = 0;
  let gets = 0;
  const server = {
    sendTransaction: async (tx: Transaction) => {
      log.push("send");
      hashes.push(transactionHash(tx));
      return { hash: transactionHash(tx), ...o.sends[Math.min(sends++, o.sends.length - 1)]! };
    },
    getTransaction: async () => {
      log.push("get");
      const r = (o.gets ?? [])[gets++] ?? { status: "NOT_FOUND" };
      return { ...r, latestLedgerCloseTime: Math.floor(clock / 1000) };
    },
    getAccount: async () => new Account(source.publicKey(), o.accountSeq ?? "99"),
  } as unknown as RpcSubmitterServer;
  const submitter = new RpcSubmitter(server, {
    pollMs: 5_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    beforeSubmit: () => {
      log.push("beforeSubmit");
    },
  });
  return { log, hashes, submitter };
}

describe("claims RpcSubmitter", () => {
  it("records the hash before sending and returns a known outcome without resending", async () => {
    const tx = signedTx();
    const first = fake({ sends: [{ status: "PENDING" }], gets: [...notFound(1), { status: "SUCCESS" }] });
    expect(await first.submitter.send(tx)).toEqual({ hash: transactionHash(tx), status: "SUCCESS" });
    expect(first.log.slice(0, 3)).toEqual(["get", "beforeSubmit", "send"]);
    expect(transactionMaxTime(tx)).toBe(MAX_TIME);

    const retry = fake({ sends: [{ status: "PENDING" }], gets: [{ status: "SUCCESS" }] });
    expect((await retry.submitter.send(tx)).status).toBe("SUCCESS");
    expect(retry.log).toEqual(["get"]);
  });

  it("resends on TRY_AGAIN_LATER and while txBadSeq waits behind an earlier transaction", async () => {
    const f = fake({
      sends: [{ status: "TRY_AGAIN_LATER" }, { status: "ERROR", errorResult: txResult("txBadSeq") }, { status: "PENDING" }],
      gets: [...notFound(3), { status: "SUCCESS" }],
      accountSeq: "98",
    });
    expect((await f.submitter.send(signedTx())).status).toBe("SUCCESS");
    expect(f.log.filter((l) => l === "send")).toHaveLength(3);
  });

  it("reports txBadSeq with the sequence used up as retryable, other errors as final", async () => {
    const used = fake({ sends: [{ status: "ERROR", errorResult: txResult("txBadSeq") }], accountSeq: "101" });
    expect(await used.submitter.send(signedTx())).toMatchObject({ status: "REJECTED", reason: "txBadSeq", retryable: true });
    const fee = fake({ sends: [{ status: "ERROR", errorResult: txResult("txInsufficientFee") }] });
    expect(await fee.submitter.send(signedTx())).toMatchObject({ status: "REJECTED", reason: "txInsufficientFee", retryable: false });
    expect(sendErrorCode(undefined)).toBeUndefined();
  });

  it("resends the same envelope after a mempool eviction", async () => {
    const tx = signedTx();
    const f = fake({ sends: [{ status: "PENDING" }], gets: [...notFound(5), { status: "SUCCESS" }] });
    expect((await f.submitter.send(tx)).status).toBe("SUCCESS");
    expect(f.hashes).toEqual([transactionHash(tx), transactionHash(tx)]);
  });

  it("keeps polling when a resend after PENDING errors, instead of a false REJECTED", async () => {
    const f = fake({
      sends: [{ status: "PENDING" }, { status: "ERROR", errorResult: txResult("txBadSeq") }],
      gets: [...notFound(6), { status: "SUCCESS" }],
      accountSeq: "101",
    });
    expect((await f.submitter.send(signedTx())).status).toBe("SUCCESS");
  });

  it("polls until a ledger closes past maxTime, then reports a safe-to-rebuild TIMEOUT", async () => {
    const f = fake({ sends: [{ status: "PENDING" }] });
    expect(await f.submitter.send(signedTx())).toMatchObject({ status: "TIMEOUT", reason: "expired", retryable: true });
    expect(f.log.filter((l) => l === "get").length).toBeGreaterThan(41);
  });
});

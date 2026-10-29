/** Bridge between the `AccountReader` port and stellar-sdk's `Account`. */
import { Account } from "@stellar/stellar-sdk";
import type { AccountReader, AccountSnapshot } from "./ports.js";

/** A stellar-sdk Account (source + sequence) built from a snapshot. */
export function toSdkAccount(snapshot: AccountSnapshot): Account {
  return new Account(snapshot.accountId, snapshot.sequence);
}

/** Load `accountId` through the reader as a stellar-sdk Account; throws if missing. */
export async function loadSdkAccount(reader: AccountReader, accountId: string): Promise<Account> {
  const snap = await reader.loadAccount(accountId);
  if (!snap) throw new Error(`account not found: ${accountId}`);
  return toSdkAccount(snap);
}

import { describe, expect, it } from 'vitest';
import { Address, StrKey, xdr } from '@stellar/stellar-sdk';
import { contractErrorCodes, guardErrorLabel, mergeFootprints } from '../lib/soroban.js';
import { summarize } from '../testnet/refusals.js';

const cid = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const dataKey = (n: number, sym: string) =>
  xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(cid(n)).toScAddress(), key: xdr.ScVal.scvSymbol(sym), durability: xdr.ContractDataDurability.persistent() }));
const fp = (ro: xdr.LedgerKey[], rw: xdr.LedgerKey[]) => new xdr.LedgerFootprint({ readOnly: ro, readWrite: rw });
const ids = (ks: xdr.LedgerKey[]) => ks.map((k) => k.toXDR('base64')).sort();

const errEvent = (code: number) =>
  new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
        topics: [xdr.ScVal.scvSymbol('error'), xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
        data: xdr.ScVal.scvVec([xdr.ScVal.scvString('escalating error to panic'), xdr.ScVal.scvError(xdr.ScError.sceContract(code))]),
      })),
    }),
  });

describe('landed refusals', () => {
  it('merges footprints without a key in both sets', () => {
    const a = dataKey(1, 'Cfg'), b = dataKey(1, 'Esc'), c = dataKey(2, 'Inst');
    const m = mergeFootprints([fp([a, c], []), fp([a], [b]), fp([b], [c])]);
    expect(ids(m.readWrite)).toEqual(ids([b, c]));
    expect(ids(m.readOnly)).toEqual(ids([a]));
  });

  it('reads contract error codes from diagnostic events, de-duplicated', () => {
    expect(contractErrorCodes([errEvent(15), errEvent(15)])).toEqual([15]);
    expect(contractErrorCodes(undefined)).toEqual([]);
    expect(guardErrorLabel(25)).toBe('Error(Contract, #25) Contested');
  });

  it('summarizes a refusal that was not landed as unconfirmed', () => {
    expect(summarize({ label: 'x', refused: 'enforce-sim PASSES' }, 8)).toMatchObject({ status: 'NOT LANDED', confirmed: false });
    expect(summarize({ label: 'y', hash: 'h', status: 'FAILED', link: 'l', errors: [guardErrorLabel(8)], expectedCode: 8, confirmed: true }, 8)).toMatchObject({ confirmed: true, link: 'l' });
  });
});

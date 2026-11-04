import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeFootprintMetric, observationsFromFile, type EscrowObservation, type Footprint, type ObservationFile } from '../metric/metric.js';
import { main as metricMain } from '../metric/index.js';

const UNIT = 10_000_000n;
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FOOTPRINT = join(FIX, 'metric-footprint.json');
const OBSERVATIONS = join(FIX, 'metric-observations.json');
const fp = JSON.parse(readFileSync(FOOTPRINT, 'utf8')) as Footprint;
const obs = observationsFromFile(JSON.parse(readFileSync(OBSERVATIONS, 'utf8')) as ObservationFile);

describe('Tranche 3 metric over the recorded (synthetic) fixture', () => {
  const r = computeFootprintMetric(fp, obs);

  it('passes with the expected totals', () => {
    expect(r.verdict).toBe('PASS');
    const m = r.result!;
    expect(m.escrows).toBe(36);
    expect(m.volumeUnits).toBe(7_200n * UNIT);
    expect(m.distinctBuyers).toBe(20);
    expect(m.distinctSellers).toBe(6);
    expect(m.silentBuyer).toEqual({ total: 6, counted: 6 });
  });

  it('ignores refunds and exclusions, drops foreign guards, and stops at the window end', () => {
    const m = r.result!;
    expect(m.refundsIgnored).toBe(1); // escrow 36: resolved to the buyer
    expect(m.excluded).toBe(1); // escrow 37: team test order
    expect(r.skipped).toEqual([{ escrow: fp.escrows[38], reason: 'guard is not release_signer and dispute_resolver' }]);
    // escrow 39 is funded on day 45.5, just after the 45-day funding window (released on day 46): not in the 36 counted.
    expect(m.window.start).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it('dropping two escrows misses the target on volume and count, while the floor still passes', () => {
    const f = computeFootprintMetric({ ...fp, escrows: fp.escrows.slice(2) }, obs);
    expect(f.verdict).toBe('PASS');
    expect(f.result!.target.volume).toBe(false);
    expect(f.result!.target.escrows).toBe(false);
    expect(f.result!.target.met).toBe(false);
  });

  it('fails the floor when only a few escrows remain', () => {
    const f = computeFootprintMetric({ ...fp, escrows: fp.escrows.slice(0, 10) }, obs);
    expect(f.verdict).toBe('FAIL');
    expect(f.result!.thresholds.escrows).toBe(false);
    expect(f.result!.thresholds.volume).toBe(false);
  });

  it('caps silent-buyer resolutions at two thirds of the counted escrows', () => {
    // Escrows 30-33 are silent-buyer resolutions to the seller; 0 and 1 are buyer-approved releases.
    const ids = (idx: number[]) => idx.map((i) => obs[i]!.id);
    const one = computeFootprintMetric({ ...fp, escrows: ids([0, 30, 31, 32, 33]), excluded: [] }, obs).result!;
    expect(one.silentBuyer).toEqual({ total: 4, counted: 2 });
    expect(one.escrows).toBe(3);
    const two = computeFootprintMetric({ ...fp, escrows: ids([0, 1, 30, 31, 32, 33]), excluded: [] }, obs).result!;
    expect(two.silentBuyer).toEqual({ total: 4, counted: 4 });
    expect(two.escrows).toBe(6);
  });

  it('counts no silent-buyer resolution without a buyer approval', () => {
    const allSilent: EscrowObservation[] = obs.map((o) => ({ ...o, flags: { released: false, resolved: true, disputed: true }, buyerApproved: false }));
    const f = computeFootprintMetric(fp, allSilent);
    expect(f.result!.silentBuyer.counted).toBe(0);
    expect(f.verdict).toBe('FAIL');
  });

  it('counts only the seller net of a split resolution (never over-states volume)', () => {
    const o = obs[30]!; // resolved to the seller
    // Alone in the footprint a silent-buyer resolution is capped to zero (no loud escrow to
    // pair with), so mark it buyer-approved: this test is about the split, not the cap.
    const pay = o.transfers.find((t) => t.from === o.id)!;
    const split: EscrowObservation = { ...o, buyerApproved: true, transfers: [...o.transfers, { from: o.id, to: o.roles.approver, amount: 5n * UNIT, at: pay.at, txHash: pay.txHash }] };
    const f = computeFootprintMetric({ ...fp, escrows: [o.id], excluded: [] }, [split]);
    expect(f.result!.volumeUnits).toBe(190n * UNIT);
  });
});

// Run 9 (29 Oct 2026, guard v0.10, Circle testnet EURC; docs/testnet-proofs.md, docs/runs/run-9.md).
// IDs, hashes, amounts and ledger close times as recorded on testnet (Horizon). Escrow A is the
// buyer-approved release; escrow W paid the seller alone through withdraw_remaining_funds past a
// buyer with no trustline, which leaves W disputed, not resolved and not released.
describe('run 9 replay: a seller payout through withdraw_remaining_funds counts', () => {
  const R9 = {
    platform: 'GBSMR7SXBBZOTKVACPRDFD7MXKBKR3UPTN72EZ74J5HQ27ARMPAI4N2I',
    twFee: 'GAL6VCTX3EPDZDMHKQENLGQJ4UPZZ5ABBTSRJTQ5N3L53TWR3Z3CX3LW',
    guard: 'CCRZHNU2CHN62BXALEFHAJEX57AURBB7OWYM37I7JSO7HLALHVJ2KVUZ',
    token: 'CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ',
    buyer: 'GDXXMBLWASPHLHCTZNXITELCS3CMWIVTUWHZM336AWZSKXDNNQOMONMC',
    wBuyer: 'GBQ542QMARB4MPZ3FFIKD6WNADRF5YQZJ44WQAO7OSII5ISDJM3NCXY4',
    seller: 'GDJMHIH3UWWD4CGZ47JJXXPIFOBXAKBEZSUT3LANWGP6K2AMR6S3PQBH',
    A: 'CAN3PEKNDM3HIXGAYZSRGWJ66ENF2IBDS67UZITMP3SQXA5PB4364CMD',
    W: 'CCFF7GHTZ7QFR33MNNQHVCMKDWKU3BSQCTMTN4U5LY65UH5T2Q6FRHRM',
  };
  const fp9: Footprint = {
    network: 'testnet',
    platform: R9.platform,
    guard: R9.guard,
    registry: 'CC6K26NQGSD3UAIUS463ZJCEC7SGEF6V5R34OYZX3WHY6URFTKQ5FBDX',
    sponsor: 'GCEVJUZZ56LSFVHH6ESD2ZKZMIYRAFMHCWGWO32NUXFPWPKOT4SPUCP5',
    token: R9.token,
    escrows: [R9.A, R9.W],
  };
  const roles = (approver: string) => ({ approver, receiver: R9.seller, service_provider: R9.seller, platform: R9.platform, release_signer: R9.guard, dispute_resolver: R9.guard });
  const payout = (escrow: string, txHash: string, at: number) => [
    { from: escrow, to: R9.twFee, amount: 60_000n, at, txHash },
    { from: escrow, to: R9.platform, amount: 940_000n, at, txHash },
    { from: escrow, to: R9.seller, amount: 19_000_000n, at, txHash },
  ];
  const A: EscrowObservation = {
    id: R9.A,
    amount: 20_000_000n,
    token: R9.token,
    roles: roles(R9.buyer),
    flags: { released: true, resolved: false, disputed: false },
    buyerApproved: true,
    transfers: [
      { from: R9.buyer, to: R9.A, amount: 20_000_000n, at: 1_793_300_635, txHash: '079f5b4bab2d2bf04e8022c540be9ef9ec02202a248606912ef5e536a5496964' },
      ...payout(R9.A, 'f2cdbd2c87eb0d525efce66bd73d8e179afbfb50e5ac735a9c33b88a9e355618', 1_793_300_665),
    ],
  };
  const W: EscrowObservation = {
    id: R9.W,
    amount: 20_000_000n,
    token: R9.token,
    roles: roles(R9.wBuyer),
    flags: { released: false, resolved: false, disputed: true },
    buyerApproved: false,
    transfers: [
      { from: R9.wBuyer, to: R9.W, amount: 20_000_000n, at: 1_793_300_795, txHash: 'eb7d3dd03556237e100bb306e71f47b727eb03147a043ffd2df451504be5d847' },
      { from: R9.buyer, to: R9.W, amount: 1n, at: 1_793_300_810, txHash: 'fbc16d7460b4c085ed24d61a6a818ecadf39972799e8cf20306acd90defc14f9' },
      ...payout(R9.W, '2d696d8b8ba704ed3338c1cb061db6ea9519e2829ce2036abd06e3069a3ae972', 1_793_300_970),
    ],
  };

  it('counts W as one silent-buyer resolution to the seller, beside the buyer-approved release A', () => {
    const m = computeFootprintMetric(fp9, [A, W]).result!;
    expect(m.silentBuyer).toEqual({ total: 1, counted: 1 });
    expect(m.escrows).toBe(2);
    expect(m.volumeUnits).toBe(40_000_000n); // 2 EURC gross each, fees included
    expect(m.distinctBuyers).toBe(2);
    expect(m.distinctSellers).toBe(1);
  });

  it('does not count a buyer-only withdraw_remaining_funds from a disputed escrow', () => {
    const refundTx = 'b'.repeat(64);
    const buyerOnly: EscrowObservation = {
      ...W,
      transfers: [...W.transfers.filter((t) => t.from !== R9.W), { from: R9.W, to: R9.wBuyer, amount: 20_000_001n, at: 1_793_300_970, txHash: refundTx }],
    };
    const m = computeFootprintMetric(fp9, [A, buyerOnly]).result!;
    expect(m.silentBuyer).toEqual({ total: 0, counted: 0 });
    expect(m.escrows).toBe(1);
    expect(m.volumeUnits).toBe(20_000_000n);
  });
});

describe('metric CLI', () => {
  it('prints PASS and exits 0 over the fixture', async () => {
    const lines: string[] = [];
    const code = await metricMain(['--footprint', FOOTPRINT, '--observations', OBSERVATIONS], { log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('VERDICT: PASS');
  });

  it('exits 3 on FAIL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-metric-'));
    const small = join(dir, 'footprint.json');
    writeFileSync(small, JSON.stringify({ ...fp, escrows: fp.escrows.slice(0, 10) }));
    const lines: string[] = [];
    const code = await metricMain(['--footprint', small, '--observations', OBSERVATIONS, '--json'], { log: (l) => lines.push(l) });
    expect(code).toBe(3);
    expect(JSON.parse(lines[0]!).verdict).toBe('FAIL');
  });
});

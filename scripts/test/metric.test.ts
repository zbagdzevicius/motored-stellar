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

  it('caps silent-buyer resolutions at half of the counted escrows', () => {
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

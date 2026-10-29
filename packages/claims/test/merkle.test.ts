import { describe, expect, it } from "vitest";
import vectors from "./vectors.json";
import { MAX_DEPTH, buildTree, fromHex, nodeHash, padLeaf, proofOf, random, toHex, verifyProof } from "../src/index.js";

const leaves = (n: number) => Array.from({ length: n }, () => random(32));

describe("Merkle batches", () => {
  for (const n of [1, 2, 3, 7, 8, 33]) {
    it(`every leaf verifies at size ${n}`, () => {
      const ls = leaves(n);
      const t = buildTree(ls);
      expect(t.depth).toBe(Math.ceil(Math.log2(n)));
      for (let i = 0; i < n; i++) {
        const p = proofOf(t, i);
        expect(p.length).toBe(t.depth);
        expect(verifyProof(ls[i]!, p, i, t.root)).toBe(true);
      }
    });
  }

  it("a single-leaf batch has root = leaf and an empty proof", () => {
    const [l] = leaves(1);
    const t = buildTree([l!]);
    expect(toHex(t.root)).toBe(toHex(l!));
    expect(proofOf(t, 0)).toEqual([]);
  });

  it("matches the fixed 3-leaf vector (padding leaf 3 = sha256(0x03 || u32be(3)))", () => {
    const t = buildTree(vectors.merkle.leaves.map(fromHex));
    expect(toHex(padLeaf(3))).toBe(vectors.merkle.padding_leaf_3);
    expect(toHex(t.root)).toBe(vectors.merkle.root);
    const [a, b, c] = vectors.merkle.leaves.map(fromHex);
    expect(toHex(nodeHash(nodeHash(a!, b!), nodeHash(c!, padLeaf(3))))).toBe(vectors.merkle.root);
  });

  it("rejects a tampered leaf", () => {
    const ls = leaves(7);
    const t = buildTree(ls);
    const bad = new Uint8Array(ls[3]!);
    bad[0] = bad[0]! ^ 1;
    expect(verifyProof(bad, proofOf(t, 3), 3, t.root)).toBe(false);
  });

  it("rejects a wrong index, including one with extra high bits", () => {
    const ls = leaves(8);
    const t = buildTree(ls);
    const p = proofOf(t, 5);
    expect(verifyProof(ls[5]!, p, 4, t.root)).toBe(false);
    // Same low bits but not fully consumed: the registry requires index == 0 at the end.
    expect(verifyProof(ls[5]!, p, 5 + 8, t.root)).toBe(false);
  });

  it("rejects a proof longer than 32", () => {
    const l = random(32);
    let h = l;
    const proof: Uint8Array[] = [];
    for (let d = 0; d < MAX_DEPTH + 1; d++) {
      const sib = random(32);
      proof.push(sib);
      h = nodeHash(h, sib);
    }
    expect(verifyProof(l, proof, 0, h)).toBe(false);
  });

  it("accepts a hand-built depth-32 proof at the maximum index (as the lab did on testnet)", () => {
    const l = random(32);
    const index = 0xffff_ffff;
    let h = l;
    const proof: Uint8Array[] = [];
    for (let d = 0; d < MAX_DEPTH; d++) {
      const sib = random(32);
      proof.push(sib);
      h = nodeHash(sib, h);
    }
    expect(verifyProof(l, proof, index, h)).toBe(true);
  });

  it("refuses empty batches and out-of-range proof indices", () => {
    expect(() => buildTree([])).toThrow();
    const t = buildTree(leaves(3));
    expect(() => proofOf(t, 3)).toThrow(); // index 3 is padding, never a claim
    expect(() => buildTree(leaves(5), 4)).toThrow();
  });
});

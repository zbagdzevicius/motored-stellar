// Regenerates test/vectors.json using node:crypto only (no Stellar SDK), so the
// vectors are an independent cross-check of src/leaf.ts. The same vectors are
// asserted by contracts/guard/src/test_vectors.rs against the Rust `leaf()`.
// Inputs are fixed pseudo-random values (sha256 of labels) and fake parcel numbers;
// nothing here is real order or parcel data.
// Usage: node test/gen-vectors.mjs > test/vectors.json
import { createHash, createHmac } from 'node:crypto';
const sha = (b) => createHash('sha256').update(b).digest();
const lbl = (s) => sha(Buffer.from(s));
function crc16(buf){let c=0;for(const b of buf){c^=b<<8;for(let i=0;i<8;i++){c=(c&0x8000)?((c<<1)^0x1021)&0xffff:(c<<1)&0xffff;}}return c;}
const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(buf){let bits=0,v=0,o='';for(const b of buf){v=(v<<8)|b;bits+=8;while(bits>=5){o+=A[(v>>>(bits-5))&31];bits-=5;}}if(bits>0)o+=A[(v<<(5-bits))&31];return o;}
function cstr(id){const p=Buffer.concat([Buffer.from([2<<3]),id]);const c=crc16(p);return b32(Buffer.concat([p,Buffer.from([c&0xff,c>>8])]));}
const enc=(s)=>Buffer.from(s,'utf8');
const out=[];
const ats=[0n,1761337000n,18446744073709551615n];
for(let n=1;n<=3;n++){
  const id=lbl(`motored-stellar/claims/vector-${n}/escrow`);
  const order_ref=lbl(`motored-stellar/claims/vector-${n}/order_ref`);
  const salt=lbl(`motored-stellar/claims/vector-${n}/salt`);
  const parcel=`TEST-PARCEL-000${n}`;
  const parcels_commit=createHmac('sha256',salt).update(enc(parcel)).digest();
  const status='Delivered', dt=`2026-10-2${n}T12:00:00Z`;
  const carrier_event_ref=sha(Buffer.concat([enc(parcel),enc(status),enc(dt),enc('lang=en')]));
  const at=ats[n-1]; const be=Buffer.alloc(8); be.writeBigUInt64BE(at);
  const xdrAddr=Buffer.concat([Buffer.from([0,0,0,18,0,0,0,1]),id]);
  const leaf=sha(Buffer.concat([Buffer.from([1]),xdrAddr,order_ref,parcels_commit,carrier_event_ref,be]));
  out.push({name:`vector-${n}`,escrow:cstr(id),escrow_contract_id:id.toString('hex'),escrow_scval_xdr:xdrAddr.toString('hex'),order_ref:order_ref.toString('hex'),
    parcel_number:parcel,salt:salt.toString('hex'),parcels_commit:parcels_commit.toString('hex'),carrier_status_text:status,carrier_date_time:dt,lang:'en',
    carrier_event_ref:carrier_event_ref.toString('hex'),delivered_at:at.toString(),leaf:leaf.toString('hex')});
}
// merkle vector: 3 leaves = vectors' leaves, padded to 4
const node=(l,r)=>sha(Buffer.concat([Buffer.from([2]),l,r]));
const pad=(i)=>{const b=Buffer.alloc(4);b.writeUInt32BE(i);return sha(Buffer.concat([Buffer.from([3]),b]));};
const L=out.map(o=>Buffer.from(o.leaf,'hex')); const l3=pad(3);
const root=node(node(L[0],L[1]),node(L[2],l3));
console.log(JSON.stringify({leaves:out,merkle:{leaves:out.map(o=>o.leaf),padding_leaf_3:l3.toString('hex'),root:root.toString('hex')}},null,2));

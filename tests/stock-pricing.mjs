import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const context={window:{}};vm.runInNewContext(fs.readFileSync(new URL('../stock_pricing.js',import.meta.url),'utf8'),context);
const build=context.window.AAFStockPricing.build;
const spec={w:1220,l:2440,t:1.6,grade:'B',unit:'sheet'};
const row=(qty,more={})=>({...spec,qty,...more});
const line=(id,qty,value,currency='THB',more={})=>({...spec,id,month:'2026-09',qty,loaded:false,customer:id,salesperson:'Sales',...(value===null?{}:{priceObj:{price:value,currency},priceSource:{...spec,id:'01-'+id,page:1,month:'2026-09',customer:id,salesperson:'Sales',priceObj:{price:value,currency}}}),...more});
const run=(stockRows,orderedAllocations)=>build({month:'2026-09',stockRevision:7,orderChecksum:'sha256:fixture',exchangeRate:33,stockRows,orderedAllocations});
test('Owner example: 20×2 + 30×3 + 50×2.6 = 260; not simple average',()=>{
 const input=[row(100)],orders=[line('a',20,2),line('b',30,3)],before=JSON.stringify({input,orders});const result=run(input,orders),r=result.rows[0];
 assert.equal(r.remainderAverageTHB,2.6);assert.equal(r.remainderQty,50);assert.equal(r.completeValueTHB,260);assert.equal(r.effectiveUnitPriceTHB,2.6);assert.equal(JSON.stringify({input,orders}),before);
});
test('Preserves priority and values only actual stock, never the shortage',()=>{
 const result=run([row(100)],[line('a',70,2),line('b',80,10)]),r=result.rows[0];
 assert.equal(r.completeValueTHB,440);assert.equal(r.shortageQty,50);assert.equal(result.allocations[1].allocatedQty,30);assert.equal(result.allocations[1].valueTHB,300);assert.equal(r.remainderQty,0);
});
test('Loaded and evidenced duplicates neither consume nor change averages',()=>{
 const result=run([row(100)],[line('loaded',999,900,'THB',{loaded:true}),line('duplicate',500,900,'THB',{excluded:true,exclusionReason:'same document and line verified'}),line('a',20,2),line('b',30,3)]);
 assert.equal(result.rows[0].completeValueTHB,260);assert.equal(result.ignored.length,2);
});
test('AC2N only: correct currency to THB, keep number and raw input unchanged',()=>{
 const orders=[line('AC2N',20,91.5,'USD'),line('Other Thai customer',30,3,'USD')],before=JSON.stringify(orders);const r=run([row(100)],orders);
 assert.equal(r.allocations[0].priceObj.currency,'THB');assert.equal(r.allocations[0].valueTHB,1830);assert.equal(r.allocations[1].priceObj.currency,'USD');assert.equal(r.allocations[1].valueTHB,2970);assert.equal(r.rows[0].completeValueTHB,9600);assert.equal(r.corrections.length,1);assert.equal(JSON.stringify(orders),before);
});
test('Unknown price consumes stock and stays blank, not a zero-valued full total',()=>{
 const r=run([row(100)],[line('unknown',70,null),line('known',50,10)]);
 assert.equal(r.allocations[1].allocatedQty,30);assert.equal(r.rows[0].unpricedQty,70);assert.equal(r.rows[0].shortageQty,20);assert.equal(r.rows[0].knownValueTHB,300);assert.equal(r.completeValueTHB,null);assert.equal(r.allocations[0].valueTHB,null);
});
test('Missing current price preserves confirmed existing price; no default 0',()=>{
 const r=run([row(100,{priceObj:{price:5,currency:'THB'},priceConfirmed:true,note:'keep',followup:'keep'})],[line('missing',20,null)]);
 assert.equal(r.rows[0].completeValueTHB,500);assert.equal(r.allocations[0].priceBasis,'existing-confirmed');
 const blank=run([row(100,{priceObj:{price:0,currency:'THB'},priceConfirmed:false})],[]);
 assert.equal(blank.rows[0].completeValueTHB,null);assert.equal(blank.rows[0].unpricedQty,100);
});
test('Zero/missing stock produces shortages, not imaginary stock value',()=>{
 const r=run([],[line('a',20,2)]);assert.equal(r.rows[0].shortageQty,20);assert.equal(r.rows[0].completeValueTHB,0);assert.equal(r.rows[0].physicalQty,0);assert.equal(r.rows[0].effectiveUnitPriceTHB,null);
});
test('Price/currency are bound to observed source before any correction',()=>{
 for(const change of [l=>l.priceObj.price=99,l=>l.priceObj.currency='USD',l=>l.priceSource.priceObj=undefined]){
   const l=line('a',20,2);change(l);assert.throws(()=>run([row(100)],[l]));
 }
});
test('Source zero is unknown: keep existing confirmed price or blank',()=>{
 const old=run([row(100,{priceObj:{price:5,currency:'THB'},priceConfirmed:true})],[line('a',20,0)]);
 assert.equal(old.rows[0].completeValueTHB,500);assert.equal(old.allocations[0].priceBasis,'existing-confirmed');
 const blank=run([row(100)],[line('AC2N',20,0,'USD')]);
 assert.equal(blank.rows[0].completeValueTHB,null);assert.equal(blank.rows[0].unpricedQty,100);assert.equal(blank.corrections.length,0);
});
test('Fractional allocated quantities stay exact; units and rotated specs stay separate',()=>{
 const r=run([row(100)],[line('a',15.15,2),line('b',14.85,3)]);
 assert.equal(r.rows[0].allocatedQty,30);assert.equal(r.rows[0].remainderQty,70);assert(Math.abs(r.rows[0].completeValueTHB-249.5)<1e-8);
 const s=run([row(100)],[line('strip',50,null,'THB',{unit:'strip'}),line('rotated',40,null,'THB',{w:2440,l:1220})]);assert.equal(s.rows.length,3);assert.equal(s.rows[0].remainderQty,100);
});
test('Wrong month, incomplete price joins, duplicates and invalid values fail closed',()=>{
 const variations=[l=>l.month='2026-10',l=>l.loaded=undefined,l=>l.qty=-1,l=>l.qty=0.001,l=>l.priceSource.customer='other',l=>l.priceSource.month='2026-10',l=>l.priceSource.grade='AAA',l=>l.priceSource.w=1270,l=>l.priceSource.page=9,l=>l.priceSource.id='',l=>l.priceObj.currency='EUR',l=>l.priceObj.price=NaN,l=>l.grade='Mix'];
 for(const change of variations){const l=line('a',20,2);change(l);assert.throws(()=>run([row(100)],[l]));}
 assert.throws(()=>run([row(100),row(10)],[]));assert.throws(()=>run([row(100)],[line('a',20,2),line('a',20,2)]));
});
test('Legacy simple-average sync cannot mutate prices or reservations',()=>{
 const source=fs.readFileSync(new URL('../stock_shared.js',import.meta.url),'utf8');
 const sync=source.slice(source.indexOf('  window.syncSalesData='),source.indexOf('  function reportRows'));
 assert(sync.includes('ราคาเฉลี่ยถ่วงน้ำหนัก'));assert(!sync.includes('save('));assert(!sync.includes('localStorage'));assert(!sync.includes('committedQty'));
});

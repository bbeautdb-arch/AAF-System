/* Pure valuation projection. It never imports mail, edits prices, or changes reservations.
 * Feed the complete validated reservation ledger in its existing priority order,
 * with current-month Page 01 prices already joined by customer/salesperson/spec.
 * A filtered table or aggregate committedQty is not a valid substitute for that ledger.
 */
(() => {
  'use strict';
  const VERSION='aaf-stock-pricing-20260911-v1';
  const grades=new Set(['AV','AAA','A','B','F','REJ','C','UN','CTS']);
  const fail=message=>{throw Error(message);};
  const number=(v,label)=>{
    if(typeof v!=='number'||!Number.isFinite(v)||v<0)fail('Invalid '+label);
    return v;
  };
  const hundredths=(v,label)=>{
    number(v,label);const n=Math.round(v*100);
    if(!Number.isSafeInteger(n)||Math.abs(n/100-v)>1e-8)fail('Invalid quantity precision: '+label);
    return n;
  };
  function identity(row){
    if(!row||!['w','l','t'].every(k=>typeof row[k]==='number'&&Number.isFinite(row[k])&&row[k]>0)||!grades.has(row.grade)||!['sheet','strip'].includes(row.unit))fail('Incomplete exact stock spec/grade/unit');
    return [row.w,row.l,row.t,row.grade,row.unit].join('|');
  }
  function price(p,label){
    if(!p||typeof p.price!=='number'||!Number.isFinite(p.price)||p.price<0||!['THB','USD'].includes(p.currency))fail('Invalid price: '+label);
    return {price:p.price,currency:p.currency};
  }
  function build(input){
    if(!input||!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)||!Number.isSafeInteger(input.stockRevision)||input.stockRevision<0||typeof input.orderChecksum!=='string'||!input.orderChecksum.trim())fail('Missing source month/revision/order checksum');
    const fx=number(input.exchangeRate,'exchange rate');if(!fx)fail('Exchange rate must be positive');
    if(!Array.isArray(input.stockRows)||!Array.isArray(input.orderedAllocations))fail('Missing complete stock/ordered allocation arrays');
    const byKey=new Map(),ids=new Set(),allocations=[],ignored=[],corrections=[];
    const thb=p=>{const n=p.price*(p.currency==='USD'?fx:1);if(!Number.isFinite(n))fail('Price overflow');return n;};
    function create(row,missing=false){
      const key=identity(row),base=missing?0:hundredths(row.qty,key);
      let fallback=null;
      // Legacy defaults of 0 are not evidence of a confirmed price.
      if(!missing&&row.priceConfirmed===true&&!row.priceMissing&&row.priceObj?.price>0)fallback=price(row.priceObj,key);
      return {key,w:row.w,l:row.l,t:row.t,grade:row.grade,unit:row.unit,physicalQty:base/100,remainingHundredths:base,allocatedHundredths:0,shortageHundredths:0,pricedHundredths:0,knownValueTHB:0,segments:[],fallback,missingStock:missing};
    }
    for(const row of input.stockRows){const entry=create(row);if(byKey.has(entry.key))fail('Duplicate stock spec: '+entry.key);byKey.set(entry.key,entry);}
    for(const line of input.orderedAllocations){
      if(!line||typeof line.id!=='string'||!line.id.trim()||ids.has(line.id))fail('Missing/duplicate order line ID');ids.add(line.id);
      if(typeof line.loaded!=='boolean'||line.month!==input.month)fail('Missing loaded state or wrong order month: '+line.id);
      if(line.loaded||line.excluded===true){
        if(line.excluded===true&&!line.exclusionReason)fail('Excluded line needs evidence: '+line.id);
        ignored.push({id:line.id,reason:line.loaded?'loaded':line.exclusionReason});continue;
      }
      const key=identity(line),requested=hundredths(line.qty,line.id);
      if(!byKey.has(key))byKey.set(key,create(line,true));
      const entry=byKey.get(key),allocated=Math.min(requested,entry.remainingHundredths),shortage=requested-allocated;
      let p=null,priceBasis='unknown',source=null;
      if(line.priceObj!=null){
        source=line.priceSource;
        if(!source||source.page!==1||source.month!==input.month||typeof source.id!=='string'||!source.id.trim()||!line.customer||!line.salesperson||source.customer!==line.customer||source.salesperson!==line.salesperson||identity(source)!==key)fail('Price not joined to exact current-month Page 01 customer/salesperson/spec: '+line.id);
        p=price(line.priceObj,line.id);
        const observed=price(source.priceObj,'Page 01 evidence '+source.id);
        if(p.price!==observed.price||p.currency!==observed.currency)fail('Price differs from observed Page 01 evidence: '+line.id);
        priceBasis='page01';
        // Sales data uses 0 for missing prices. Free-of-charge goods have not
        // been approved; do not overwrite a known price or claim full coverage.
        if(p.price===0){p=entry.fallback?{...entry.fallback}:null;priceBasis=p?'existing-confirmed':'unknown';}
        if(priceBasis==='page01'&&line.customer.trim().toUpperCase()==='AC2N'&&p.currency!=='THB'){
          corrections.push({lineId:line.id,sourceId:source.id,customer:line.customer,price:p.price,from:p.currency,to:'THB',reason:'owner-confirmed AC2N THB, 2026-09-11'});
          p={...p,currency:'THB'};
        }
      }else if(entry.fallback){p={...entry.fallback};priceBasis='existing-confirmed';}
      const value=p?allocated/100*thb(p):null;
      if(value!==null&&!Number.isFinite(value))fail('Value overflow: '+line.id);
      const segment={id:line.id,key,customer:line.customer||'',salesperson:line.salesperson||'',requestedQty:requested/100,allocatedQty:allocated/100,shortageQty:shortage/100,priceObj:p,priceBasis,priceSource:source?{...source}:null,valueTHB:value};
      entry.segments.push(segment);allocations.push(segment);
      entry.remainingHundredths-=allocated;entry.allocatedHundredths+=allocated;entry.shortageHundredths+=shortage;
      if(p){entry.pricedHundredths+=allocated;entry.knownValueTHB+=value;}
      if(!Number.isSafeInteger(entry.shortageHundredths)||!Number.isFinite(entry.knownValueTHB))fail('Totals overflow: '+key);
    }
    const rows=Array.from(byKey.values()).map(entry=>{
      // Average only known, physically allocated quantities. Shortages and loaded
      // lines cannot influence inventory value. Never round fractional Mix shares.
      const average=entry.pricedHundredths?entry.knownValueTHB/(entry.pricedHundredths/100):(entry.fallback?thb(entry.fallback):null);
      const remainderQty=entry.remainingHundredths/100;
      const remainderValue=average===null?(remainderQty===0?0:null):remainderQty*average;
      const unknownAllocated=(entry.allocatedHundredths-entry.pricedHundredths)/100;
      const unpricedQty=unknownAllocated+(average===null?remainderQty:0);
      const knownValueTHB=entry.knownValueTHB+(remainderValue??0);
      if(!Number.isFinite(knownValueTHB))fail('Totals overflow: '+entry.key);
      return {key:entry.key,w:entry.w,l:entry.l,t:entry.t,grade:entry.grade,unit:entry.unit,physicalQty:entry.physicalQty,allocatedQty:entry.allocatedHundredths/100,remainderQty,shortageQty:entry.shortageHundredths/100,remainderAverageTHB:average,remainderValueTHB:remainderValue,knownValueTHB,unpricedQty,completeValueTHB:unpricedQty?null:knownValueTHB,effectiveUnitPriceTHB:unpricedQty||!entry.physicalQty?null:knownValueTHB/entry.physicalQty,missingStock:entry.missingStock,segments:entry.segments};
    });
    const knownValueTHB=rows.reduce((sum,r)=>sum+r.knownValueTHB,0);
    if(!Number.isFinite(knownValueTHB))fail('Overall value overflow');
    return {version:VERSION,month:input.month,stockRevision:input.stockRevision,orderChecksum:input.orderChecksum,exchangeRate:fx,rows,allocations,ignored,corrections,knownValueTHB,completeValueTHB:rows.some(r=>r.unpricedQty>0)?null:knownValueTHB,coverage:rows.filter(r=>r.unpricedQty>0).map(r=>({key:r.key,unpricedQty:r.unpricedQty})),notForStockImport:true};
  }
  window.AAFStockPricing={build,VERSION};
})();

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ClickPesa,checksum,verifyWebhook,phone,verifiedPayment}=require('./clickpesa');
const {quoteFees}=require('./fee-quote');
const {installPayments}=require('./online-payments');
const {quoteValid,startPayoutWorker}=require('./payouts');
const config={CLICKPESA_COLLECTION_ENABLED:'true',CLICKPESA_CLIENT_ID:'client',CLICKPESA_API_KEY:'private-key',CLICKPESA_CHECKSUM_KEY:'signing-key',CLICKPESA_PAYOUT_ENABLED:'true',CLICKPESA_PAYOUT_FEE_MODE:'parent',CLICKPESA_RECIPIENT_PHONE:'255781234567',CLICKPESA_RECIPIENT_NAME:'TEST RECIPIENT'};
const order={reference:'AS'+'A'.repeat(18),student_id:1,parent_id:10,amount:5100,tuition_amount:5000,phone:'255712345678',client_id:'client',state:'pending',quoted_at:new Date(),payout_reference:'AP'+'B'.repeat(18),payout_amount:5000,payout_total:5100,payout_fee:100,recipient_phone:config.CLICKPESA_RECIPIENT_PHONE,recipient_name:config.CLICKPESA_RECIPIENT_NAME};
const paid={id:'provider-id',paymentReference:'provider-reference',orderReference:order.reference,clientId:'client',status:'SUCCESS',collectedCurrency:'TZS',collectedAmount:'5100.00'};
function payoutQuote(amount,fee=100){return {amount:amount+fee,fee,exchanged:false,channelProvider:'AIRTEL MONEY',order:{id:order.payout_reference,amount,currency:'TZS'},receiver:{accountNumber:config.CLICKPESA_RECIPIENT_PHONE,accountName:config.CLICKPESA_RECIPIENT_NAME,amount,accountCurrency:'TZS'}};}
test('canonical signatures cover nested data; forged and unsigned webhooks fail',()=>{
  const a={data:{z:2,a:1},event:'PAYMENT RECEIVED'};
  assert.equal(checksum(a,'k'),checksum({event:a.event,data:{a:1,z:2}},'k'));
  const signed={...a,checksum:checksum(a,'k'),checksumMethod:'canonical'};
  assert.equal(verifyWebhook(signed,'k'),true);
  assert.equal(verifyWebhook({...signed,data:{z:2,a:9}},'k'),false);
  assert.equal(verifyWebhook(a,'k'),false);
  assert.equal(verifyWebhook({...signed,checksumMethod:'legacy'},'k'),false);
});
test('phone normalization rejects invalid destinations',()=>{
  assert.equal(phone('0781 234 567'),'255781234567');
  for(const v of ['123',null,'2557812345670','+254712345678'])assert.throws(()=>phone(v));
});
test('only exact provider-verified amount, currency, client and final status credit an order',()=>{
  assert.equal(verifiedPayment([paid],order,'client'),paid);
  for(const change of [{collectedAmount:5000},{collectedCurrency:'USD'},{clientId:'other'},{status:'PROCESSING'},{orderReference:'other'},{id:''},{paymentReference:''},{collectedAmount:'5.1e3'}]) assert.equal(verifiedPayment([{...paid,...change}],order,'client'),null);
});
test('concurrent authorization uses one token request, never redirects secrets',async()=>{
  let calls=0;const p=new ClickPesa(config,async(url,opts)=>{calls++;assert.equal(opts.redirect,'manual');assert.equal(opts.body,'{}');await new Promise(r=>setTimeout(r,2));return {ok:true,json:async()=>({success:true,token:'Bearer private'})};});
  await Promise.all([p.authorize(),p.authorize(),p.authorize()]);assert.equal(calls,1);
  const redirect=new ClickPesa(config,async()=>({ok:false,status:302}));await assert.rejects(()=>redirect.authorize());
});
test('parent gross includes both fees and preserves full tuition for recipient',async()=>{
  const provider={config,request:async(path,payload)=>{assert.ok(path.includes('preview'));return payoutQuote(payload.amount);},preview:async(o,fetchSender)=>{assert.equal(fetchSender,true);return {sender:{accountNumber:o.phone,accountProvider:'MPESA'},activeMethods:[{name:'M-PESA',status:'AVAILABLE',fee:200}]};}};
  const quote=await quoteFees(provider,order);
  assert.equal(quote.amount,5100);assert.equal(quote.chargeTotal,5300);assert.equal(quote.collectionFee,200);assert.equal(quote.payoutFee,100);assert.equal(quote.payoutAmount,5000);assert.equal(quote.payoutTotal,5100);
});
test('collection fee is displayed once, separate from API principal',async()=>{
  const provider={config,request:async(path,p)=>payoutQuote(p.amount),preview:async o=>({sender:{accountNumber:o.phone,accountProvider:'AIRTEL MONEY'},activeMethods:[{name:'AIRTEL-MONEY',status:'AVAILABLE',fee:Math.ceil(o.amount*0.01)}]})};
  const q=await quoteFees(provider,order);assert.equal(q.amount,q.payoutTotal);assert.equal(q.chargeTotal,q.amount+q.collectionFee);assert.equal(q.payoutAmount,order.tuition_amount);
});
test('beneficiary-borne payout fees are grossed up so recipient still receives full tuition',async()=>{
  const provider={config,request:async(path,p)=>{const q=payoutQuote(p.amount,100);q.amount=p.amount;q.receiver.amount=p.amount-100;return q;},preview:async o=>({sender:{accountNumber:o.phone,accountProvider:'MPESA'},activeMethods:[{name:'M-PESA',status:'AVAILABLE',fee:200}]})};
  const q=await quoteFees(provider,order);assert.equal(q.payoutAmount,5100);assert.equal(q.amount,5100);assert.equal(q.chargeTotal,5300);assert.equal(q.payoutFee,100);
});
test('unknown sender fees and wrong recipient names block quoting',async()=>{
  const provider={config,request:async(path,p)=>payoutQuote(p.amount),preview:async o=>({sender:{accountNumber:o.phone,accountProvider:'MPESA'},activeMethods:[{name:'M-PESA',status:'AVAILABLE'}]})};
  await assert.rejects(()=>quoteFees(provider,order));
  provider.request=async(path,p)=>({...payoutQuote(p.amount),receiver:{...payoutQuote(p.amount).receiver,accountName:'OTHER'}});
  await assert.rejects(()=>quoteFees(provider,order));
});
test('payout preview must bind destination, reference, recipient, full amount and fees',()=>{
  const p={reference:order.payout_reference,phone:config.CLICKPESA_RECIPIENT_PHONE,recipient_name:config.CLICKPESA_RECIPIENT_NAME};
  assert.equal(quoteValid(payoutQuote(5000),p,5000,100),true);
  assert.equal(quoteValid(payoutQuote(5000,101),p,5000,100),false);
  assert.equal(quoteValid({...payoutQuote(5000),channelProvider:'OTHER'},p,5000,100),false);
});
function ledgerFixture(payments=[paid]){
  const current={...order};let ledger=[],outbox=[],notes=0,backup;
  const query=async(sql,args=[])=>{
    if(sql==='BEGIN'){backup={ledger:[...ledger],outbox:[...outbox],state:current.state,notes};return {rows:[]};}
    if(sql==='COMMIT')return {rows:[]};
    if(sql==='ROLLBACK'){ledger=backup.ledger;outbox=backup.outbox;current.state=backup.state;notes=backup.notes;return {rows:[]};}
    if(sql.startsWith('SELECT * FROM online_orders'))return {rows:args[1]&&args[1]!==current.parent_id?[]:[{...current}]};
    if(sql.startsWith('INSERT INTO payments')){if(ledger.length)throw Error('duplicate');ledger.push(args);return {rows:[]};}
    if(sql.startsWith('INSERT INTO merchant_payouts')){outbox.push(args);return {rows:[]};}
    if(sql.startsWith("UPDATE online_orders SET state='paid'")){current.state='paid';return {rows:[]};}
    if(sql.startsWith('INSERT INTO notifications')){notes++;return {rows:[]};}
    throw Error('Unexpected SQL '+sql);
  };
  const db={query,connect:async()=>({query,release(){}})};
  const routes=new Map(),app={get(path,...f){routes.set('GET '+path,f.at(-1));},post(path,...f){routes.set('POST '+path,f.at(-1));}};
  const service=installPayments({app,db,auth:()=>()=>{},provider:{config,query:async()=>payments},fee:5000});
  return {service,current,get ledger(){return ledger;},get outbox(){return outbox;},get notes(){return notes;},async request(path,body={},parentId=10){const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};await routes.get('POST '+path)({params:{reference:order.reference},body,user:{id:parentId}},res);return res;}};
}
test('verified gross credits only tuition once and atomically queues full-recipient payout',async()=>{
  const f=ledgerFixture();await f.service.reconcile({...order});await f.service.reconcile({...order});
  assert.equal(f.ledger.length,1);assert.equal(f.ledger[0][1],5000);assert.equal(f.outbox.length,1);assert.equal(f.outbox[0][7],5000);assert.equal(f.outbox[0][10],5000);assert.equal(f.notes,1);
});
test('wrong queried gross never credits debt or queues a payout',async()=>{
  const f=ledgerFixture([{...paid,collectedAmount:5000}]);await f.service.reconcile(order);assert.equal(f.ledger.length,0);assert.equal(f.outbox.length,0);assert.equal(f.current.state,'pending');
});
test('other parents cannot reconcile an order; unsigned callbacks cannot credit it',async()=>{
  const f=ledgerFixture();assert.equal((await f.request('/api/online-payments/:reference/check',{},99)).statusCode,404);
  assert.equal((await f.request('/api/clickpesa/webhook',{data:{orderReference:order.reference}})).statusCode,401);assert.equal(f.ledger.length,0);
});
test('missing current quote consent blocks initiation before provider access',async()=>{
  const f=ledgerFixture();const res=await f.request('/api/online-payments/:reference/initiate',{consent:true,quoteToken:'old'});assert.equal(res.statusCode,409);assert.equal(f.current.state,'pending');
});
test('ambiguous payouts are queried and never created again',async()=>{
  let creates=0,queries=0;
  const payout={reference:order.payout_reference,collection_reference:order.reference,client_id:'client',phone:config.CLICKPESA_RECIPIENT_PHONE,recipient_name:config.CLICKPESA_RECIPIENT_NAME,fee_mode:'parent',budget:5100,amount:5000,total:5100,fee:100,expected_received:5000,state:'unknown'};
  const db={query:async sql=>({rows:sql.startsWith('SELECT * FROM merchant_payouts')?[payout]:[]})};
  const provider={ready:true,config,request:async path=>{if(path.includes('create-'))creates++;else queries++;return [];}};
  const worker=startPayoutWorker(db,provider);try{await worker.tick();await worker.tick();assert.equal(creates,0);assert.equal(queries,2);}finally{worker.stop();}
});

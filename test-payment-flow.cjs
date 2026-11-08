const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {createApplication}=require('./server');
const {checksum}=require('./clickpesa');
const {startPayoutWorker}=require('./payouts');

test('HTTP payment flow uses PostgreSQL SQL, credits tuition once, and delivers the full recipient amount',async t=>{
  const pg=new PGlite();
  await pg.exec('SET search_path=autosign,public');
  const db={async query(sql,args=[]){
    if(!args.length && sql.includes(';')) {const results=await pg.exec(sql);return {...results.at(-1),rowCount:results.at(-1)?.affectedRows||0};}
    const r=await pg.query(sql,args);return {...r,rowCount:r.affectedRows||r.rows.length};
  },async connect(){return {query:this.query.bind(this),release(){}};}};
  const config={JWT_SECRET:'integration-test-only',CLICKPESA_CLIENT_ID:'test-client',CLICKPESA_API_KEY:'test-key',CLICKPESA_CHECKSUM_KEY:'test-checksum',CLICKPESA_COLLECTION_ENABLED:'true',CLICKPESA_PAYOUT_ENABLED:'true',CLICKPESA_PAYOUT_FEE_MODE:'parent',CLICKPESA_RECIPIENT_PHONE:'255781234567',CLICKPESA_RECIPIENT_NAME:'TEST RECIPIENT'};
  const instance=createApplication(db,config);
  await instance.initialize();
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await pg.close();});
  const base='http://127.0.0.1:'+server.address().port;
  async function api(path,body,token){const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
  const teacher=(await api('/register',{name:'Teacher',email:'teacher@example.test',password:'testing123',role:'teacher'})).data.token;
  const parent=(await api('/register',{name:'Parent',email:'parent@example.test',password:'testing123',role:'parent'})).data.token;
  const stranger=(await api('/register',{name:'Other',email:'other@example.test',password:'testing123',role:'parent'})).data.token;
  assert.ok(teacher);assert.ok(parent);
  const student=(await api('/students',{name:'Child',school:'School'},teacher)).data;
  assert.equal((await api('/claim-students',{codes:[student.code]},parent)).status,200);
  await api('/sign',{},teacher);await api('/attendance/'+student.id,{status:'present'},teacher);
  await db.query("INSERT INTO student_attendance(student_id,day,status) VALUES($1,CURRENT_DATE-1,'present')",[student.id]);
  await api('/payments',{studentId:student.id,amount:1000},teacher);
  assert.equal((await api('/parent',undefined,parent)).data.students[0].balance,9000);
  let sends=0,payoutSends=0,confirmed=false,orderRef,payoutRef,payoutComplete=false;
  instance.provider.preview=async o=>({sender:{accountNumber:o.phone,accountProvider:'AIRTEL MONEY'},activeMethods:[{name:'AIRTEL-MONEY',status:'AVAILABLE',fee:200}]});
  instance.provider.initiate=async o=>{sends++;return {orderReference:o.reference,clientId:config.CLICKPESA_CLIENT_ID};};
  instance.provider.query=async reference=>confirmed?[{id:'collection-provider-id',paymentReference:'mno-reference',orderReference:reference,status:'SUCCESS',collectedAmount:'9100.00',collectedCurrency:'TZS',clientId:config.CLICKPESA_CLIENT_ID}]:[];
  instance.provider.request=async(path,p)=>{
    if(path.includes('preview-mobile-money-payout'))return {amount:p.amount+100,fee:100,balance:100000,exchanged:false,channelProvider:'AIRTEL MONEY',order:{id:p.orderReference,amount:p.amount,currency:'TZS'},receiver:{accountName:config.CLICKPESA_RECIPIENT_NAME,accountNumber:config.CLICKPESA_RECIPIENT_PHONE,accountCurrency:'TZS',amount:p.amount}};
    if(path.includes('create-mobile-money-payout')){payoutSends++;payoutRef=p.orderReference;assert.equal(p.amount,9000);assert.equal(p.phoneNumber,config.CLICKPESA_RECIPIENT_PHONE);return {status:'AUTHORIZED'};}
    if(path==='/payouts/'+payoutRef)return payoutComplete?[{id:'payout-provider-id',orderReference:payoutRef,clientId:config.CLICKPESA_CLIENT_ID,beneficiary:{accountNumber:config.CLICKPESA_RECIPIENT_PHONE,accountName:config.CLICKPESA_RECIPIENT_NAME},currency:'TZS',channel:'MOBILE MONEY',channelProvider:'AIRTEL MONEY',amount:'9100.00',fee:'100.00',status:'SUCCESS'}]:[];
    throw Error('Unexpected provider path '+path);
  };
  const created=await api('/online-payments',{studentId:student.id,phone:'0712345678',amount:1},parent);
  assert.equal(created.status,200);assert.equal(created.data.order.tuitionAmount,9000);orderRef=created.data.order.reference;
  const quoted=await api('/online-payments/'+orderRef+'/quote',{},parent);
  assert.equal(quoted.status,200);assert.equal(quoted.data.order.amount,9300);assert.equal(quoted.data.order.collectionAmount,9100);assert.equal(quoted.data.order.collectionFee,200);assert.equal(quoted.data.order.payoutFee,100);
  assert.equal((await api('/online-payments/'+orderRef+'/initiate',{consent:true,quoteToken:'stale'},parent)).status,409);assert.equal(sends,0);
  assert.equal((await api('/online-payments/'+orderRef+'/initiate',{consent:true,quoteToken:quoted.data.order.quoteToken},parent)).status,200);assert.equal(sends,1);
  const pending=(await api('/online-payments',undefined,parent)).data.orders[0];
  await api('/online-payments/'+orderRef+'/initiate',{consent:true,quoteToken:pending.quoteToken},parent);assert.equal(sends,1);
  assert.equal((await api('/online-payments/'+orderRef+'/check',{},stranger)).status,404);
  assert.equal((await api('/clickpesa/webhook',{event:'PAYMENT RECEIVED',data:{orderReference:orderRef}})).status,401);
  assert.equal((await api('/parent',undefined,parent)).data.students[0].balance,9000);
  confirmed=true;
  const webhook={event:'PAYMENT RECEIVED',data:{orderReference:orderRef}};webhook.checksum=checksum(webhook,config.CLICKPESA_CHECKSUM_KEY);
  assert.equal((await api('/clickpesa/webhook',webhook)).status,200);
  assert.equal((await api('/clickpesa/webhook',webhook)).status,200);
  assert.equal((await api('/parent',undefined,parent)).data.students[0].balance,0);
  assert.equal((await db.query('SELECT amount FROM payments WHERE online_reference=$1',[orderRef])).rows[0].amount,9000);
  assert.equal((await db.query('SELECT * FROM merchant_payouts WHERE collection_reference=$1',[orderRef])).rows.length,1);
  const worker=startPayoutWorker(db,instance.provider);t.after(()=>worker.stop());
  await worker.tick();await worker.tick();assert.equal(payoutSends,1);
  payoutComplete=true;await worker.tick();assert.equal(payoutSends,1);
  assert.equal((await api('/merchant-payouts',undefined,teacher)).data.payouts[0].state,'paid');
  // Re-running migrations preserves real records even if old migration metadata is absent.
  await db.query('DELETE FROM app_meta');await instance.initialize();
  assert.equal((await api('/parent',undefined,parent)).data.students.length,1);
  for(const path of ['/server.js','/.env','/clickpesa.js']){const r=await fetch(base+path);const text=await r.text();assert.ok(!text.includes(config.CLICKPESA_CHECKSUM_KEY));assert.ok(!text.includes('class ClickPesa'));assert.ok(!text.includes('require('));}
});

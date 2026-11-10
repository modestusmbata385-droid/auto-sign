const crypto = require('node:crypto');
const {phone,verifyWebhook,verifiedPayment} = require('./clickpesa');
const {quoteFees}=require('./fee-quote');
const {enqueue,ready:payoutReady}=require('./payouts');
const schema = `CREATE TABLE IF NOT EXISTS online_orders (
  reference TEXT PRIMARY KEY, student_id INT NOT NULL REFERENCES students(id),
  parent_id INT NOT NULL REFERENCES users(id), amount INT NOT NULL CHECK(amount>0),
  phone TEXT NOT NULL, client_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS tuition_amount INT;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS collection_fee INT;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS payout_fee NUMERIC;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS payout_amount INT;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS payout_total NUMERIC;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS payout_reference TEXT UNIQUE;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS recipient_phone TEXT;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS recipient_name TEXT;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS quoted_at TIMESTAMPTZ;
UPDATE online_orders SET tuition_amount=amount WHERE tuition_amount IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_order_per_student ON online_orders(student_id)
  WHERE state IN ('created','previewing','initiating','pending','unknown');
ALTER TABLE payments ADD COLUMN IF NOT EXISTS online_reference TEXT UNIQUE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_id TEXT UNIQUE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_reference TEXT UNIQUE;`;
const publicOrder = o => ({reference:o.reference,studentId:o.student_id,amount:o.amount+(o.collection_fee||0),collectionAmount:o.amount,tuitionAmount:o.tuition_amount,fees:o.amount+(o.collection_fee||0)-o.tuition_amount,rounding:o.amount-o.tuition_amount-Number(o.payout_fee||0),collectionFee:o.collection_fee,payoutFee:Number(o.payout_fee||0),quoted:!!o.quoted_at,quoteToken:o.quoted_at?new Date(o.quoted_at).toISOString():null,state:o.state,phone:'***'+o.phone.slice(-4)});
const fail = (message,status=400) => Object.assign(Error(message),{status});
function installPayments({app,db,auth,provider,fee}) {
  const rows = async (sql,args=[]) => (await db.query(sql,args)).rows;
  const safe = handler => async (req,res) => { try { await handler(req,res); } catch(e) { res.status(e.status || 500).json({error:e.status ? e.message : 'Imeshindikana kushughulikia malipo. Hakiki hali tena.'}); } };
  async function owned(reference,parentId) {
    const order = (await rows('SELECT * FROM online_orders WHERE reference=$1 AND parent_id=$2',[reference,parentId]))[0];
    if (!order) throw fail('Ombi halijapatikana.',404); return order;
  }
  async function reconcile(order) {
    if (order.state === 'paid') return order;
    if (order.client_id !== provider.config.CLICKPESA_CLIENT_ID) throw fail('Programu ya ClickPesa imebadilika; wasiliana na msimamizi.',409);
    const payments = await provider.query(order.reference);
    const payment = verifiedPayment(payments,order,order.client_id);
    if (!payment) return (await rows('SELECT * FROM online_orders WHERE reference=$1',[order.reference]))[0];
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query('SELECT * FROM online_orders WHERE reference=$1 FOR UPDATE',[order.reference])).rows[0];
      if (locked.state !== 'paid') {
        // Unique order and provider references plus this transaction prevent double credit.
        await client.query('INSERT INTO payments(student_id,amount,note,online_reference,provider_id,provider_reference) VALUES($1,$2,$3,$4,$5,$6)',[locked.student_id,locked.tuition_amount,'ClickPesa',locked.reference,payment.id,payment.paymentReference]);
        await enqueue(client,locked,provider.config);
        await client.query("UPDATE online_orders SET state='paid',updated_at=NOW() WHERE reference=$1",[locked.reference]);
        await client.query('INSERT INTO notifications(parent_id,message) SELECT parent_id,$2 FROM parent_student_access WHERE student_id=$1',[locked.student_id,'Malipo ya TSh '+locked.tuition_amount.toLocaleString()+' yamethibitishwa. Kumbukumbu: '+locked.reference]);
      }
      await client.query('COMMIT'); return {...locked,state:'paid'};
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  app.get('/api/online-payments',auth('parent'),safe(async(req,res) => {
    const orders = await rows("SELECT * FROM online_orders WHERE parent_id=$1 ORDER BY (state NOT IN ('paid','cancelled')) DESC,created_at DESC LIMIT 200",[req.user.id]);
    res.json({enabled:provider.ready&&payoutReady(provider.config),orders:orders.map(publicOrder)});
  }));
  app.get('/api/merchant-payouts',auth('teacher'),safe(async(req,res)=>{
    const payouts=await rows('SELECT p.reference,p.collection_reference,p.expected_received,p.fee,p.state,p.reason FROM merchant_payouts p JOIN online_orders o ON o.reference=p.collection_reference JOIN students s ON s.id=o.student_id WHERE s.teacher_id=$1 ORDER BY p.updated_at DESC LIMIT 30',[req.user.id]);
    res.json({enabled:provider.ready&&payoutReady(provider.config),payouts});
  }));
  app.post('/api/online-payments',auth('parent'),safe(async(req,res) => {
    if (!provider.ready || !payoutReady(provider.config)) throw fail('Malipo ya ClickPesa bado hayajawezeshwa.',503);
    const studentId = Number(req.body.studentId), payerPhone = phone(req.body.phone);
    if (!Number.isSafeInteger(studentId) || studentId <= 0) throw fail('Chagua mtoto.');
    const client = await db.connect(); let order;
    try {
      await client.query('BEGIN');
      const child = (await client.query('SELECT s.id FROM students s JOIN parent_student_access x ON x.student_id=s.id WHERE s.id=$1 AND x.parent_id=$2 FOR UPDATE OF s',[studentId,req.user.id])).rows[0];
      if (!child) throw fail('Mtoto hajapatikana kwenye akaunti yako.',404);
      order = (await client.query("SELECT * FROM online_orders WHERE student_id=$1 AND state IN ('created','previewing','initiating','pending','unknown')",[studentId])).rows[0];
      if (order && order.parent_id !== req.user.id) throw fail('Kuna ombi la malipo linalosubiri kwa mtoto huyu. Wasiliana na mzazi aliyelituma.',409);
      if (!order) {
        const totals = (await client.query("SELECT (SELECT COUNT(*) FROM student_attendance WHERE student_id=$1 AND status='present')::int AS days,COALESCE((SELECT SUM(amount) FROM payments WHERE student_id=$1),0)::int AS paid",[studentId])).rows[0];
        const amount = totals.days * fee - totals.paid;
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) throw fail('Hakuna deni linaloweza kulipwa sasa.');
        order = (await client.query('INSERT INTO online_orders(reference,student_id,parent_id,amount,phone,client_id,tuition_amount,payout_reference) VALUES($1,$2,$3,$4,$5,$6,$4,$7) RETURNING *',['AS'+crypto.randomBytes(9).toString('hex').toUpperCase(),studentId,req.user.id,amount,payerPhone,provider.config.CLICKPESA_CLIENT_ID,'AP'+crypto.randomBytes(9).toString('hex').toUpperCase()])).rows[0];
      }
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.json({order:publicOrder(order)});
  }));
  async function saveQuote(order) {
    const quote=await quoteFees(provider,order);
    return (await rows('UPDATE online_orders SET amount=$2,collection_fee=$3,payout_fee=$4,payout_amount=$5,payout_total=$6,recipient_phone=$7,recipient_name=$8,quoted_at=NOW(),updated_at=NOW() WHERE reference=$1 RETURNING *',[order.reference,quote.amount,quote.collectionFee,quote.payoutFee,quote.payoutAmount,quote.payoutTotal,quote.recipient,quote.recipientName]))[0];
  }
  app.post('/api/online-payments/:reference/quote',auth('parent'),safe(async(req,res)=>{
    const order=await owned(req.params.reference,req.user.id);
    const claimed=await rows("UPDATE online_orders SET state='previewing',updated_at=NOW() WHERE reference=$1 AND state='created' RETURNING *",[order.reference]);
    if(!claimed.length) throw fail('Ombi linaendelea. Hakiki hali yake.',409);
    try { const quoted=await saveQuote(order); res.json({order:publicOrder({...quoted,state:'created'})}); }
    catch(e) { console.error('QUOTE_FAILED',e.message,e.providerStatus||''); throw fail('Ada halisi hazijapatikana. Jaribu tena au wasiliana na msimamizi.',502); }
    finally { await rows("UPDATE online_orders SET state='created' WHERE reference=$1 AND state='previewing'",[order.reference]); }
  }));
  app.post('/api/online-payments/:reference/initiate',auth('parent'),safe(async(req,res) => {
    let order = await owned(req.params.reference,req.user.id);
    if (!order.quoted_at || req.body.quoteToken!==new Date(order.quoted_at).toISOString()) throw fail('Hakiki ada na jumla kwanza.',409);
    if (req.body.consent !== true) throw fail('Thibitisha kiasi na simu kabla ya kutuma ombi.');
    const claimed = (await rows("UPDATE online_orders SET state='previewing',updated_at=NOW() WHERE reference=$1 AND state='created' RETURNING *",[order.reference]))[0];
    if (!claimed) return res.json({order:publicOrder(await owned(order.reference,req.user.id))});
    try {
      const previous=order;
      order=await saveQuote(order);
      if(['amount','collection_fee','payout_fee','payout_amount','payout_total','recipient_phone','recipient_name'].some(k=>String(previous[k])!==String(order[k]))) throw fail('Ada zimebadilika. Hakiki jumla mpya na uthibitishe tena.',409);
    } catch(e) { await rows("UPDATE online_orders SET state='created',updated_at=NOW() WHERE reference=$1 AND state='previewing'",[order.reference]); throw e; }
    // Persist before initiation. A timeout/crash must never cause a second push.
    await rows("UPDATE online_orders SET state='initiating',updated_at=NOW() WHERE reference=$1",[order.reference]);
    let state = 'unknown';
    try {
      const response = await provider.initiate(order);
      if (response.orderReference === order.reference && response.clientId === order.client_id) state = 'pending';
    } catch { /* Query this reference to resolve ambiguous initiation. */ }
    await rows("UPDATE online_orders SET state=$2,updated_at=NOW() WHERE reference=$1 AND state='initiating'",[order.reference,state]);
    res.json({order:publicOrder(await owned(order.reference,req.user.id))});
  }));
  app.post('/api/online-payments/:reference/check',auth('parent'),safe(async(req,res) => {
    const order = await owned(req.params.reference,req.user.id);
    res.json({order:publicOrder(await reconcile(order))});
  }));
  app.post('/api/online-payments/:reference/cancel',auth('parent'),safe(async(req,res) => {
    await owned(req.params.reference,req.user.id);
    const cancelled = await rows("UPDATE online_orders SET state='cancelled',updated_at=NOW() WHERE reference=$1 AND state='created' RETURNING *",[req.params.reference]);
    if (!cancelled.length) throw fail('Ombi lililotumwa haliwezi kufutwa hapa. Hakiki hali yake.',409);
    res.json({ok:true});
  }));
  app.post('/api/clickpesa/webhook',safe(async(req,res) => {
    if (!verifyWebhook(req.body,provider.config.CLICKPESA_CHECKSUM_KEY)) throw fail('Invalid signature',401);
    const ref = req.body.data?.orderReference;
    if (typeof ref !== 'string') throw fail('Missing reference');
    const order = (await rows('SELECT * FROM online_orders WHERE reference=$1',[ref]))[0];
    if (order) await reconcile(order);
    res.json({ok:true});
  }));
  return {reconcile};
}
module.exports = {schema,installPayments,publicOrder};

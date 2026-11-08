const crypto = require('node:crypto');
const {phone} = require('./clickpesa');
const schema = `CREATE TABLE IF NOT EXISTS merchant_payouts (
  reference TEXT PRIMARY KEY, collection_reference TEXT NOT NULL UNIQUE REFERENCES online_orders(reference),
  budget INT NOT NULL, phone TEXT NOT NULL, recipient_name TEXT NOT NULL, client_id TEXT NOT NULL,
  fee_mode TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', amount INT, total NUMERIC, fee NUMERIC,
  expected_received INT NOT NULL, provider_id TEXT UNIQUE, reason TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;
const number = v => /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(v)) ? Number(v) : NaN;
const name = v => String(v||'').trim().replace(/\s+/g,' ').toUpperCase();
function ready(config) {
  return config.CLICKPESA_PAYOUT_ENABLED === 'true' && !!config.CLICKPESA_RECIPIENT_PHONE && !!config.CLICKPESA_RECIPIENT_NAME && config.CLICKPESA_PAYOUT_FEE_MODE === 'parent';
}
function quoteValid(quote, order, amount, maxFee) {
  const total=number(quote?.amount), fee=number(quote?.fee), received=number(quote?.receiver?.amount);
  return quote?.order?.id === order.reference && number(quote.order.amount) === amount && quote.order.currency === 'TZS' && quote.exchanged === false && quote.receiver?.accountNumber === order.phone && name(quote.receiver.accountName) === name(order.recipient_name) && quote.receiver.accountCurrency === 'TZS' && /^AIRTEL(?:\s|$)/i.test(quote.channelProvider||'') && Number.isFinite(total) && total > 0 && Number.isFinite(fee) && fee <= maxFee && received > 0 && received <= amount && Math.abs(total-received-fee)<0.011;
}
async function enqueue(client,order,config) {
  if (!ready(config)) return;
  if (!order.quoted_at || !order.payout_reference || !order.payout_amount || !order.payout_total) throw Error('Payout quote required');
  await client.query('INSERT INTO merchant_payouts(reference,collection_reference,budget,phone,recipient_name,client_id,fee_mode,amount,total,fee,expected_received) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(collection_reference) DO NOTHING',[order.payout_reference,order.reference,Math.ceil(Number(order.payout_total)),order.recipient_phone,name(order.recipient_name),order.client_id,'parent',order.payout_amount,order.payout_total,order.payout_fee,order.tuition_amount]);
}
function startPayoutWorker(db,provider) {
  let busy=false;
  const rows=async(sql,args=[]) => (await db.query(sql,args)).rows;
  async function tick() {
    if (busy || !provider.ready || !ready(provider.config)) return;
    busy=true;
    try {
      // Backfill collections confirmed while payout configuration was unavailable.
      const paid=await rows("SELECT o.* FROM online_orders o LEFT JOIN merchant_payouts p ON p.collection_reference=o.reference WHERE o.state='paid' AND p.reference IS NULL AND o.client_id=$1 LIMIT 20",[provider.config.CLICKPESA_CLIENT_ID]);
      for (const o of paid) await enqueue(db,o,provider.config);
      // Recover preview crashes only. Initiating/unknown are queried, never resent.
      await rows("UPDATE merchant_payouts SET state='queued' WHERE state='previewing' AND updated_at < NOW()-INTERVAL '5 minutes'");
      const orders=await rows("SELECT * FROM merchant_payouts WHERE state IN ('queued','initiating','pending','unknown') AND client_id=$1 ORDER BY updated_at LIMIT 20",[provider.config.CLICKPESA_CLIENT_ID]);
      for (const order of orders) {
        try {
          if (order.state !== 'queued') {
            let results;
            try { results=await provider.request('/payouts/'+order.reference); } catch(e) { if(e.providerStatus===404) continue; throw e; }
            if (!Array.isArray(results)) continue;
            const p=results.find(p => p.orderReference===order.reference && p.clientId===order.client_id && p.beneficiary?.accountNumber===order.phone && name(p.beneficiary.accountName)===name(order.recipient_name) && p.currency==='TZS' && p.channel==='MOBILE MONEY' && /^AIRTEL(?:\s|$)/i.test(p.channelProvider||'') && number(p.amount)===Number(order.total) && number(p.fee)===Number(order.fee) && typeof p.id==='string' && p.id.length>0);
            if (!p) continue;
            const state=p.status==='SUCCESS'?'paid':['FAILED','REVERSED','REFUNDED'].includes(p.status)?'failed':'pending';
            await rows('UPDATE merchant_payouts SET state=$2,provider_id=$3,updated_at=NOW() WHERE reference=$1',[order.reference,state,p.id]);
            continue;
          }
          if (order.phone !== phone(provider.config.CLICKPESA_RECIPIENT_PHONE) || name(order.recipient_name)!==name(provider.config.CLICKPESA_RECIPIENT_NAME) || order.fee_mode!==provider.config.CLICKPESA_PAYOUT_FEE_MODE) {
            await rows("UPDATE merchant_payouts SET state='held',reason='RECIPIENT_CONFIG_CHANGED' WHERE reference=$1",[order.reference]); continue;
          }
          const claimed=await rows("UPDATE merchant_payouts SET state='previewing',updated_at=NOW() WHERE reference=$1 AND state='queued' RETURNING *",[order.reference]);
          if (!claimed.length) continue;
          const amount=order.amount;
          const quote=await provider.request('/payouts/preview-mobile-money-payout',{amount,currency:'TZS',phoneNumber:order.phone,orderReference:order.reference});
          if(!quoteValid(quote,order,amount,Number(order.fee)) || number(quote.amount)!==Number(order.total) || number(quote.fee)!==Number(order.fee) || number(quote.receiver.amount)!==order.expected_received) {
            await rows("UPDATE merchant_payouts SET state='held',reason='ACCEPTED_FEES_CHANGED',updated_at=NOW() WHERE reference=$1 AND state='previewing'",[order.reference]); continue;
          }
          // Persist destination, fee and one-shot claim before any money movement.
          const send=await rows("UPDATE merchant_payouts SET state='initiating',amount=$2,total=$3,fee=$4,updated_at=NOW() WHERE reference=$1 AND state='previewing' RETURNING *",[order.reference,amount,number(quote.amount),number(quote.fee)]);
          if(!send.length) continue;
          try {
            await provider.request('/payouts/create-mobile-money-payout',{amount,currency:'TZS',phoneNumber:order.phone,orderReference:order.reference});
            await rows("UPDATE merchant_payouts SET state='pending',updated_at=NOW() WHERE reference=$1 AND state='initiating'",[order.reference]);
          } catch {
            await rows("UPDATE merchant_payouts SET state='unknown',reason='QUERY_REQUIRED',updated_at=NOW() WHERE reference=$1 AND state='initiating'",[order.reference]);
          }
        } catch {
          // Safe preview failures retry later. Never retry payout creation.
          await rows("UPDATE merchant_payouts SET state='queued',reason='PREVIEW_UNAVAILABLE_OR_MISMATCH',updated_at=NOW() WHERE reference=$1 AND state='previewing'",[order.reference]);
        }
      }
    } catch { console.error('ClickPesa payout reconciliation unavailable'); }
    finally { busy=false; }
  }
  const timer=setInterval(tick,60000); timer.unref();
  return {tick,stop:()=>clearInterval(timer)};
}
module.exports={schema,ready,quoteValid,enqueue,startPayoutWorker};

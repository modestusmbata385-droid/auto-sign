const {phone} = require('./clickpesa');
const {quoteValid} = require('./payouts');
const network = value => {
  const s=String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if (/AIRTEL/.test(s)) return 'AIRTEL';
  if (/TIGO|MIXX|YAS/.test(s)) return 'MIXX';
  if (/MPESA|VODACOM/.test(s)) return 'MPESA';
  if (/HALO/.test(s)) return 'HALO';
  return s;
};
async function quoteFees(provider, order) {
  const config=provider.config, recipient=phone(config.CLICKPESA_RECIPIENT_PHONE);
  const payout={reference:order.payout_reference,phone:recipient,recipient_name:config.CLICKPESA_RECIPIENT_NAME};
  let payoutAmount=order.tuition_amount, payoutQuote;
  for(let i=0;i<6;i++) {
    payoutQuote=await provider.request('/payouts/preview-mobile-money-payout',{amount:payoutAmount,currency:'TZS',phoneNumber:recipient,orderReference:payout.reference});
    if(!quoteValid(payoutQuote,payout,payoutAmount,Infinity)) throw Error('Payout quote mismatch: name='+payoutQuote?.receiver?.accountName+' number_last4='+String(payoutQuote?.receiver?.accountNumber||'').slice(-4)+' provider='+payoutQuote?.channelProvider+' currency='+payoutQuote?.receiver?.accountCurrency+' exchanged='+payoutQuote?.exchanged);
    const received=Number(payoutQuote.receiver.amount);
    if(received===order.tuition_amount) break;
    payoutAmount+=Math.ceil(order.tuition_amount-received);
  }
  if(Number(payoutQuote.receiver.amount)!==order.tuition_amount) throw Error('Cannot quote full recipient amount');
  const payoutTotal=Number(payoutQuote.amount);
  // ClickPesa charges its collection fee to the payer on top of this API amount.
  // Include it in the displayed total, never add it to the API amount a second time.
  const amount=Math.ceil(payoutTotal);
  const preview=await provider.preview({...order,amount},true);
  if(phone(preview.sender?.accountNumber)!==order.phone) throw Error('Sender mismatch');
  const method=preview.activeMethods?.find(m=>m.status==='AVAILABLE' && network(m.name)===network(preview.sender?.accountProvider));
  if(!method || !Number.isSafeInteger(method.fee) || method.fee<0) throw Error('Collection fee unavailable');
  const collectionFee=method.fee;
  if(!Number.isSafeInteger(amount) || amount+collectionFee>100000000 || amount<order.tuition_amount) throw Error('Fee quote unavailable');
  return {amount,chargeTotal:amount+collectionFee,collectionFee,payoutFee:Number(payoutQuote.fee),payoutAmount,payoutTotal,recipient,recipientName:config.CLICKPESA_RECIPIENT_NAME};
}
module.exports={quoteFees,network};

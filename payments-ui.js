let paymentTimer;
function stopPaymentPolling() { clearTimeout(paymentTimer); }
async function showTeacher() {
  teacher(await api('/teacher'));
  const section=document.createElement('section');section.className='card';
  const title=document.createElement('h2');title.textContent='Uhamisho wa makusanyo';section.append(title);
  document.querySelector('#app').append(section);
  try {
    const data=await api('/merchant-payouts');
    const labels={queued:'Inasubiri kutumwa',previewing:'Inahakikiwa',initiating:'Inatumwa',pending:'Inasubiri uthibitisho',unknown:'Inahitaji uhakiki',held:'Imesimamishwa; inahitaji ukaguzi',failed:'Haijakamilika; inahitaji ukaguzi',paid:'Imefika kwa mpokeaji'};
    if(!data.payouts.length){const p=document.createElement('p');p.textContent=data.enabled?'Hakuna uhamisho bado.':'Malipo na uhamisho wa ClickPesa bado havijawashwa.';section.append(p);}
    for(const payout of data.payouts){const p=document.createElement('p');p.textContent=payout.reference+' · '+money(payout.expected_received)+' · '+(labels[payout.state]||payout.state);section.append(p);}
  }catch{const p=document.createElement('p');p.textContent='Hali ya uhamisho haijapatikana. Pakia ukurasa tena.';section.append(p);}
}
async function showParent() {
  const data = await api('/parent');
  parent(data);
  await setupParentPayments();
}
async function setupParentPayments() {
  stopPaymentPolling();
  const hosts = [...document.querySelectorAll('.online-payment')];
  let result;
  try { result = await api('/online-payments'); }
  catch { hosts.forEach(h => { h.textContent = 'Hali ya malipo haijapatikana. Pakia ukurasa tena.'; }); return; }
  const statusLabels = {created:'Ombi limeandaliwa',previewing:'Inahakiki njia ya malipo',initiating:'Inatuma ombi',pending:'Inasubiri uthibitisho',unknown:'Hali haijathibitishwa',paid:'Malipo yamethibitishwa',cancelled:'Ombi limefutwa'};
  const element = (tag,text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  for (const host of hosts) {
    const studentId = Number(host.dataset.student);
    const order = result.orders.find(o => o.studentId === studentId && !['paid','cancelled'].includes(o.state));
    host.replaceChildren(element('h3','Lipa kwa ClickPesa'));
    const message = element('p'); message.setAttribute('role','status'); message.setAttribute('aria-live','polite');
    if (order) {
      host.append(element('p',statusLabels[order.state]+' · Simu '+order.phone),element('small','Kumbukumbu: '+order.reference));
      if(order.quoted) {
        host.append(element('p','Deni: '+money(order.tuitionAmount)),element('p','Ada ya kulipa ClickPesa: '+money(order.collectionFee)),element('p','Ada ya kuhamisha kwenda kwa mpokeaji: '+money(order.payoutFee)),element('strong','Jumla ya kulipa: '+money(order.amount)));
      }
      if(order.quoted && order.rounding>0) host.append(element('p','Kuzungusha hadi shilingi kamili: '+money(order.rounding)));
      if (order.state === 'created' && !order.quoted) {
        const quoteButton=element('button','Hakiki ada na jumla');
        quoteButton.onclick=async()=>{quoteButton.disabled=true;try{await api('/online-payments/'+order.reference+'/quote',{method:'POST'});await setupParentPayments();}catch(e){message.textContent=e.message;quoteButton.disabled=false;}};
        host.append(quoteButton);
      }
      if (order.state === 'created') {
        const send = element('button','Lipa jumla ya '+money(order.amount)); send.type = 'button'; send.disabled=!order.quoted;
        send.onclick = async () => {
          if (!confirm('Unakubali kulipa '+money(order.amount)+' kupitia simu '+order.phone+'? Jumla hii inajumuisha deni na ada zote mbili.')) return;
          send.disabled = true;
          try {
            const r = await api('/online-payments/'+order.reference+'/initiate',{method:'POST',body:JSON.stringify({consent:true,quoteToken:order.quoteToken})});
            await setupParentPayments();
            if (r.order.state !== 'paid') alert('Fuata maelekezo kwenye simu yako. Weka PIN kwenye simu pekee. Bonyeza Hakiki malipo baada ya kulipa.');
          } catch(e) { await setupParentPayments(); alert(e.message); }
        };
        const cancel = element('button','Badili simu / futa ombi'); cancel.className = 'alt'; cancel.type = 'button';
        cancel.onclick = async () => { cancel.disabled=true; try { await api('/online-payments/'+order.reference+'/cancel',{method:'POST'}); await setupParentPayments(); } catch(e) { message.textContent=e.message; cancel.disabled=false; } };
        host.append(send,cancel);
      } else host.append(element('p','Kama ombi limefika, thibitisha kwenye simu yako. Hakiki ombi hili kabla ya kujaribu malipo mengine.'));
      const check = element('button','Hakiki malipo'); check.type='button'; check.className='alt';
      check.onclick = async () => {
        check.disabled = true;
        try { const r = await api('/online-payments/'+order.reference+'/check',{method:'POST'}); if (r.order.state === 'paid') { await showParent(); } else message.textContent='Malipo bado hayajathibitishwa. Kumbukumbu: '+order.reference; }
        catch(e) { message.textContent=e.message; } finally { check.disabled=false; }
      };
      host.append(check);
    } else if (Number(host.dataset.balance) > 0 && result.enabled) {
      const form = element('form'), label = element('label','Namba ya simu ya mzazi anayelipa'), input = element('input');
      input.type='tel'; input.inputMode='tel'; input.autocomplete='tel'; input.placeholder='07XXXXXXXX'; input.required=true; input.id='payer-'+studentId; label.htmlFor=input.id;
      const button = element('button','Andaa malipo ya '+money(host.dataset.balance));
      form.append(label,input,element('p','Deni linahesabiwa kwa siku mtoto alizoandikwa Present, ukitoa malipo yaliyopokelewa.'),button);
      form.onsubmit = async e => {
        e.preventDefault(); button.disabled=true;
        try { const r=await api('/online-payments',{method:'POST',body:JSON.stringify({studentId,phone:input.value})}); await api('/online-payments/'+r.order.reference+'/quote',{method:'POST'}); await setupParentPayments(); }
        catch(e) { await setupParentPayments(); alert(e.message); }
      };
      host.append(form);
    } else host.append(element('p',Number(host.dataset.balance)<=0 ? 'Hakuna deni la kulipa.' : 'Malipo ya ClickPesa bado hayajawezeshwa.'));
    const paid = result.orders.filter(o => o.studentId === studentId && o.state === 'paid').slice(0,5);
    for (const item of paid) host.append(element('p','Imelipwa: '+money(item.amount)+' · '+item.reference));
    host.append(message);
  }
  // Poll only while the parent page is open; signed webhooks handle closed pages.
  if (result.enabled && result.orders.some(o => ['initiating','pending','unknown'].includes(o.state))) {
    paymentTimer = setTimeout(async () => {
      if (!token || user?.role !== 'parent' || !document.querySelector('.online-payment')) return;
      let changed=false;
      for (const order of result.orders.filter(o => ['initiating','pending','unknown'].includes(o.state))) {
        try { const r=await api('/online-payments/'+order.reference+'/check',{method:'POST'}); if (r.order.state==='paid') changed=true; } catch { /* Manual check remains available. */ }
      }
      if (changed) await showParent(); else await setupParentPayments();
    },30000);
  }
}

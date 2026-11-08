const crypto = require('node:crypto');
const base = 'https://api.clickpesa.com/third-parties';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function checksum(payload, key) {
  const {checksum, checksumMethod, ...body} = payload;
  return crypto.createHmac('sha256', key).update(JSON.stringify(canonical(body))).digest('hex');
}
function verifyWebhook(payload, key) {
  if (!key || !payload || (payload.checksumMethod !== undefined && payload.checksumMethod !== 'canonical') || !/^[a-f0-9]{64}$/i.test(payload.checksum || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(payload.checksum, 'hex'), Buffer.from(checksum(payload, key), 'hex'));
}
function phone(value) {
  const result = String(value || '').replace(/[\s()-]/g, '').replace(/^\+/, '').replace(/^0(?=[67]\d{8}$)/, '255');
  if (!/^255[67]\d{8}$/.test(result)) throw Object.assign(Error('Weka namba sahihi ya simu ya Tanzania.'), {status:400});
  return result;
}
function verifiedPayment(payments, order, clientId) {
  if (!Array.isArray(payments)) return null;
  return payments.find(p => p && p.orderReference === order.reference && p.clientId === clientId && ['SUCCESS','SETTLED'].includes(p.status) && p.collectedCurrency === 'TZS' && /^\d+(?:\.0+)?$/.test(String(p.collectedAmount)) && Number(p.collectedAmount) === order.amount && typeof p.id === 'string' && p.id.length > 0 && typeof p.paymentReference === 'string' && p.paymentReference.length > 0) || null;
}
class ClickPesa {
  constructor(config = process.env, transport = fetch) { this.config = config; this.transport = transport; }
  get ready() { return this.config.CLICKPESA_COLLECTION_ENABLED === 'true' && !!(this.config.CLICKPESA_CLIENT_ID && this.config.CLICKPESA_API_KEY && this.config.CLICKPESA_CHECKSUM_KEY); }
  async response(path, options) {
    let r;
    try { r = await this.transport.call(globalThis, base + path, {...options, redirect:'manual', signal:AbortSignal.timeout(15000)}); }
    catch { throw Object.assign(Error('ClickPesa haijapatikana. Hakiki hali ya ombi kabla ya kujaribu tena.'), {status:502}); }
    if (!r.ok) {
      let retryAfter=Number(r.headers?.get('Retry-After'));
      if(r.status===429){try{const failure=await r.json();const seconds=Number(failure.fields?.retryAfterSeconds);if(Number.isFinite(seconds)&&seconds>0)retryAfter=seconds;}catch{}}
      throw Object.assign(Error(r.status === 429 ? 'ClickPesa ina maombi mengi. Subiri kisha hakiki hali.' : 'ClickPesa haijakubali ombi. Hakiki hali au wasiliana na msimamizi.'), {status:r.status === 429 ? 429 : 502, providerStatus:r.status,retryAfter:Number.isFinite(retryAfter)&&retryAfter>0?Math.min(retryAfter,86400):undefined});
    }
    try { return await r.json(); } catch { throw Object.assign(Error('Jibu la ClickPesa halijatambulika.'), {status:502}); }
  }
  async authorize() {
    if (!this.ready) throw Object.assign(Error('Malipo ya mtandaoni bado hayajawezeshwa.'), {status:503});
    if (this.token && this.expires > Date.now()) return this.token;
    if (this.retryAt > Date.now()) throw Object.assign(Error('Subiri kidogo kabla ya kuhakiki tena.'), {status:429});
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const r = await this.response('/generate-token', {method:'POST', headers:{'client-id':this.config.CLICKPESA_CLIENT_ID,'api-key':this.config.CLICKPESA_API_KEY,'Content-Type':'application/json'},body:'{}'});
        if (r.success !== true || typeof r.token !== 'string' || !/^Bearer\s+\S+$/i.test(r.token)) throw Error('Uthibitishaji wa ClickPesa haujakamilika.');
        this.token = r.token; this.expires = Date.now() + 59*60000; return this.token;
      } catch (e) { this.retryAt = Date.now() + (e.retryAfter||180)*1000; throw e; }
    })();
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }
  async request(path, payload) {
    const token = await this.authorize();
    try { return await this.response(path, {method:payload ? 'POST' : 'GET', headers:{Authorization:token,'Content-Type':'application/json'}, body:payload ? JSON.stringify({...payload,checksum:checksum(payload,this.config.CLICKPESA_CHECKSUM_KEY)}) : undefined}); }
    catch (e) { if ([401,403].includes(e.providerStatus)) { this.token = null; this.retryAt = Date.now()+180000; } throw e; }
  }
  payload(order) { return {amount:String(order.amount),currency:'TZS',orderReference:order.reference,phoneNumber:order.phone}; }
  preview(order, fetchSenderDetails=false) { return this.request('/payments/preview-ussd-push-request', {...this.payload(order),fetchSenderDetails}); }
  initiate(order) { return this.request('/payments/initiate-ussd-push-request', this.payload(order)); }
  async query(reference) {
    if (!/^AS[A-F0-9]{18}$/.test(reference)) throw Error('Invalid reference');
    try { const result = await this.request('/payments/' + reference); if (!Array.isArray(result)) throw Error('Invalid provider response'); return result; }
    catch (e) { if (e.providerStatus === 404) return []; throw e; }
  }
}
module.exports = {ClickPesa,checksum,verifyWebhook,phone,verifiedPayment};

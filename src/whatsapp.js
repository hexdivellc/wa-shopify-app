const axios = require('axios');

function cleanPhone(phone) {
  let p = String(phone).replace(/[\s\-\+\(\)]/g, '');
  if (p.startsWith('0')) p = '94' + p.slice(1);
  if (p.length === 9) p = '94' + p;
  return p;
}

async function sendMessage(phone, text, shop) {
  if (!phone || !text) return;
  const p = cleanPhone(phone);
  const watiEndpoint = (shop && shop.wati_endpoint) || process.env.WATI_ENDPOINT;
  const watiToken    = (shop && shop.wati_token)    || process.env.WATI_TOKEN;

  if (watiEndpoint && watiToken) {
    try {
      await axios.post(`${watiEndpoint}/api/v1/sendSessionMessage/${p}`, { messageText: text }, { headers: { Authorization: `Bearer ${watiToken}`, 'Content-Type': 'application/json' } });
      console.log(`WATI sent to ${p}`);
      return;
    } catch(e) { console.error('WATI error:', e.response?.data?.message || e.message); return; }
  }

  const token   = (shop && shop.wa_token)    || process.env.WA_TOKEN;
  const phoneId = (shop && shop.wa_phone_id) || process.env.WA_PHONE_ID;
  if (!token || !phoneId) { console.warn('No WA credentials'); return; }
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${phoneId}/messages`, { messaging_product: 'whatsapp', to: p, type: 'text', text: { body: text } }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    console.log(`Meta WA sent to ${p}`);
  } catch(e) { console.error('Meta WA error:', e.response?.data || e.message); }
}

module.exports = { sendMessage, cleanPhone };

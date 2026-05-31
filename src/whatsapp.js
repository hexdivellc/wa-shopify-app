const axios = require('axios');

async function sendMessage(phone, text, shop = null) {
  const token   = (shop && shop.wa_token)    || process.env.WA_TOKEN;
  const phoneId = (shop && shop.wa_phone_id) || process.env.WA_PHONE_ID;
  if (!token || !phoneId) { console.warn('⚠️ No WA credentials'); return; }
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      messaging_product: 'whatsapp',
      to: String(phone).replace(/[\s\-\+]/g, ''),
      type: 'text',
      text: { body: text },
    }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    console.log(`✅ WA sent to ${phone}`);
  } catch(e) { console.error('❌ WA send error:', e.response?.data || e.message); }
}

module.exports = { sendMessage };

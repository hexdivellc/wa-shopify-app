const axios = require('axios');

// ── Send message — supports both WATI and Meta Cloud API ──────────────────────
async function sendMessage(phone, text, shop) {
  if (!phone || !text) return;

  // Clean phone number
  const cleanPhone = String(phone).replace(/[\s\-\+\(\)]/g, '');

  // ── WATI format ───────────────────────────────────────────────────────────────
  const watiEndpoint = (shop && shop.wati_endpoint) || process.env.WATI_ENDPOINT;
  const watiToken    = (shop && shop.wati_token)    || process.env.WATI_TOKEN;

  if (watiEndpoint && watiToken) {
    try {
      await axios.post(
        `${watiEndpoint}/api/v1/sendSessionMessage/${cleanPhone}`,
        { messageText: text },
        { headers: { Authorization: `Bearer ${watiToken}`, 'Content-Type': 'application/json' } }
      );
      console.log(`✅ WATI sent to ${cleanPhone}`);
      return;
    } catch(e) {
      console.error('❌ WATI send error:', e.response?.data || e.message);
      return;
    }
  }

  // ── Meta Cloud API fallback ───────────────────────────────────────────────────
  const token   = (shop && shop.wa_token)    || process.env.WA_TOKEN;
  const phoneId = (shop && shop.wa_phone_id) || process.env.WA_PHONE_ID;

  if (!token || !phoneId) {
    console.warn('⚠️ No WA credentials (WATI or Meta) configured');
    return;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      { messaging_product: 'whatsapp', to: cleanPhone, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Meta WA sent to ${cleanPhone}`);
  } catch(e) {
    console.error('❌ Meta WA send error:', e.response?.data || e.message);
  }
}

module.exports = { sendMessage };

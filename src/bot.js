const { sendMessage } = require('./whatsapp');
const { getAIReply, isTracking, getShopifyTracking } = require('./ai/provider');
const db = require('./db/database');
const { handleOrderFlow } = require('./orders/flow');

const confusionCounts = {};

const KEYWORDS = {
  help:     n => `Hi ${n}! Reply:\n• *ORDER* to place an order\n• *TRACK* to track your order\n• *RETURN* for returns\n• *COD* for cash on delivery info`,
  return:   n => `Hi ${n}! Please share your order number and reason. Our team will get back to you within 24 hours.`,
  refund:   n => `Hi ${n}! Share your order number and we'll process your refund within 3-5 working days.`,
  cod:      n => `Hi ${n}! Yes, we offer Cash on Delivery island-wide. No upfront payment needed.`,
  delivery: n => `Hi ${n}! We deliver island-wide in 2-5 working days via Trans Express.`,
};

async function handleIncomingMessage(shopDomain, message, contact, shop) {
  const phone = message.from;
  const text  = (message.text?.body || '').trim();
  const name  = contact?.profile?.name || 'there';
  if (!text) return;

  console.log(`[${shopDomain}] ${phone}: "${text.substring(0,60)}"`);
  db.upsertContact(shopDomain, phone, name);
  db.saveMessage(shopDomain, { phone, direction: 'inbound', text });

  const contactRow = db.getContact(shopDomain, phone);
  const aiEnabled  = contactRow?.ai_enabled !== 0;
  const aiSettings = db.db.prepare('SELECT * FROM ai_settings WHERE shop_domain=?').get(shopDomain);
  const globalAI   = !aiSettings || aiSettings.global_ai_enabled !== 0;
  const brandAI    = !aiSettings || aiSettings[(shop?.brand||'default')+'_ai'] !== 0;

  let reply = null, provider = 'keyword', escalate = false, escalateReason = '';

  // 1. Order flow
  try { reply = await handleOrderFlow(shopDomain, phone, text, shop); if (reply) provider = 'order_flow'; } catch(e) {}

  // 2. AI
  if (!reply && aiEnabled && globalAI && brandAI) {
    const history = db.getConversation(shopDomain, phone, 10);
    const confused = confusionCounts[phone] || 0;

    if (isTracking(text)) {
      const tracking = await getShopifyTracking(phone, shop);
      if (!tracking) {
        escalate = true; escalateReason = 'tracking_api_error';
      } else if (!tracking.found) {
        reply = `I couldn't find an order for your number. Could you share your order number? It looks like *#WA-12345*.`;
        provider = 'keyword';
      } else if (!tracking.tracking) {
        escalate = true; escalateReason = 'no_tracking_number';
        reply = `Your order *#${tracking.order_number}* is being prepared. Our team will send you the tracking number shortly!`;
        provider = 'keyword';
      } else {
        reply = `Your order *#${tracking.order_number}* is on the way!\n\nCarrier: ${tracking.carrier}\nTracking: ${tracking.tracking}\nTrack: ${tracking.url}`;
        provider = 'tracking';
      }
    }

    if (!reply && !escalate) {
      const result = await getAIReply(text, shop, history, confused);
      if (result.escalate) { escalate = true; escalateReason = result.reason; }
      else if (result.needs_tracking) { /* handled above */ }
      else if (result.confused) {
        confusionCounts[phone] = (confusionCounts[phone]||0) + 1;
        if (confusionCounts[phone] >= 2) { escalate = true; escalateReason = 'ai_stuck'; }
        else { reply = `Sorry, I didn't quite get that. Could you rephrase? Or reply *HELP* to see what I can assist with.`; provider = 'fallback'; }
      } else if (result.text) {
        reply = result.text; provider = result.provider;
        confusionCounts[phone] = 0;
      }
    }
  }

  // 3. Escalate
  if (escalate) {
    db.setEscalated(shopDomain, phone, true);
    db.setAIMode(shopDomain, phone, false);
    db.saveMessage(shopDomain, { phone, direction: 'outbound', text: `[ESCALATED: ${escalateReason}]`, ai_provider: 'system' });
    if (!reply) reply = `I'll have someone from our team get back to you shortly. Sorry for any inconvenience!`;
    provider = 'escalated';
    confusionCounts[phone] = 0;
  }

  // 4. Keyword fallback
  if (!reply) {
    const lower = text.toLowerCase();
    const key = Object.keys(KEYWORDS).find(k => lower.includes(k));
    reply = key ? KEYWORDS[key](name) : `Hi ${name}! Reply *HELP* to see how I can assist, or *ORDER* to place an order.`;
    provider = 'keyword';
  }

  await sendMessage(phone, reply, shop);
  db.saveMessage(shopDomain, { phone, direction: 'outbound', text: reply, ai_provider: provider });
}

function onManualReply(shopDomain, phone) {
  confusionCounts[phone] = 0;
  db.setEscalated(shopDomain, phone, false);
}

module.exports = { handleIncomingMessage, onManualReply };

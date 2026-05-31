const { sendMessage } = require('./whatsapp');
const { getAIReply, isTrackingRequest, getShopifyTracking } = require('./ai/provider');
const db = require('./db/database');
const { handleOrderFlow } = require('./orders/flow');

// Per-phone confusion counter (resets after human reply)
const confusionCounts = {};

const KEYWORDS = {
  help:     (n) => `Hi ${n}! Here's what I can help with:\n\nReply *ORDER* to place an order\nReply *TRACK* to track your order\nReply *RETURN* for returns\nReply *COD* for cash on delivery info`,
  return:   (n) => `Hi ${n}! For returns, please share your order number and reason. Our team will get back to you within 24 hours.`,
  refund:   (n) => `Hi ${n}! Share your order number and we will process your refund within 3-5 working days.`,
  cod:      (n) => `Hi ${n}! Yes, we offer Cash on Delivery island-wide. No upfront payment needed.`,
  delivery: (n) => `Hi ${n}! We deliver island-wide in 2-5 working days via Trans Express. You will receive a tracking number once shipped.`,
};

async function handleIncomingMessage(shopDomain, message, contact, shop) {
  const phone = message.from;
  const text  = (message.text?.body || '').trim();
  const name  = contact?.profile?.name || 'there';

  console.log(`[${shopDomain}] ${phone}: "${text.substring(0,60)}"`);

  // Save contact + message
  db.upsertContact(shopDomain, phone, name);
  db.saveMessage(shopDomain, { phone, direction: 'inbound', text });

  const contact_row = db.getContact(shopDomain, phone);
  const aiEnabled = contact_row?.ai_enabled !== 0;

  // Check AI global + brand settings
  const aiSettings = db.db.prepare('SELECT * FROM ai_settings WHERE shop_domain=?').get(shopDomain);
  const globalAI = !aiSettings || aiSettings.global_ai_enabled !== 0;
  const brandKey = shop?.brand || 'default';
  const brandAI = !aiSettings || aiSettings[brandKey+'_ai'] !== 0;

  let reply = null;
  let provider = 'keyword';
  let shouldEscalateToManual = false;
  let escalateReason = '';

  // ── 1. Order flow ────────────────────────────────────────────────────────────
  try {
    reply = await handleOrderFlow(shopDomain, phone, text, shop);
    if (reply) provider = 'order_flow';
  } catch(e) { console.error('Order flow error:', e.message); }

  // ── 2. AI + tracking ─────────────────────────────────────────────────────────
  if (!reply && aiEnabled && globalAI && brandAI) {
    const history = db.getConversation(shopDomain, phone, 10);
    const confused = confusionCounts[phone] || 0;

    // Tracking request — check Shopify
    if (isTrackingRequest(text)) {
      const tracking = await getShopifyTracking(phone, shop);
      if (tracking === null) {
        // API error — escalate
        shouldEscalateToManual = true;
        escalateReason = 'tracking_api_error';
      } else if (!tracking.found) {
        reply = `I couldn't find an order linked to your number. Could you share your order number so I can check? It looks like #1234.`;
        provider = 'keyword';
      } else if (!tracking.tracking) {
        // Order found but no tracking yet — escalate for manual tracking entry
        shouldEscalateToManual = true;
        escalateReason = 'no_tracking_number';
        reply = `Your order #${tracking.order_number} is ${tracking.status === 'unfulfilled' ? 'being prepared for dispatch' : tracking.status}. I am getting the tracking details for you — our team will send it shortly!`;
        provider = 'keyword';
      } else {
        // Has tracking
        reply = `Your order #${tracking.order_number} is on its way! 🚚\n\nTracking: ${tracking.tracking}\nCarrier: ${tracking.carrier}\nTrack here: ${tracking.url}`;
        provider = 'tracking';
        // Mark as recovered if was abandoned
        db.db.prepare("UPDATE abandoned_checkouts SET status='recovered',recovered_at=datetime('now') WHERE shop_domain=? AND phone=? AND status='sent'").run(shopDomain, phone);
      }
    }

    // Normal AI reply
    if (!reply && !shouldEscalateToManual) {
      const result = await getAIReply(text, shop, history, confused);

      if (result.escalate) {
        shouldEscalateToManual = true;
        escalateReason = result.escalate_reason || 'trigger_word';
      } else if (result.needs_tracking) {
        // Handled above
      } else if (result.confused) {
        // AI confused this reply — increment counter
        confusionCounts[phone] = (confusionCounts[phone] || 0) + 1;
        if (confusionCounts[phone] >= 2) {
          shouldEscalateToManual = true;
          escalateReason = 'ai_stuck';
        } else {
          reply = `Sorry, I didn't quite get that. Could you rephrase? Or reply *HELP* to see what I can assist with.`;
          provider = 'fallback';
        }
      } else if (result.text) {
        reply = result.text;
        provider = result.provider;
        confusionCounts[phone] = 0; // reset on successful reply
      }
    }
  }

  // ── 3. Escalate to manual ────────────────────────────────────────────────────
  if (shouldEscalateToManual) {
    db.setEscalated(shopDomain, phone, true);
    db.setAIMode(shopDomain, phone, false); // turn off AI for this chat
    // Add escalation note
    db.saveMessage(shopDomain, { phone, direction: 'outbound', text: `[ESCALATED: ${escalateReason}]`, ai_provider: 'system' });
    if (!reply) {
      reply = `I'll have someone from our team get back to you shortly. Sorry for any inconvenience!`;
    }
    provider = 'escalated';
    confusionCounts[phone] = 0;
  }

  // ── 4. Keyword fallback ──────────────────────────────────────────────────────
  if (!reply) {
    const lower = text.toLowerCase();
    const key = Object.keys(KEYWORDS).find(k => lower.includes(k));
    reply = key
      ? KEYWORDS[key](name)
      : `Hi ${name}! Reply *HELP* to see how I can assist you, or *ORDER* to place an order.`;
    provider = 'keyword';
  }

  // Send reply
  await sendMessage(phone, reply, shop);
  db.saveMessage(shopDomain, { phone, direction: 'outbound', text: reply, ai_provider: provider });
}

// Called when agent manually replies — reset AI and confusion
function onManualReply(shopDomain, phone) {
  confusionCounts[phone] = 0;
  db.setEscalated(shopDomain, phone, false);
}

module.exports = { handleIncomingMessage, onManualReply };

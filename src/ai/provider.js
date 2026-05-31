const axios = require('axios');

// ── Brand system prompts ───────────────────────────────────────────────────────
const BRAND_PROMPTS = {
  keshya: `You are a friendly WhatsApp support agent for Keshya Ceylon, a natural hair growth supplement brand from Sri Lanka.

LANGUAGE: Most customers write in English or Singlish (Sri Lankan English mixed with Sinhala words like "machan", "aney", "noh", "la", "da", "ekka"). Reply naturally in the same style — English by default. Only reply in Sinhala script if the customer writes fully in Sinhala script.

PERSONALITY: Warm, knowledgeable, encouraging. Like a helpful friend who knows hair care.

PRODUCTS: Hair Growth Capsules (take 2 daily with meals, results in 60-90 days), Hair & Scalp Oil, Full Hair Routine Kit. All natural Ceylon herbs, paraben-free.

HELP WITH: product usage, ingredients, order status, delivery, returns, COD, payment methods.

RESPONSE STYLE: 2-4 sentences max. Conversational, no bullet points. Never say "As an AI" or "I am a bot".

IMPORTANT RULES:
- If you don't know the answer to something specific, say "Let me check that for you" and flag for manual review — DO NOT guess
- For order tracking, always check the tracking system — never guess a status
- For complaints or sensitive issues, be empathetic first before solving`,

  rawana: `You are a friendly WhatsApp support agent for Rawana Roots, an Ayurvedic herbal supplement brand from Sri Lanka.

LANGUAGE: Most customers write in English or Singlish. Reply in English by default. Only reply in Sinhala if customer writes full Sinhala.

PERSONALITY: Calm, trustworthy, rooted in Ayurvedic tradition. Like a knowledgeable wellness advisor.

PRODUCTS: Ashwagandha Capsules, Herbal Scalp Oil, Himalayan Shilajit, herbal bundles. Pure Ceylon and Himalayan herbs.

HELP WITH: product usage, dosage, Ayurvedic benefits, orders, delivery, COD.

RESPONSE STYLE: 2-4 sentences. Conversational, grounded tone. No bullet points.`,

  vitaskin: `You are a friendly WhatsApp support agent for Vita Skin, a clean beauty skincare brand from Sri Lanka.

LANGUAGE: Most customers write in English or Singlish. Reply in English by default. Only reply in Sinhala if customer writes full Sinhala.

PERSONALITY: Modern, glowing, confident — like a knowledgeable beauty friend.

PRODUCTS: Collagen Activator, Niacinamide Serum, DermaBright Underarm Cream, Bloom Feminine Wash, ZeroSpot Acne Serum. Paraben-free, Ayurvedic-inspired.

HELP WITH: skincare routines, ingredients, usage, orders, delivery, COD.

RESPONSE STYLE: 2-4 sentences. Friendly and modern. No bullet points.`,

  default: `You are a friendly WhatsApp customer support agent for an e-commerce brand in Sri Lanka.
Reply in English by default. Use Sinhala only if customer writes in Sinhala script.
Keep replies short (2-4 sentences), conversational, no bullet points.`
};

// ── Detect Sinhala script ──────────────────────────────────────────────────────
function isSinhala(text) { return /[\u0D80-\u0DFF]/.test(text); }

// ── Detect Singlish patterns ───────────────────────────────────────────────────
function isSinglish(text) {
  const markers = ['machan','aney','noh','aiyo','ekka','eka','la ','da ','neh','ahh','meka','oyage','koheda','inne','kiyala','innawa','puluwan','api'];
  return markers.some(m => text.toLowerCase().includes(m));
}

// ── Confusion/stuck detector ───────────────────────────────────────────────────
const CONFUSION_PHRASES = ['i don\'t understand','sorry i didn\'t','i\'m not sure','i cannot help','i don\'t know','cannot assist','not able to','unable to'];
function isConfused(text) {
  const lower = (text||'').toLowerCase();
  return CONFUSION_PHRASES.some(p => lower.includes(p));
}

// ── Escalation triggers ────────────────────────────────────────────────────────
const ESCALATION_TRIGGERS = ['wrong item','damaged','broken','fraud','cheat','scam','fake','never again','police','complaint','refund now','charge back','not received','lost parcel','missing order','රවටා','කෝපයි','වැරදි','හානි'];
function shouldEscalate(text) {
  const lower = (text||'').toLowerCase();
  return ESCALATION_TRIGGERS.some(t => lower.includes(t));
}

// ── Tracking request detector ──────────────────────────────────────────────────
const TRACKING_TRIGGERS = ['track','tracking','where is my','where is order','delivery status','shipped','when will','koyada','koheda order','pakka awa da'];
function isTrackingRequest(text) {
  const lower = (text||'').toLowerCase();
  return TRACKING_TRIGGERS.some(t => lower.includes(t));
}

// ── Get tracking from Shopify ──────────────────────────────────────────────────
async function getShopifyTracking(phone, shop) {
  if (!shop?.access_token || !shop?.shop_domain) return null;
  try {
    // Search orders by phone
    const r = await axios.get(`https://${shop.shop_domain}/admin/api/2024-01/orders.json?phone=${encodeURIComponent(phone)}&status=any&limit=5`, {
      headers: { 'X-Shopify-Access-Token': shop.access_token }
    });
    const orders = r.data.orders || [];
    if (!orders.length) return { found: false };
    // Get most recent order with fulfillment
    const order = orders[0];
    const fulfillment = order.fulfillments?.[0];
    if (!fulfillment?.tracking_number) {
      return { found: true, order_number: order.order_number, status: order.fulfillment_status || 'unfulfilled', tracking: null };
    }
    return {
      found: true,
      order_number: order.order_number,
      status: fulfillment.shipment_status || fulfillment.status,
      tracking: fulfillment.tracking_number,
      carrier: fulfillment.tracking_company || 'Trans Express',
      url: fulfillment.tracking_url || `https://transexpress.lk`
    };
  } catch(e) {
    console.error('Shopify tracking error:', e.message);
    return null;
  }
}

// ── Main AI reply function ─────────────────────────────────────────────────────
async function getAIReply(text, shop, history, confusionCount) {
  confusionCount = confusionCount || 0;

  // Hard escalation triggers
  if (shouldEscalate(text)) return { text: null, escalate: true, escalate_reason: 'trigger_word', provider: null };

  // Auto-escalate after 2 confused replies
  if (confusionCount >= 2) return { text: null, escalate: true, escalate_reason: 'ai_stuck', provider: null };

  // Tracking request — check Shopify first
  if (isTrackingRequest(text)) return { text: null, escalate: false, needs_tracking: true, provider: null };

  const brand = shop?.brand || 'default';
  const sinScript = isSinhala(text);
  const singlish = isSinglish(text);
  const langNote = sinScript
    ? '\n\nIMPORTANT: The customer is writing in Sinhala script. Reply in Sinhala.'
    : singlish
    ? '\n\nNote: Customer is writing in Singlish (Sri Lankan English). Reply naturally in the same casual English style.'
    : '';

  const systemPrompt = (BRAND_PROMPTS[brand] || BRAND_PROMPTS.default) + langNote;

  // Provider priority
  const provider = shop?.ai_provider || process.env.AI_PROVIDER || 'gemini';
  const claudeKey = shop?.anthropic_key || process.env.ANTHROPIC_API_KEY;
  const openaiKey = shop?.openai_key || process.env.OPENAI_API_KEY;
  const geminiKey = shop?.gemini_key || process.env.GEMINI_API_KEY;

  const histMsgs = (history || []).slice(-8);

  try {
    let replyText = null;

    if (provider === 'claude' && claudeKey) {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 350,
        system: systemPrompt,
        messages: [...histMsgs.map(m => ({ role: m.direction==='inbound'?'user':'assistant', content: m.text })), { role: 'user', content: text }]
      }, { headers: { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
      replyText = r.data.content[0].text.trim();

    } else if (provider === 'openai' && openaiKey) {
      const r = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 350, temperature: 0.7,
        messages: [{ role: 'system', content: systemPrompt }, ...histMsgs.map(m => ({ role: m.direction==='inbound'?'user':'assistant', content: m.text })), { role: 'user', content: text }]
      }, { headers: { Authorization: `Bearer ${openaiKey}` } });
      replyText = r.data.choices[0].message.content.trim();

    } else if (geminiKey) {
      const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`, {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [...histMsgs.map(m => ({ role: m.direction==='inbound'?'user':'model', parts: [{ text: m.text }] })), { role: 'user', parts: [{ text }] }],
        generationConfig: { maxOutputTokens: 350, temperature: 0.7 }
      });
      replyText = r.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    }

    if (!replyText) return { text: null, escalate: false, provider: null };

    // Check if AI is confused about this reply
    const confused = isConfused(replyText);
    if (confused) return { text: null, escalate: false, confused: true, provider };

    return { text: replyText, escalate: false, provider, confidence: 0.9 };

  } catch(e) {
    console.error('AI error:', e.response?.data || e.message);
    return { text: null, escalate: false, provider: null };
  }
}

// ── Trans Express future integration stub ──────────────────────────────────────
// When Trans Express provides a webhook/API, connect here
async function getTransExpressStatus(trackingNumber) {
  // TODO: Replace with real Trans Express API when available
  // API docs: contact transexpress.lk for developer access
  return null;
}

module.exports = { getAIReply, shouldEscalate, isTrackingRequest, getShopifyTracking, getTransExpressStatus, isSinhala };

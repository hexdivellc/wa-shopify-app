const axios = require('axios');

const BRAND_PROMPTS = {
  keshya:   'You are a friendly WhatsApp support agent for Keshya Ceylon, a natural hair growth supplement brand from Sri Lanka. Products: Hair Growth Capsules (take 2 daily, results in 60-90 days), Hair & Scalp Oil, Full Hair Routine Kit.',
  rawana:   'You are a friendly WhatsApp support agent for Rawana Roots, an Ayurvedic herbal supplement brand from Sri Lanka. Products: Ashwagandha Capsules, Herbal Oil, Himalayan Shilajit.',
  vitaskin: 'You are a friendly WhatsApp support agent for Vita Skin, a clean beauty skincare brand from Sri Lanka. Products: Collagen Activator, DermaBright Cream, Bloom Feminine Wash, ZeroSpot Serum.',
  default:  'You are a friendly WhatsApp customer support agent for an e-commerce brand in Sri Lanka.',
};
const BASE_PROMPT = '\n\nLANGUAGE: Customers mostly write English or Singlish (machan, aney, noh, la, da, aiyo). Reply in English by default. Only use Sinhala if customer writes full Sinhala script.\nSTYLE: 2-4 sentences max. Conversational, no bullet points. Never say you are an AI.\nRULES: If unsure about something specific, say you will check and flag for team. Never guess order status.';

const ESCALATION_TRIGGERS = ['wrong item','damaged','broken','fraud','cheat','scam','fake','never again','police','complaint','refund now','charge back','not received','lost parcel','missing order','රවටා','කෝපයි','වැරදි'];
const TRACKING_TRIGGERS = ['track','tracking','where is my','delivery status','shipped','when will','koyada','koheda order','pakka'];
const CONFUSION_PHRASES = ["i don't understand","sorry i didn't","i'm not sure","i cannot help","not able to","cannot assist"];

function shouldEscalate(text) { return ESCALATION_TRIGGERS.some(t => text.toLowerCase().includes(t)); }
function isTracking(text) { return TRACKING_TRIGGERS.some(t => text.toLowerCase().includes(t)); }
function isConfused(text) { return CONFUSION_PHRASES.some(p => (text||'').toLowerCase().includes(p)); }
function isSinhala(text) { return /[\u0D80-\u0DFF]/.test(text); }

async function getShopifyTracking(phone, shop) {
  if (!shop?.access_token || !shop?.shop_domain) return null;
  try {
    const r = await axios.get(`https://${shop.shop_domain}/admin/api/2024-01/orders.json?phone=${encodeURIComponent(phone)}&status=any&limit=3`, { headers: { 'X-Shopify-Access-Token': shop.access_token } });
    const order = (r.data.orders||[])[0];
    if (!order) return { found: false };
    const f = order.fulfillments?.[0];
    if (!f?.tracking_number) return { found: true, order_number: order.order_number, status: order.fulfillment_status||'unfulfilled', tracking: null };
    return { found: true, order_number: order.order_number, tracking: f.tracking_number, carrier: f.tracking_company||'Trans Express', url: f.tracking_url||'https://transexpress.lk', status: f.shipment_status||f.status };
  } catch(e) { return null; }
}

async function getAIReply(text, shop, history, confusionCount) {
  if (shouldEscalate(text)) return { text: null, escalate: true, reason: 'trigger_word' };
  if ((confusionCount||0) >= 2) return { text: null, escalate: true, reason: 'ai_stuck' };
  if (isTracking(text)) return { text: null, needs_tracking: true };

  const brand = shop?.brand || 'default';
  const sinScript = isSinhala(text);
  const langNote = sinScript ? '\n\nIMPORTANT: Reply in Sinhala script.' : '';
  const systemPrompt = (BRAND_PROMPTS[brand] || BRAND_PROMPTS.default) + BASE_PROMPT + langNote;

  const provider  = shop?.ai_provider || process.env.AI_PROVIDER || 'gemini';
  const claudeKey = shop?.anthropic_key || process.env.ANTHROPIC_API_KEY;
  const openaiKey = shop?.openai_key   || process.env.OPENAI_API_KEY;
  const geminiKey = shop?.gemini_key   || process.env.GEMINI_API_KEY;
  const histMsgs  = (history||[]).slice(-8);

  try {
    let replyText = null;
    if (provider === 'claude' && claudeKey) {
      const r = await axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: systemPrompt, messages: [...histMsgs.map(m=>({role:m.direction==='inbound'?'user':'assistant',content:m.text})),{role:'user',content:text}] }, { headers: { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' } });
      replyText = r.data.content[0].text.trim();
    } else if (provider === 'openai' && openaiKey) {
      const r = await axios.post('https://api.openai.com/v1/chat/completions', { model: 'gpt-4o-mini', max_tokens: 300, messages: [{role:'system',content:systemPrompt},...histMsgs.map(m=>({role:m.direction==='inbound'?'user':'assistant',content:m.text})),{role:'user',content:text}] }, { headers: { Authorization: `Bearer ${openaiKey}` } });
      replyText = r.data.choices[0].message.content.trim();
    } else if (geminiKey) {
      const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`, { system_instruction:{parts:[{text:systemPrompt}]}, contents:[...histMsgs.map(m=>({role:m.direction==='inbound'?'user':'model',parts:[{text:m.text}]})),{role:'user',parts:[{text}]}], generationConfig:{maxOutputTokens:300,temperature:0.7} });
      replyText = r.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    }
    if (!replyText) return { text: null, escalate: false };
    if (isConfused(replyText)) return { text: null, confused: true, provider };
    return { text: replyText, escalate: false, provider };
  } catch(e) {
    console.error('AI error:', e.response?.data || e.message);
    return { text: null, escalate: false };
  }
}

module.exports = { getAIReply, shouldEscalate, isTracking, getShopifyTracking, isSinhala };

require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const path       = require('path');
const crypto     = require('crypto');
const axios      = require('axios');

const db                           = require('./db/database');
const { handleIncomingMessage }    = require('./bot');
const { sendMessage }              = require('./whatsapp');
const { syncShopifyProducts }      = require('./sync/shopify-sync');
const { sendBroadcast }            = require('./broadcast/engine');
const { setupAuthRoutes }          = require('./auth/team-auth');
const { setupTrainingRoutes, setupUpsellRoutes } = require('./training/training');
const { setupAbandonedRoutes, saveAbandonedCheckout } = require('./abandoned/abandoned');
const { setupTransExpressWebhook } = require('./transexpress/webhook');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(session({ secret: process.env.SESSION_SECRET || 'wabot2025', resave: false, saveUninitialized: false }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ── Serve dashboard ────────────────────────────────────────────────────────────
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '../public/app.html')));
app.get('/', (req, res) => res.redirect('/app'));

// ── Auth routes ────────────────────────────────────────────────────────────────
const { requireAuth } = setupAuthRoutes(app, db);

// ── Helper ─────────────────────────────────────────────────────────────────────
function getD(req) { return req.activeDomain || req.headers['x-active-shop'] || null; }

// ── Shops ──────────────────────────────────────────────────────────────────────
app.get('/api/shops', requireAuth(), (req, res) => {
  res.json(db.db.prepare("SELECT id,shop_domain,shop_name,brand,wa_phone_id,wati_endpoint,ai_provider,active,created_at FROM shops ORDER BY created_at").all());
});
app.post('/api/shops', requireAuth(['admin']), (req, res) => {
  const { shop_domain, brand, wa_token, wa_phone_id, wa_verify_token, ai_provider, anthropic_key, openai_key, gemini_key, shopify_token, wati_endpoint, wati_token } = req.body;
  if (!shop_domain) return res.status(400).json({ error: 'shop_domain required' });
  const data = {};
  if (brand)         data.brand         = brand;
  if (ai_provider)   data.ai_provider   = ai_provider;
  if (wa_token)      data.wa_token      = wa_token;
  if (wa_phone_id)   data.wa_phone_id   = wa_phone_id;
  if (wa_verify_token) data.wa_verify_token = wa_verify_token;
  if (anthropic_key) data.anthropic_key = anthropic_key;
  if (openai_key)    data.openai_key    = openai_key;
  if (gemini_key)    data.gemini_key    = gemini_key;
  if (shopify_token) data.access_token  = shopify_token;
  if (wati_endpoint) data.wati_endpoint = wati_endpoint;
  if (wati_token)    data.wati_token    = wati_token;
  db.upsertShop(shop_domain, data);
  res.json({ ok: true });
});
app.patch('/api/shops/:domain', requireAuth(['admin']), (req, res) => {
  db.upsertShop(decodeURIComponent(req.params.domain), req.body);
  res.json({ ok: true });
});
app.delete('/api/shops/:domain', requireAuth(['admin']), (req, res) => {
  db.db.prepare("DELETE FROM shops WHERE shop_domain=?").run(decodeURIComponent(req.params.domain));
  res.json({ ok: true });
});

// ── Settings ───────────────────────────────────────────────────────────────────
app.get('/api/settings', requireAuth(), (req, res) => {
  const d = getD(req); if (!d) return res.json({});
  const s = db.getShop(d); if (!s) return res.status(404).json({ error: 'Shop not found' });
  res.json({ brand: s.brand||'default', ai_provider: s.ai_provider||'gemini', wa_configured: !!(s.wa_token && s.wa_phone_id), wati_configured: !!(s.wati_token && s.wati_endpoint) });
});
app.post('/api/settings', requireAuth(['admin']), (req, res) => {
  const d = getD(req); if (!d) return res.status(400).json({ error: 'No active shop' });
  db.upsertShop(d, req.body);
  res.json({ ok: true });
});

// ── Automations ────────────────────────────────────────────────────────────────
app.get('/api/automations', requireAuth(), (req, res) => {
  const d = getD(req); if (!d) return res.json({});
  res.json(db.db.prepare("SELECT * FROM automation_settings WHERE shop_domain=?").get(d) || { cod_confirm_enabled:1, cod_confirm_msg:'Hi {{name}}! Your COD order #{{order}} is confirmed. Total: Rs.{{total}}. Address: {{address}}. Reply YES to confirm.', reorder_enabled:1, reorder_days:30, reorder_msg:'Hi {{name}}! Running low on {{product}}? Reorder: {{url}}', review_enabled:1, review_days:7, review_msg:'Hi {{name}}! Hope you love your order! Leave us a review: {{url}}' });
});
app.post('/api/automations', requireAuth(['admin']), (req, res) => {
  const d = getD(req); if (!d) return res.status(400).json({ error: 'No active shop' });
  const b = req.body;
  db.db.prepare(`INSERT INTO automation_settings (shop_domain,cod_confirm_enabled,cod_confirm_msg,reorder_enabled,reorder_days,reorder_msg,review_enabled,review_days,review_msg,updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(shop_domain) DO UPDATE SET cod_confirm_enabled=?,cod_confirm_msg=?,reorder_enabled=?,reorder_days=?,reorder_msg=?,review_enabled=?,review_days=?,review_msg=?,updated_at=datetime('now')`)
    .run(d,b.cod_confirm_enabled?1:0,b.cod_confirm_msg,b.reorder_enabled?1:0,b.reorder_days||30,b.reorder_msg,b.review_enabled?1:0,b.review_days||7,b.review_msg,b.cod_confirm_enabled?1:0,b.cod_confirm_msg,b.reorder_enabled?1:0,b.reorder_days||30,b.reorder_msg,b.review_enabled?1:0,b.review_days||7,b.review_msg);
  res.json({ ok: true });
});

// ── Conversations ──────────────────────────────────────────────────────────────
app.get('/api/conversations', requireAuth(), (req, res) => { const d=getD(req); if(!d) return res.json([]); res.json(db.getAllConversations(d)); });
app.get('/api/conversations/:phone', requireAuth(), (req, res) => { const d=getD(req); if(!d) return res.json([]); res.json(db.getConversation(d, decodeURIComponent(req.params.phone))); });
app.post('/api/conversations/:phone/reply', requireAuth(['admin','agent']), async (req, res) => {
  const d=getD(req); if(!d) return res.status(400).json({error:'No active shop'});
  const phone = decodeURIComponent(req.params.phone);
  const { text } = req.body; if(!text) return res.status(400).json({error:'text required'});
  const shop = db.getShop(d);
  await sendMessage(phone, text, shop);
  db.saveMessage(d, { phone, direction:'outbound', text, ai_provider:'manual' });
  res.json({ ok:true });
});
app.post('/api/conversations/:phone/ai-mode', requireAuth(['admin','agent']), (req, res) => { const d=getD(req); if(!d) return res.status(400).json({error:'No active shop'}); db.setAIMode(d, decodeURIComponent(req.params.phone), req.body.ai_enabled); res.json({ok:true}); });
app.post('/api/conversations/:phone/escalate', requireAuth(['admin','agent']), (req, res) => { const d=getD(req); if(!d) return res.status(400).json({error:'No active shop'}); db.setEscalated(d, decodeURIComponent(req.params.phone), req.body.escalated); res.json({ok:true}); });

// ── WA Orders ──────────────────────────────────────────────────────────────────
app.get('/api/wa-orders', requireAuth(), (req, res) => { const d=getD(req); if(!d) return res.json([]); res.json(db.getWAOrders(d, req.query.status||null)); });
app.get('/api/wa-orders/phone/:phone', requireAuth(), (req, res) => { const d=getD(req); if(!d) return res.json([]); res.json(db.getOrdersByPhone(d, decodeURIComponent(req.params.phone))); });
app.patch('/api/wa-orders/:id/status', requireAuth(['admin','agent']), async (req, res) => {
  const d=getD(req); if(!d) return res.status(400).json({error:'No active shop'});
  const order = db.updateOrderStatus(d, req.params.id, req.body.status);
  if (order?.phone) {
    const shop = db.getShop(d);
    const msgs = { packed:`Your order #${order.order_number} is packed and on its way!`, delivered:`Your order #${order.order_number} has been delivered. Thank you!`, cancelled:`Your order #${order.order_number} has been cancelled.` };
    if (msgs[req.body.status]) await sendMessage(order.phone, msgs[req.body.status], shop);
  }
  res.json({ok:true});
});

// ── Products ───────────────────────────────────────────────────────────────────
app.get('/api/products', requireAuth(), (req, res) => { const d=getD(req); if(!d) return res.json([]); res.json(db.getProducts(d)); });
app.post('/api/products', requireAuth(['admin']), (req, res) => { const d=getD(req); if(!d) return res.status(400).json({error:'No active shop'}); db.addProduct(d, req.body); res.json({ok:true}); });
app.patch('/api/products/:id', requireAuth(['admin']), (req, res) => { const d=getD(req); if(!d) return res.status(400).json({error:'No active shop'}); db.updateProduct(d, req.params.id, req.body); res.json({ok:true}); });
app.delete('/api/products/:id', requireAuth(['admin']), (req, res) => { const d=getD(req); if(!d) return res.status(400).json({error:'No active shop'}); db.deleteProduct(d, req.params.id); res.json({ok:true}); });
app.post('/api/sync/shopify', requireAuth(['admin']), async (req, res) => { const d=getD(req); if(!d) return res.status(400).json({error:'No active shop'}); const shop=db.getShop(d); res.json(await syncShopifyProducts(d, d, shop?.access_token)); });

// ── Broadcasts ─────────────────────────────────────────────────────────────────
app.get('/api/broadcasts', requireAuth(), (req, res) => { const d=getD(req); if(!d) return res.json([]); res.json(db.getBroadcasts(d)); });
app.post('/api/broadcasts', requireAuth(['admin','agent']), (req, res) => { const d=getD(req); if(!d) return res.status(400).json({error:'No active shop'}); res.json(db.createBroadcast(d, req.body)); });
app.post('/api/broadcasts/:id/send', requireAuth(['admin','agent']), (req, res) => { const d=getD(req); if(!d) return res.status(400).json({error:'No active shop'}); res.json({ok:true}); sendBroadcast(d, parseInt(req.params.id), db.getShop(d)); });

// ── Analytics ──────────────────────────────────────────────────────────────────
app.get('/api/analytics', requireAuth(), (req, res) => { const d=getD(req); if(!d) return res.json({inbound:0,outbound:0,escalated:0,totalOrders:0,totalRevenue:0}); res.json(db.getAnalytics(d, parseInt(req.query.days)||7)); });

// ── Module routes ──────────────────────────────────────────────────────────────
setupTrainingRoutes(app, db, requireAuth);
setupUpsellRoutes(app, db, requireAuth);
setupAbandonedRoutes(app, db, requireAuth);
setupTransExpressWebhook(app, db);

// ── WA webhooks — WATI + Meta ──────────────────────────────────────────────────
function parseWATI(b) {
  if (!b || !b.waId) return null;
  if (b.owner === true || b.owner === 'true') return null; // outbound, ignore
  const text = b.text || b.body || '';
  if (!text) return null;
  return { phone: b.waId, text, name: b.senderName || b.name || 'there' };
}

app.get('/webhook/whatsapp', (req, res) => {
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const shop = token ? db.db.prepare('SELECT * FROM shops WHERE wa_verify_token=?').get(token) : null;
  if (req.query['hub.mode'] === 'subscribe' && shop) return res.status(200).send(challenge);
  res.sendStatus(200);
});

app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  try {
    const b = req.body;
    const wati = parseWATI(b);
    if (wati) {
      const shop = db.db.prepare("SELECT * FROM shops WHERE wati_token IS NOT NULL AND wati_token!='' LIMIT 1").get();
      if (shop) {
        await handleIncomingMessage(shop.shop_domain, { from: wati.phone, text: { body: wati.text }, type: 'text' }, { profile: { name: wati.name } }, shop);
        return;
      }
    }
    const value    = b.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages;
    const contacts = value?.contacts;
    const phoneId  = value?.metadata?.phone_number_id;
    if (!messages?.length || messages[0].type !== 'text') return;
    const shop = phoneId ? db.db.prepare('SELECT * FROM shops WHERE wa_phone_id=?').get(phoneId) : null;
    if (!shop) return;
    await handleIncomingMessage(shop.shop_domain, messages[0], contacts?.[0], shop);
  } catch(e) { console.error('[WA webhook]', e.message); }
});

// Dedicated WATI endpoint
app.post('/webhook/wati', async (req, res) => {
  res.sendStatus(200);
  try {
    const wati = parseWATI(req.body);
    if (!wati) return;
    const shop = db.db.prepare("SELECT * FROM shops WHERE wati_token IS NOT NULL AND wati_token!='' LIMIT 1").get();
    if (!shop) return;
    await handleIncomingMessage(shop.shop_domain, { from: wati.phone, text: { body: wati.text }, type: 'text' }, { profile: { name: wati.name } }, shop);
  } catch(e) { console.error('[WATI webhook]', e.message); }
});

// ── Shopify webhooks ───────────────────────────────────────────────────────────
app.post('/webhook/shopify/order-created', async (req, res) => {
  res.sendStatus(200);
  try {
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const shop = db.getShop(shopDomain); if (!shop) return;
    const order = req.body;
    const phone = order.billing_address?.phone || order.shipping_address?.phone || order.phone;
    if (!phone) return;
    const name  = order.billing_address?.first_name || order.customer?.first_name || 'there';
    const items = (order.line_items||[]).map(i=>`• ${i.name} x${i.quantity}`).join('\n');
    await sendMessage(phone, `Hi ${name}! Your order *#${order.order_number}* is confirmed!\n\n${items}\n\n*Total: ${order.currency} ${order.total_price}*\n\nWe'll notify you when it ships!`, shop);
    db.db.prepare("INSERT OR IGNORE INTO wa_orders (shop_domain,order_number,phone,customer_name,status,total,source) VALUES (?,?,?,?,'new',?,'shopify')").run(shopDomain, String(order.order_number), phone, name, parseFloat(order.total_price||0));
  } catch(e) { console.error('[Shopify order-created]', e.message); }
});

app.post('/webhook/shopify/order-fulfilled', async (req, res) => {
  res.sendStatus(200);
  try {
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const shop = db.getShop(shopDomain); if (!shop) return;
    const order = req.body;
    const phone = order.billing_address?.phone || order.shipping_address?.phone;
    if (!phone) return;
    const tracking = order.fulfillments?.[0]?.tracking_number;
    const trackUrl = order.fulfillments?.[0]?.tracking_url || 'https://transexpress.lk';
    await sendMessage(phone, `Your order *#${order.order_number}* has shipped!${tracking ? `\n\nTracking: ${tracking}` : ''}\nTrack: ${trackUrl}`, shop);
    if (tracking) db.db.prepare("INSERT OR IGNORE INTO trans_express_deliveries (shop_domain,tracking_number,phone,status) VALUES (?,?,?,'shipped')").run(shopDomain, tracking, phone);
  } catch(e) { console.error('[Shopify order-fulfilled]', e.message); }
});

app.post('/webhook/shopify/checkout-abandoned', async (req, res) => {
  res.sendStatus(200);
  try {
    const shopDomain = req.headers['x-shopify-shop-domain'];
    if (shopDomain) saveAbandonedCheckout(shopDomain, req.body);
  } catch(e) { console.error('[Shopify abandoned]', e.message); }
});

// ── Shopify OAuth (for catalog sync) ──────────────────────────────────────────
const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL            = process.env.APP_URL || `https://localhost:${PORT}`;

app.get('/auth', (req, res) => {
  const shop = req.query.shop; if (!shop) return res.status(400).send('Missing shop');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=read_products,read_orders,read_customers,read_fulfillments&redirect_uri=${APP_URL}/auth/callback&state=${state}`);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code, state, hmac } = req.query;
  if (state !== req.session.state) return res.status(403).send('State mismatch');
  try {
    const tokenRes = await axios.post(`https://${shop}/admin/oauth/access_token`, { client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code });
    db.upsertShop(shop, { access_token: tokenRes.data.access_token });
    res.redirect('/app');
  } catch(e) { res.status(500).send('OAuth failed: ' + e.message); }
});

app.listen(PORT, () => console.log(`WA Bot running on port ${PORT}`));

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');

const db = require('./db/database');
const { handleIncomingMessage } = require('./bot');
const { sendMessage } = require('./whatsapp');
const { syncShopifyProducts } = require('./sync/shopify-sync');
const { sendBroadcast } = require('./broadcast/engine');
const { setupAuthRoutes } = require('./auth/team-auth');
const { setupTrainingRoutes } = require('./training/training');
const { setupUpsellRoutes } = require('./training/upsell');
const { setupAbandonedRoutes, saveAbandonedCheckout, startAbandonedScheduler } = require('./abandoned/abandoned');
const { setupTransExpressWebhook } = require('./transexpress/webhook');

const app = express();
const PORT = process.env.PORT || 3000;
const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL            = process.env.APP_URL || 'https://localhost:' + PORT;
const SCOPES = 'read_products,write_products,read_orders,write_orders,read_customers,write_customers,read_checkouts,read_fulfillments,write_fulfillments';

app.use(cookieParser());
app.use(session({ secret: process.env.SESSION_SECRET || 'wabot-2025', resave: false, saveUninitialized: false }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json({ verify: function(req, _res, buf) { req.rawBody = buf; } }));

// ── Auth ───────────────────────────────────────────────────────────────────────
app.get('/auth', function(req, res) {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  const redirectUri = APP_URL + '/auth/callback';
  res.redirect('https://' + shop + '/admin/oauth/authorize?client_id=' + SHOPIFY_API_KEY + '&scope=' + SCOPES + '&redirect_uri=' + redirectUri + '&state=' + state);
});

app.get('/auth/callback', async function(req, res) {
  const { shop, code, state, hmac } = req.query;
  if (state !== req.session.state) return res.status(403).send('State mismatch');
  const params = Object.entries(req.query).filter(function(e) { return e[0] !== 'hmac'; }).sort().map(function(e) { return e[0] + '=' + e[1]; }).join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(params).digest('hex');
  if (digest !== hmac) return res.status(403).send('HMAC mismatch');
  try {
    const tokenRes = await axios.post('https://' + shop + '/admin/oauth/access_token', { client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code: code });
    db.upsertShop(shop, { access_token: tokenRes.data.access_token });
    req.session.shop = shop;
    res.redirect('/app?shop=' + shop);
  } catch(e) {
    console.error('OAuth error:', e.message);
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

function requireShop(req, res, next) {
  const shop = req.query.shop || req.session.shop || req.headers['x-shop-domain'];
  if (!shop) return res.status(401).json({ error: 'Not authenticated. Visit /auth?shop=yourstore.myshopify.com' });
  const s = db.getShop(shop);
  if (!s) return res.redirect('/auth?shop=' + shop);
  req.shop = s;
  req.shopDomain = shop;
  next();
}

// ── App page — serve without requireShop so login screen works ────────────────
app.get('/app', function(req, res) {
  res.sendFile(path.join(__dirname, '../public/app.html'));
});

app.get('/', function(req, res) {
  if (req.query.shop) return res.redirect('/auth?shop=' + req.query.shop);
  res.send('<h2>WA Bot App</h2><p>Visit <code>/auth?shop=yourstore.myshopify.com</code> to install.</p>');
});

// ── Module routes (auth first) ─────────────────────────────────────────────────
const { requireAuth } = setupAuthRoutes(app, db);
setupTrainingRoutes(app, db, requireAuth);
setupUpsellRoutes(app, db, requireAuth);
setupAbandonedRoutes(app, db, requireAuth);
startAbandonedScheduler(db, db.getShop);
setupTransExpressWebhook(app, db);

// ── Shop management (no shop in URL — managed from inside app) ─────────────────
app.get('/api/shops', requireAuth(), function(req, res) {
  const shops = db.db.prepare("SELECT id,shop_domain,brand,wa_phone_id,ai_provider,created_at FROM shops ORDER BY created_at").all();
  res.json(shops);
});

app.post('/api/shops', requireAuth(['admin']), function(req, res) {
  const { shop_domain, brand, wa_token, wa_phone_id, wa_verify_token, ai_provider, anthropic_key, openai_key, gemini_key, shopify_token, name } = req.body;
  if (!shop_domain) return res.status(400).json({ error: 'shop_domain required' });
  db.upsertShop(shop_domain, { brand: brand||'default', wa_token, wa_phone_id, wa_verify_token, ai_provider: ai_provider||'gemini', anthropic_key, openai_key, gemini_key, access_token: shopify_token, shop_name: name });
  res.json({ ok: true });
});

app.patch('/api/shops/:domain', requireAuth(['admin']), function(req, res) {
  const domain = decodeURIComponent(req.params.domain);
  db.upsertShop(domain, req.body);
  res.json({ ok: true });
});

app.delete('/api/shops/:domain', requireAuth(['admin']), function(req, res) {
  db.db.prepare("DELETE FROM shops WHERE shop_domain=?").run(decodeURIComponent(req.params.domain));
  res.json({ ok: true });
});

// ── Settings (shop-scoped) ─────────────────────────────────────────────────────
app.get('/api/settings', requireAuth(), function(req, res) {
  const domain = req.activeDomain || req.headers['x-active-shop'];
  if (!domain) return res.json({ shops: [] });
  const s = db.getShop(domain);
  if (!s) return res.status(404).json({ error: 'Shop not found' });
  res.json({ brand: s.brand||'default', ai_provider: s.ai_provider||'gemini', wa_configured: !!(s.wa_token && s.wa_phone_id), shop_domain: domain });
});

app.post('/api/settings', requireAuth(['admin']), function(req, res) {
  const domain = req.activeDomain || req.headers['x-active-shop'];
  if (!domain) return res.status(400).json({ error: 'No active shop' });
  const { brand, ai_provider, wa_token, wa_phone_id, wa_verify_token, anthropic_key, openai_key, gemini_key } = req.body;
  db.upsertShop(domain, { brand, ai_provider, wa_token, wa_phone_id, wa_verify_token, anthropic_key, openai_key, gemini_key });
  res.json({ ok: true });
});

// ── Automation flows settings ──────────────────────────────────────────────────
app.get('/api/automations', requireAuth(), function(req, res) {
  const domain = req.activeDomain || req.headers['x-active-shop'];
  if (!domain) return res.json({});
  const s = db.db.prepare("SELECT * FROM automation_settings WHERE shop_domain=?").get(domain);
  res.json(s || {
    cod_confirm_enabled: 1, cod_confirm_msg: 'Hi {{name}}! Your COD order #{{order}} is confirmed. Total: Rs.{{total}}. Is your address correct? Reply YES or NO.',
    reorder_enabled: 1, reorder_days: 30, reorder_msg: 'Hi {{name}}! Running low on {{product}}? Reorder here: {{url}}',
    review_enabled: 1, review_days: 7, review_msg: 'Hi {{name}}! Hope you are enjoying your order. We would love your feedback! Leave a review: {{url}}'
  });
});

app.post('/api/automations', requireAuth(['admin']), function(req, res) {
  const domain = req.activeDomain || req.headers['x-active-shop'];
  if (!domain) return res.status(400).json({ error: 'No active shop' });
  const d = req.body;
  db.db.prepare(`INSERT INTO automation_settings
    (shop_domain,cod_confirm_enabled,cod_confirm_msg,reorder_enabled,reorder_days,reorder_msg,review_enabled,review_days,review_msg,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(shop_domain) DO UPDATE SET
    cod_confirm_enabled=?,cod_confirm_msg=?,reorder_enabled=?,reorder_days=?,reorder_msg=?,review_enabled=?,review_days=?,review_msg=?,updated_at=datetime('now')`)
    .run(domain,d.cod_confirm_enabled?1:0,d.cod_confirm_msg,d.reorder_enabled?1:0,d.reorder_days||30,d.reorder_msg,d.review_enabled?1:0,d.review_days||7,d.review_msg,
         d.cod_confirm_enabled?1:0,d.cod_confirm_msg,d.reorder_enabled?1:0,d.reorder_days||30,d.reorder_msg,d.review_enabled?1:0,d.review_days||7,d.review_msg);
  res.json({ ok: true });
});

// ── Conversations ──────────────────────────────────────────────────────────────
app.get('/api/conversations', requireShop, function(req, res) { res.json(db.getAllConversations(req.shopDomain)); });
app.get('/api/conversations/:phone', requireShop, function(req, res) { res.json(db.getConversation(req.shopDomain, decodeURIComponent(req.params.phone))); });
app.post('/api/conversations/:phone/reply', requireShop, async function(req, res) {
  const phone = decodeURIComponent(req.params.phone);
  const text = req.body.text;
  if (!text) return res.status(400).json({ error: 'text required' });
  await sendMessage(phone, text, req.shop);
  db.saveMessage(req.shopDomain, { phone: phone, direction: 'outbound', text: text, ai_provider: 'manual' });
  res.json({ ok: true });
});
app.post('/api/conversations/:phone/ai-mode', requireShop, function(req, res) {
  db.setAIMode(req.shopDomain, decodeURIComponent(req.params.phone), req.body.ai_enabled);
  res.json({ ok: true });
});
app.post('/api/conversations/:phone/escalate', requireShop, function(req, res) {
  db.setEscalated(req.shopDomain, decodeURIComponent(req.params.phone), req.body.escalated);
  res.json({ ok: true });
});

// ── WA Orders ──────────────────────────────────────────────────────────────────
app.get('/api/wa-orders', requireShop, function(req, res) { res.json(db.getWAOrders(req.shopDomain, req.query.status || null)); });
app.get('/api/wa-orders/phone/:phone', requireShop, function(req, res) { res.json(db.getOrdersByPhone(req.shopDomain, decodeURIComponent(req.params.phone))); });
app.patch('/api/wa-orders/:id/status', requireShop, async function(req, res) {
  const order = db.updateOrderStatus(req.shopDomain, req.params.id, req.body.status);
  if (order && order.phone) {
    const msgs = { packed: 'Your order #' + order.order_number + ' is packed and on its way!', delivered: 'Your order #' + order.order_number + ' delivered! Thank you', cancelled: 'Your order #' + order.order_number + ' has been cancelled.' };
    if (msgs[req.body.status]) await sendMessage(order.phone, msgs[req.body.status], req.shop);
  }
  res.json({ ok: true });
});

// ── Products ───────────────────────────────────────────────────────────────────
app.get('/api/products', requireShop, function(req, res) { res.json(db.getProducts(req.shopDomain)); });
app.post('/api/products', requireShop, function(req, res) { db.addProduct(req.shopDomain, req.body); res.json({ ok: true }); });
app.patch('/api/products/:id', requireShop, function(req, res) { db.updateProduct(req.shopDomain, req.params.id, req.body); res.json({ ok: true }); });
app.delete('/api/products/:id', requireShop, function(req, res) { db.deleteProduct(req.shopDomain, req.params.id); res.json({ ok: true }); });
app.post('/api/sync/shopify', requireShop, async function(req, res) {
  const result = await syncShopifyProducts(req.shopDomain, req.shopDomain, req.shop.access_token);
  res.json(result);
});

// ── Broadcasts ─────────────────────────────────────────────────────────────────
app.get('/api/broadcasts', requireShop, function(req, res) { res.json(db.getBroadcasts(req.shopDomain)); });
app.post('/api/broadcasts', requireShop, function(req, res) { res.json(db.createBroadcast(req.shopDomain, req.body)); });
app.post('/api/broadcasts/:id/send', requireShop, function(req, res) {
  res.json({ ok: true });
  sendBroadcast(req.shopDomain, parseInt(req.params.id), req.shop);
});

// ── Agents ─────────────────────────────────────────────────────────────────────
app.get('/api/agents', requireShop, function(req, res) { res.json(db.getAgents(req.shopDomain)); });
app.post('/api/agents', requireShop, function(req, res) { res.json(db.addAgent(req.shopDomain, req.body)); });

// ── Analytics ──────────────────────────────────────────────────────────────────
app.get('/api/analytics', requireShop, function(req, res) { res.json(db.getAnalytics(req.shopDomain, parseInt(req.query.days) || 7)); });

// ── WhatsApp webhooks ──────────────────────────────────────────────────────────
app.get('/webhook/whatsapp', function(req, res) {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const shop = db.db.prepare('SELECT * FROM shops WHERE wa_verify_token = ?').get(token);
  if (req.query['hub.mode'] === 'subscribe' && shop) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook/whatsapp', async function(req, res) {
  try {
    res.sendStatus(200);
    const value = req.body.entry && req.body.entry[0] && req.body.entry[0].changes && req.body.entry[0].changes[0] && req.body.entry[0].changes[0].value;
    if (!value) return;
    const messages = value.messages;
    const contacts = value.contacts;
    const phoneId = value.metadata && value.metadata.phone_number_id;
    if (!messages || !messages.length || messages[0].type !== 'text') return;
    const shop = phoneId ? db.db.prepare('SELECT * FROM shops WHERE wa_phone_id = ?').get(phoneId) : null;
    if (!shop) return console.warn('No shop for phone ID:', phoneId);
    await handleIncomingMessage(shop.shop_domain, messages[0], contacts && contacts[0], shop);
  } catch(e) { console.error('WA webhook error:', e); }
});

// ── Shopify order webhooks ─────────────────────────────────────────────────────
app.post('/webhook/shopify/order-created', async function(req, res) {
  res.sendStatus(200);
  const shopDomain = req.headers['x-shopify-shop-domain'];
  const shop = db.getShop(shopDomain);
  if (!shop) return;
  const order = req.body;
  const phone = (order.billing_address && order.billing_address.phone) || (order.shipping_address && order.shipping_address.phone) || order.phone;
  if (!phone) return;
  const name = (order.billing_address && order.billing_address.first_name) || 'there';
  const items = (order.line_items || []).map(function(i) { return '- ' + i.name + ' x' + i.quantity; }).join('\n');
  await sendMessage(phone, 'Hi ' + name + '! Your order #' + order.order_number + ' is confirmed!\n\n' + items + '\n\nTotal: ' + order.currency + ' ' + order.total_price + '\n\nWe will notify you when it ships.', shop);
});

app.post('/webhook/shopify/order-fulfilled', async function(req, res) {
  res.sendStatus(200);
  const shopDomain = req.headers['x-shopify-shop-domain'];
  const shop = db.getShop(shopDomain);
  if (!shop) return;
  const order = req.body;
  const phone = (order.billing_address && order.billing_address.phone) || (order.shipping_address && order.shipping_address.phone);
  if (!phone) return;
  const tracking = order.fulfillments && order.fulfillments[0] && order.fulfillments[0].tracking_number;
  await sendMessage(phone, 'Your order #' + order.order_number + ' is on its way!' + (tracking ? '\nTracking: ' + tracking : '') + '\nTrack: https://transexpress.lk', shop);
});

app.post('/webhook/shopify/checkout-abandoned', async function(req, res) {
  res.sendStatus(200);
  const shopDomain = req.headers['x-shopify-shop-domain'];
  if (!shopDomain) return;
  try { saveAbandonedCheckout(shopDomain, req.body); } catch(e) { console.error('Abandoned checkout save error:', e.message); }
});

app.listen(PORT, function() { console.log('WA Bot App v2 running on port ' + PORT); });

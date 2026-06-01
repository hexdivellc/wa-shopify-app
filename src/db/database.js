const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Store DB file in /data for Railway persistent volume, else local
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'wabot.db'));

// ── Enable WAL mode for better performance ─────────────────────────────────────
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Create all tables ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain  TEXT UNIQUE NOT NULL,
    access_token TEXT,
    brand        TEXT DEFAULT 'default',
    wa_token     TEXT,
    wa_phone_id  TEXT,
    wa_verify_token TEXT,
    ai_provider  TEXT DEFAULT 'gemini',
    anthropic_key TEXT,
    openai_key   TEXT,
    gemini_key   TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain  TEXT NOT NULL,
    phone        TEXT NOT NULL,
    name         TEXT,
    ai_enabled   INTEGER DEFAULT 1,
    escalated    INTEGER DEFAULT 0,
    assigned_agent INTEGER,
    state        TEXT DEFAULT 'idle',
    cart         TEXT DEFAULT '[]',
    temp_data    TEXT DEFAULT '{}',
    updated_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(shop_domain, phone)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain  TEXT NOT NULL,
    phone        TEXT NOT NULL,
    direction    TEXT CHECK(direction IN ('inbound','outbound')),
    text         TEXT,
    ai_provider  TEXT,
    ai_confidence REAL,
    escalated    INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain  TEXT NOT NULL,
    shopify_id   TEXT,
    name         TEXT NOT NULL,
    description  TEXT,
    images       TEXT DEFAULT '[]',
    variants     TEXT DEFAULT '[]',
    active       INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(shop_domain, shopify_id)
  );

  CREATE TABLE IF NOT EXISTS wa_orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain    TEXT NOT NULL,
    order_number   TEXT,
    phone          TEXT,
    customer_name  TEXT,
    address        TEXT,
    contact_number TEXT,
    payment_method TEXT,
    items          TEXT DEFAULT '[]',
    subtotal       REAL DEFAULT 0,
    shipping       REAL DEFAULT 350,
    total          REAL DEFAULT 0,
    status         TEXT DEFAULT 'new',
    source         TEXT DEFAULT 'whatsapp',
    notes          TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS broadcasts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain  TEXT NOT NULL,
    name         TEXT NOT NULL,
    message      TEXT NOT NULL,
    segment      TEXT DEFAULT 'all',
    status       TEXT DEFAULT 'draft',
    sent_count   INTEGER DEFAULT 0,
    total_count  INTEGER DEFAULT 0,
    scheduled_at TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain  TEXT NOT NULL,
    name         TEXT NOT NULL,
    email        TEXT,
    role         TEXT DEFAULT 'agent',
    active       INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain  TEXT DEFAULT '*',
    name         TEXT NOT NULL,
    email        TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role         TEXT DEFAULT 'agent',
    avatar_color TEXT DEFAULT '#008060',
    active       INTEGER DEFAULT 1,
    must_change_pw INTEGER DEFAULT 0,
    last_login   TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS team_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id    INTEGER NOT NULL,
    token        TEXT UNIQUE NOT NULL,
    expires_at   TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_training (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain  TEXT NOT NULL,
    brand        TEXT NOT NULL,
    type         TEXT,
    data         TEXT NOT NULL,
    active       INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_settings (
    shop_domain  TEXT PRIMARY KEY,
    global_ai_enabled  INTEGER DEFAULT 1,
    provider     TEXT DEFAULT 'gemini',
    keshya_ai    INTEGER DEFAULT 1,
    rawana_ai    INTEGER DEFAULT 1,
    vitaskin_ai  INTEGER DEFAULT 1,
    updated_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS abandoned_checkouts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain     TEXT NOT NULL,
    shopify_id      TEXT,
    phone           TEXT,
    email           TEXT,
    customer_name   TEXT,
    items           TEXT DEFAULT '[]',
    total           REAL DEFAULT 0,
    currency        TEXT DEFAULT 'LKR',
    recovery_url    TEXT,
    status          TEXT DEFAULT 'pending',
    sent_at         TEXT,
    recovered_at    TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(shop_domain, shopify_id)
  );

  CREATE TABLE IF NOT EXISTS abandoned_settings (
    shop_domain     TEXT PRIMARY KEY,
    enabled         INTEGER DEFAULT 1,
    delay_minutes   INTEGER DEFAULT 60,
    message_template TEXT DEFAULT 'Hi {{name}}! You left something behind. Complete your order: {{url}}',
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS upsell_maps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain  TEXT NOT NULL,
    trigger_product_id  INTEGER,
    trigger_product_name TEXT,
    upsell_product_id   INTEGER,
    upsell_product_name TEXT,
    message      TEXT,
    active       INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bundles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain  TEXT NOT NULL,
    shopify_id   TEXT,
    name         TEXT NOT NULL,
    description  TEXT,
    products     TEXT DEFAULT '[]',
    price        REAL DEFAULT 0,
    discount_pct REAL DEFAULT 0,
    active       INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS automation_settings (
    shop_domain          TEXT PRIMARY KEY,
    cod_confirm_enabled  INTEGER DEFAULT 1,
    cod_confirm_msg      TEXT DEFAULT 'Hi {{name}}! Your COD order #{{order}} is confirmed. Total: Rs.{{total}}. Delivery address: {{address}}. Reply YES to confirm or NO to update.',
    reorder_enabled      INTEGER DEFAULT 1,
    reorder_days         INTEGER DEFAULT 30,
    reorder_msg          TEXT DEFAULT 'Hi {{name}}! Running low on {{product}}? Reorder here: {{url}}',
    review_enabled       INTEGER DEFAULT 1,
    review_days          INTEGER DEFAULT 7,
    review_msg           TEXT DEFAULT 'Hi {{name}}! Hope you love your order! Would mean a lot if you left us a review: {{url}}',
    updated_at           TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trans_express_deliveries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain     TEXT NOT NULL,
    tracking_number TEXT NOT NULL,
    order_id        INTEGER,
    phone           TEXT,
    status          TEXT,
    last_update     TEXT,
    raw_data        TEXT,
    notified_at     TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(shop_domain, tracking_number)
  );

  CREATE INDEX IF NOT EXISTS idx_team_sessions_token ON team_sessions(token);
  CREATE INDEX IF NOT EXISTS idx_abandoned_shop ON abandoned_checkouts(shop_domain, status);
  CREATE INDEX IF NOT EXISTS idx_upsell_shop ON upsell_maps(shop_domain);
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(shop_domain, phone);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_phone ON wa_orders(shop_domain, phone);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON wa_orders(status);
  CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_domain);
  CREATE INDEX IF NOT EXISTS idx_trans_tracking ON trans_express_deliveries(tracking_number);

  CREATE TABLE IF NOT EXISTS review_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain     TEXT NOT NULL,
    phone           TEXT NOT NULL,
    tracking_number TEXT,
    deliver_date    TEXT,
    sent_at         TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(shop_domain, phone, tracking_number)
  );
`);

// ── Migrations — safely add new columns to existing databases ─────────────────
const migrations = [
  "ALTER TABLE team_members ADD COLUMN must_change_pw INTEGER DEFAULT 0",
  "ALTER TABLE team_members ADD COLUMN shop_domain TEXT DEFAULT '*'",
  "ALTER TABLE shops ADD COLUMN shop_name TEXT",
  "ALTER TABLE shops ADD COLUMN active INTEGER DEFAULT 1",
  "ALTER TABLE shops ADD COLUMN wati_endpoint TEXT",
  "ALTER TABLE shops ADD COLUMN wati_token TEXT",
  "UPDATE team_members SET must_change_pw=0 WHERE email='admin@wabot.com' AND must_change_pw=1",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch(e) { /* column already exists — ignore */ }
}
const j  = v => JSON.stringify(v);
const pj = v => { try { return JSON.parse(v || '[]'); } catch(e) { return v; } };

// ── Shop ───────────────────────────────────────────────────────────────────────
function getShop(domain) {
  return db.prepare('SELECT * FROM shops WHERE shop_domain = ?').get(domain);
}
function upsertShop(domain, data) {
  const fields = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(data), domain];
  db.prepare(`INSERT INTO shops (shop_domain, ${Object.keys(data).join(',')}) 
    VALUES (?, ${Object.keys(data).map(()=>'?').join(',')})
    ON CONFLICT(shop_domain) DO UPDATE SET ${fields}`)
    .run(domain, ...Object.values(data), ...vals.slice(0, -1));
  return getShop(domain);
}

// ── Contacts ───────────────────────────────────────────────────────────────────
function upsertContact(domain, phone, name) {
  db.prepare(`INSERT INTO contacts (shop_domain, phone, name, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(shop_domain, phone) DO UPDATE SET name = COALESCE(?, name), updated_at = datetime('now')`)
    .run(domain, phone, name, name);
}
function getContact(domain, phone) {
  const c = db.prepare('SELECT * FROM contacts WHERE shop_domain = ? AND phone = ?').get(domain, phone);
  if (c) { c.cart = pj(c.cart); c.temp_data = pj(c.temp_data); }
  return c;
}
function updateContactState(domain, phone, state, cart, temp_data) {
  db.prepare(`INSERT INTO contacts (shop_domain, phone, state, cart, temp_data, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(shop_domain, phone) DO UPDATE SET state=?, cart=?, temp_data=?, updated_at=datetime('now')`)
    .run(domain, phone, state, j(cart), j(temp_data), state, j(cart), j(temp_data));
}
function setAIMode(domain, phone, enabled) {
  db.prepare(`INSERT INTO contacts (shop_domain, phone, ai_enabled) VALUES (?, ?, ?)
    ON CONFLICT(shop_domain, phone) DO UPDATE SET ai_enabled = ?`)
    .run(domain, phone, enabled ? 1 : 0, enabled ? 1 : 0);
}
function setEscalated(domain, phone, escalated) {
  db.prepare(`INSERT INTO contacts (shop_domain, phone, escalated) VALUES (?, ?, ?)
    ON CONFLICT(shop_domain, phone) DO UPDATE SET escalated = ?`)
    .run(domain, phone, escalated ? 1 : 0, escalated ? 1 : 0);
}
function getAllConversations(domain) {
  return db.prepare(`
    SELECT c.*, 
      (SELECT text FROM messages m WHERE m.shop_domain=c.shop_domain AND m.phone=c.phone ORDER BY m.created_at DESC LIMIT 1) as last_message,
      (SELECT created_at FROM messages m WHERE m.shop_domain=c.shop_domain AND m.phone=c.phone ORDER BY m.created_at DESC LIMIT 1) as last_message_at,
      (SELECT COUNT(*) FROM messages m WHERE m.shop_domain=c.shop_domain AND m.phone=c.phone) as message_count
    FROM contacts c WHERE c.shop_domain = ? ORDER BY last_message_at DESC
  `).all(domain);
}

// ── Messages ───────────────────────────────────────────────────────────────────
function saveMessage(domain, { phone, direction, text, ai_provider, ai_confidence, escalated }) {
  db.prepare('INSERT INTO messages (shop_domain, phone, direction, text, ai_provider, ai_confidence, escalated) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(domain, phone, direction, text, ai_provider || null, ai_confidence || null, escalated ? 1 : 0);
}
function getConversation(domain, phone, limit = 50) {
  return db.prepare('SELECT * FROM messages WHERE shop_domain = ? AND phone = ? ORDER BY created_at ASC LIMIT ?')
    .all(domain, phone, limit);
}

// ── Products ───────────────────────────────────────────────────────────────────
function getProducts(domain) {
  return db.prepare('SELECT * FROM products WHERE shop_domain = ? AND active = 1 ORDER BY id').all(domain)
    .map(p => ({ ...p, variants: pj(p.variants), images: pj(p.images) }));
}
function upsertProduct(domain, p) {
  db.prepare(`INSERT INTO products (shop_domain, shopify_id, name, description, images, variants, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(shop_domain, shopify_id) DO UPDATE SET name=?, description=?, images=?, variants=?, active=1`)
    .run(domain, p.shopify_id, p.name, p.description, j(p.images), j(p.variants), p.name, p.description, j(p.images), j(p.variants));
}
function addProduct(domain, p) {
  return db.prepare('INSERT INTO products (shop_domain, name, description, images, variants) VALUES (?, ?, ?, ?, ?)')
    .run(domain, p.name, p.description || '', j(p.images || []), j(p.variants || []));
}
function updateProduct(domain, id, p) {
  db.prepare('UPDATE products SET name=?, description=?, variants=?, active=? WHERE id=? AND shop_domain=?')
    .run(p.name, p.description || '', j(p.variants || []), p.active !== false ? 1 : 0, id, domain);
}
function deleteProduct(domain, id) {
  db.prepare('UPDATE products SET active = 0 WHERE id = ? AND shop_domain = ?').run(id, domain);
}

// ── WA Orders ──────────────────────────────────────────────────────────────────
function createWAOrder(domain, data) {
  const { lastInsertRowid } = db.prepare(`INSERT INTO wa_orders 
    (shop_domain, order_number, phone, customer_name, address, contact_number, payment_method, items, subtotal, shipping, total, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`)
    .run(domain, data.order_number, data.phone, data.name, data.address, data.contact, data.payment,
      j(data.cart || []), data.subtotal, 350, data.total);
  return db.prepare('SELECT * FROM wa_orders WHERE id = ?').get(lastInsertRowid);
}
function getWAOrders(domain, status) {
  const q = status
    ? 'SELECT * FROM wa_orders WHERE shop_domain = ? AND status = ? ORDER BY created_at DESC LIMIT 200'
    : 'SELECT * FROM wa_orders WHERE shop_domain = ? ORDER BY created_at DESC LIMIT 200';
  return db.prepare(q).all(domain, ...(status ? [status] : []))
    .map(o => ({ ...o, items: pj(o.items) }));
}
function updateOrderStatus(domain, id, status) {
  db.prepare("UPDATE wa_orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND shop_domain = ?")
    .run(status, id, domain);
  return db.prepare('SELECT * FROM wa_orders WHERE id = ?').get(id);
}
function getOrdersByPhone(domain, phone) {
  return db.prepare('SELECT * FROM wa_orders WHERE shop_domain = ? AND phone = ? ORDER BY created_at DESC')
    .all(domain, phone).map(o => ({ ...o, items: pj(o.items) }));
}

// ── Broadcasts ─────────────────────────────────────────────────────────────────
function createBroadcast(domain, data) {
  const { lastInsertRowid } = db.prepare('INSERT INTO broadcasts (shop_domain, name, message, segment, scheduled_at) VALUES (?, ?, ?, ?, ?)')
    .run(domain, data.name, data.message, data.segment || 'all', data.scheduled_at || null);
  return db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(lastInsertRowid);
}
function getBroadcasts(domain) {
  return db.prepare('SELECT * FROM broadcasts WHERE shop_domain = ? ORDER BY created_at DESC').all(domain);
}
function updateBroadcast(id, data) {
  db.prepare('UPDATE broadcasts SET status=?, sent_count=?, total_count=? WHERE id=?')
    .run(data.status, data.sent_count, data.total_count, id);
}

// ── Agents ─────────────────────────────────────────────────────────────────────
function getAgents(domain) {
  return db.prepare('SELECT * FROM agents WHERE shop_domain = ? AND active = 1').all(domain);
}
function addAgent(domain, data) {
  const { lastInsertRowid } = db.prepare('INSERT INTO agents (shop_domain, name, email, role) VALUES (?, ?, ?, ?)')
    .run(domain, data.name, data.email || null, data.role || 'agent');
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(lastInsertRowid);
}

// ── Analytics ──────────────────────────────────────────────────────────────────
function getAnalytics(domain, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const msgs = db.prepare('SELECT direction, escalated FROM messages WHERE shop_domain = ? AND created_at >= ?').all(domain, since);
  const orders = db.prepare('SELECT total FROM wa_orders WHERE shop_domain = ? AND created_at >= ?').all(domain, since);
  return {
    inbound:      msgs.filter(m => m.direction === 'inbound').length,
    outbound:     msgs.filter(m => m.direction === 'outbound').length,
    escalated:    msgs.filter(m => m.escalated).length,
    totalOrders:  orders.length,
    totalRevenue: orders.reduce((s, o) => s + (o.total || 0), 0),
    days,
  };
}

module.exports = {
  db, getShop, upsertShop,
  upsertContact, getContact, updateContactState, setAIMode, setEscalated, getAllConversations,
  saveMessage, getConversation,
  getProducts, upsertProduct, addProduct, updateProduct, deleteProduct,
  createWAOrder, getWAOrders, updateOrderStatus, getOrdersByPhone,
  createBroadcast, getBroadcasts, updateBroadcast,
  getAgents, addAgent,
  getAnalytics,
};

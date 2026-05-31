-- Run this in Supabase SQL Editor (or add to SQLite schema in database.js)
-- Schema v4 additions

-- Team members with roles
CREATE TABLE IF NOT EXISTS team_members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_domain  TEXT NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role         TEXT DEFAULT 'agent' CHECK(role IN ('admin','agent','viewer')),
  avatar_color TEXT DEFAULT '#4f7fff',
  active       INTEGER DEFAULT 1,
  last_login   TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(shop_domain, email)
);

-- Team sessions
CREATE TABLE IF NOT EXISTS team_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_domain  TEXT NOT NULL,
  member_id    INTEGER NOT NULL,
  token        TEXT UNIQUE NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- AI training data per brand
CREATE TABLE IF NOT EXISTS ai_training (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_domain  TEXT NOT NULL,
  brand        TEXT NOT NULL,
  type         TEXT CHECK(type IN ('personality','faq','rule')),
  -- personality: {tone, name, language, description}
  -- faq: {question, answer}
  -- rule: {trigger, response, priority}
  data         TEXT NOT NULL,
  active       INTEGER DEFAULT 1,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- AI global settings per shop
CREATE TABLE IF NOT EXISTS ai_settings (
  shop_domain  TEXT PRIMARY KEY,
  global_ai_enabled  INTEGER DEFAULT 1,
  provider     TEXT DEFAULT 'gemini',
  keshya_ai    INTEGER DEFAULT 1,
  rawana_ai    INTEGER DEFAULT 1,
  vitaskin_ai  INTEGER DEFAULT 1,
  updated_at   TEXT DEFAULT (datetime('now'))
);

-- Abandoned checkouts
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
  status          TEXT DEFAULT 'pending', -- pending|sent|recovered|ignored
  sent_at         TEXT,
  recovered_at    TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(shop_domain, shopify_id)
);

-- Abandoned checkout settings per shop
CREATE TABLE IF NOT EXISTS abandoned_settings (
  shop_domain     TEXT PRIMARY KEY,
  enabled         INTEGER DEFAULT 1,
  delay_minutes   INTEGER DEFAULT 60,
  message_template TEXT DEFAULT 'Hi {{name}}! You left something in your cart. Complete your order here: {{url}}',
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- Upsell mappings
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

-- Bundles (synced from Katching or manual)
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_team_sessions_token ON team_sessions(token);
CREATE INDEX IF NOT EXISTS idx_ai_training_shop ON ai_training(shop_domain, brand, type);
CREATE INDEX IF NOT EXISTS idx_abandoned_shop ON abandoned_checkouts(shop_domain, status);
CREATE INDEX IF NOT EXISTS idx_upsell_shop ON upsell_maps(shop_domain);

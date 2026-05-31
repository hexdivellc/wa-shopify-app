const { sendMessage } = require('../whatsapp');

function setupAbandonedRoutes(app, db, requireAuth) {

  // ── List abandoned checkouts ───────────────────────────────────────────────
  app.get('/api/abandoned', requireAuth(), function(req, res) {
    const { status } = req.query;
    let q = 'SELECT * FROM abandoned_checkouts WHERE shop_domain = ?';
    const params = [req.shopDomain];
    if (status) { q += ' AND status = ?'; params.push(status); }
    q += ' ORDER BY created_at DESC LIMIT 100';
    const rows = db.db.prepare(q).all(...params).map(r => ({ ...r, items: JSON.parse(r.items || '[]') }));
    res.json(rows);
  });

  // ── Get/set abandoned settings ────────────────────────────────────────────
  app.get('/api/abandoned/settings', requireAuth(), function(req, res) {
    const s = db.db.prepare('SELECT * FROM abandoned_settings WHERE shop_domain = ?').get(req.shopDomain);
    res.json(s || { enabled: 1, delay_minutes: 60, message_template: 'Hi {{name}}! You left something behind. Complete your order: {{url}}' });
  });

  app.post('/api/abandoned/settings', requireAuth(['admin']), function(req, res) {
    const { enabled, delay_minutes, message_template } = req.body;
    db.db.prepare(`INSERT INTO abandoned_settings (shop_domain, enabled, delay_minutes, message_template, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(shop_domain) DO UPDATE SET enabled=?, delay_minutes=?, message_template=?, updated_at=datetime('now')`)
      .run(req.shopDomain, enabled?1:0, delay_minutes||60, message_template, enabled?1:0, delay_minutes||60, message_template);
    res.json({ ok: true });
  });

  // ── Mark as ignored ────────────────────────────────────────────────────────
  app.patch('/api/abandoned/:id/ignore', requireAuth(['admin','agent']), function(req, res) {
    db.db.prepare("UPDATE abandoned_checkouts SET status='ignored' WHERE id=? AND shop_domain=?").run(req.params.id, req.shopDomain);
    res.json({ ok: true });
  });

  // ── Manual send recovery message ───────────────────────────────────────────
  app.post('/api/abandoned/:id/send', requireAuth(['admin','agent']), async function(req, res) {
    const checkout = db.db.prepare('SELECT * FROM abandoned_checkouts WHERE id=? AND shop_domain=?').get(req.params.id, req.shopDomain);
    if (!checkout) return res.status(404).json({ error: 'Not found' });
    const shop = db.getShop(req.shopDomain);
    await sendRecoveryMessage(checkout, shop, db);
    res.json({ ok: true });
  });

  // ── Analytics ──────────────────────────────────────────────────────────────
  app.get('/api/abandoned/analytics', requireAuth(), function(req, res) {
    const total     = db.db.prepare("SELECT COUNT(*) as c FROM abandoned_checkouts WHERE shop_domain=?").get(req.shopDomain).c;
    const sent      = db.db.prepare("SELECT COUNT(*) as c FROM abandoned_checkouts WHERE shop_domain=? AND status='sent'").get(req.shopDomain).c;
    const recovered = db.db.prepare("SELECT COUNT(*) as c FROM abandoned_checkouts WHERE shop_domain=? AND status='recovered'").get(req.shopDomain).c;
    const revenue   = db.db.prepare("SELECT COALESCE(SUM(total),0) as r FROM abandoned_checkouts WHERE shop_domain=? AND status='recovered'").get(req.shopDomain).r;
    res.json({ total, sent, recovered, revenue, recovery_rate: sent > 0 ? Math.round(recovered/sent*100) : 0 });
  });
}

// ── Save abandoned checkout from Shopify webhook ──────────────────────────
function saveAbandonedCheckout(shopDomain, checkout) {
  const phone = checkout.billing_address?.phone || checkout.shipping_address?.phone || checkout.phone;
  const name  = checkout.billing_address?.first_name || checkout.email?.split('@')[0] || 'there';
  try {
    db_instance.db.prepare(`INSERT OR IGNORE INTO abandoned_checkouts
      (shop_domain, shopify_id, phone, email, customer_name, items, total, currency, recovery_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(shopDomain, String(checkout.id), phone, checkout.email||null, name,
        JSON.stringify((checkout.line_items||[]).map(i=>({name:i.title,qty:i.quantity,price:parseFloat(i.price||0)}))),
        parseFloat(checkout.total_price||0), checkout.currency||'LKR', checkout.abandoned_checkout_url||'');
  } catch(e) { console.error('Save abandoned checkout error:', e.message); }
}

// ── Send recovery WA message ──────────────────────────────────────────────
async function sendRecoveryMessage(checkout, shop, db) {
  if (!checkout.phone) return;
  const settings = db.db.prepare('SELECT * FROM abandoned_settings WHERE shop_domain=?').get(checkout.shop_domain);
  const template = settings?.message_template || 'Hi {{name}}! You left something behind. Complete your order: {{url}}';
  const items = (typeof checkout.items === 'string' ? JSON.parse(checkout.items) : checkout.items || [])
    .map(i => `• ${i.name} x${i.qty}`).join('\n');
  const msg = template
    .replace('{{name}}', checkout.customer_name || 'there')
    .replace('{{url}}', checkout.recovery_url || '')
    .replace('{{items}}', items)
    .replace('{{total}}', `${checkout.currency} ${checkout.total}`);
  await sendMessage(checkout.phone, msg, shop);
  db.db.prepare("UPDATE abandoned_checkouts SET status='sent', sent_at=datetime('now') WHERE id=?").run(checkout.id);
}

// ── Scheduler — check every minute for checkouts ready to send ────────────
let db_instance = null;
function startAbandonedScheduler(db, getShop) {
  db_instance = db;
  setInterval(async function() {
    try {
      // Get all shops with abandoned checkout enabled
      const settings = db.db.prepare("SELECT * FROM abandoned_settings WHERE enabled=1").all();
      for (const s of settings) {
        const delay = s.delay_minutes || 60;
        const cutoff = new Date(Date.now() - delay * 60 * 1000).toISOString();
        const pending = db.db.prepare(`
          SELECT * FROM abandoned_checkouts
          WHERE shop_domain=? AND status='pending' AND phone IS NOT NULL AND created_at <= ?
          LIMIT 10
        `).all(s.shop_domain, cutoff);
        for (const checkout of pending) {
          const shop = getShop(s.shop_domain);
          if (shop) await sendRecoveryMessage(checkout, shop, db);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } catch(e) { console.error('Abandoned scheduler error:', e.message); }
  }, 60000);
}

module.exports = { setupAbandonedRoutes, saveAbandonedCheckout, startAbandonedScheduler, sendRecoveryMessage };

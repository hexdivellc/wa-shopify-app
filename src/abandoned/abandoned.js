const { sendMessage } = require('../whatsapp');

function saveAbandonedCheckout(shopDomain, checkout) {
  const db = require('../db/database');
  const phone = checkout.billing_address?.phone || checkout.shipping_address?.phone || checkout.phone || null;
  const name  = checkout.billing_address?.first_name || checkout.email?.split('@')[0] || 'there';
  try {
    db.db.prepare(`INSERT OR IGNORE INTO abandoned_checkouts (shop_domain,shopify_id,phone,email,customer_name,items,total,currency,recovery_url) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(shopDomain, String(checkout.id), phone, checkout.email||null, name, JSON.stringify((checkout.line_items||[]).map(i=>({name:i.title,qty:i.quantity,price:parseFloat(i.price||0)}))), parseFloat(checkout.total_price||0), checkout.currency||'LKR', checkout.abandoned_checkout_url||'');
  } catch(e) { console.error('[Abandoned]', e.message); }
}

function setupAbandonedRoutes(app, db, requireAuth) {
  app.get('/api/abandoned', requireAuth(), function(req, res) {
    const domain = req.activeDomain; if (!domain) return res.json([]);
    const { status } = req.query;
    const q = status ? 'SELECT * FROM abandoned_checkouts WHERE shop_domain=? AND status=? ORDER BY created_at DESC LIMIT 100' : 'SELECT * FROM abandoned_checkouts WHERE shop_domain=? ORDER BY created_at DESC LIMIT 100';
    res.json(db.db.prepare(q).all(domain, ...(status?[status]:[])).map(r => ({...r, items: JSON.parse(r.items||'[]')})));
  });
  app.get('/api/abandoned/settings', requireAuth(), function(req, res) {
    const domain = req.activeDomain; if (!domain) return res.json({enabled:1,delay_minutes:60,message_template:'Hi {{name}}! You left something behind. Complete your order: {{url}}'});
    res.json(db.db.prepare('SELECT * FROM abandoned_settings WHERE shop_domain=?').get(domain) || {enabled:1,delay_minutes:60,message_template:'Hi {{name}}! You left something behind. Complete your order: {{url}}'});
  });
  app.post('/api/abandoned/settings', requireAuth(['admin']), function(req, res) {
    const domain = req.activeDomain; if (!domain) return res.status(400).json({error:'No active shop'});
    const { enabled, delay_minutes, message_template } = req.body;
    db.db.prepare(`INSERT INTO abandoned_settings (shop_domain,enabled,delay_minutes,message_template,updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(shop_domain) DO UPDATE SET enabled=?,delay_minutes=?,message_template=?,updated_at=datetime('now')`).run(domain,enabled?1:0,delay_minutes||60,message_template,enabled?1:0,delay_minutes||60,message_template);
    res.json({ok:true});
  });
  app.patch('/api/abandoned/:id/ignore', requireAuth(['admin','agent']), function(req, res) {
    const domain = req.activeDomain; if (!domain) return res.status(400).json({error:'No active shop'});
    db.db.prepare("UPDATE abandoned_checkouts SET status='ignored' WHERE id=? AND shop_domain=?").run(req.params.id, domain);
    res.json({ok:true});
  });
  app.post('/api/abandoned/:id/send', requireAuth(['admin','agent']), async function(req, res) {
    const domain = req.activeDomain; if (!domain) return res.status(400).json({error:'No active shop'});
    const checkout = db.db.prepare('SELECT * FROM abandoned_checkouts WHERE id=? AND shop_domain=?').get(req.params.id, domain);
    if (!checkout) return res.status(404).json({error:'Not found'});
    const shop = db.getShop(domain);
    const settings = db.db.prepare('SELECT * FROM abandoned_settings WHERE shop_domain=?').get(domain);
    const template = settings?.message_template || 'Hi {{name}}! You left something behind. Complete your order: {{url}}';
    const msg = template.replace('{{name}}', checkout.customer_name||'there').replace('{{url}}', checkout.recovery_url||'');
    await sendMessage(checkout.phone, msg, shop);
    db.db.prepare("UPDATE abandoned_checkouts SET status='sent',sent_at=datetime('now') WHERE id=?").run(checkout.id);
    res.json({ok:true});
  });
  app.get('/api/abandoned/analytics', requireAuth(), function(req, res) {
    const domain = req.activeDomain; if (!domain) return res.json({total:0,sent:0,recovered:0,revenue:0,recovery_rate:0});
    const total     = db.db.prepare("SELECT COUNT(*) as c FROM abandoned_checkouts WHERE shop_domain=?").get(domain).c;
    const sent      = db.db.prepare("SELECT COUNT(*) as c FROM abandoned_checkouts WHERE shop_domain=? AND status='sent'").get(domain).c;
    const recovered = db.db.prepare("SELECT COUNT(*) as c FROM abandoned_checkouts WHERE shop_domain=? AND status='recovered'").get(domain).c;
    const revenue   = db.db.prepare("SELECT COALESCE(SUM(total),0) as r FROM abandoned_checkouts WHERE shop_domain=? AND status='recovered'").get(domain).r;
    res.json({total,sent,recovered,revenue,recovery_rate:sent>0?Math.round(recovered/sent*100):0});
  });

  // Scheduler
  setInterval(async function() {
    try {
      const settings = db.db.prepare("SELECT * FROM abandoned_settings WHERE enabled=1").all();
      for (const s of settings) {
        const cutoff = new Date(Date.now() - (s.delay_minutes||60)*60000).toISOString();
        const pending = db.db.prepare("SELECT * FROM abandoned_checkouts WHERE shop_domain=? AND status='pending' AND phone IS NOT NULL AND created_at<=? LIMIT 5").all(s.shop_domain, cutoff);
        for (const c of pending) {
          const shop = db.getShop(s.shop_domain);
          if (!shop) continue;
          const msg = (s.message_template||'Hi {{name}}! You left something behind. Complete your order: {{url}}').replace('{{name}}', c.customer_name||'there').replace('{{url}}', c.recovery_url||'');
          await sendMessage(c.phone, msg, shop);
          db.db.prepare("UPDATE abandoned_checkouts SET status='sent',sent_at=datetime('now') WHERE id=?").run(c.id);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    } catch(e) { console.error('[Abandoned scheduler]', e.message); }
  }, 60000);
}

module.exports = { setupAbandonedRoutes, saveAbandonedCheckout };

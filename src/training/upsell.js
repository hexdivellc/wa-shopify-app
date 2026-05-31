function setupUpsellRoutes(app, db, requireAuth) {

  // ── Upsell maps ────────────────────────────────────────────────────────────
  app.get('/api/upsells', requireAuth(), function(req, res) {
    res.json(db.db.prepare('SELECT * FROM upsell_maps WHERE shop_domain=? AND active=1 ORDER BY id').all(req.shopDomain));
  });

  app.post('/api/upsells', requireAuth(['admin']), function(req, res) {
    const { trigger_product_id, trigger_product_name, upsell_product_id, upsell_product_name, message } = req.body;
    db.db.prepare('INSERT INTO upsell_maps (shop_domain, trigger_product_id, trigger_product_name, upsell_product_id, upsell_product_name, message) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.shopDomain, trigger_product_id, trigger_product_name, upsell_product_id, upsell_product_name, message || '');
    res.json({ ok: true });
  });

  app.patch('/api/upsells/:id', requireAuth(['admin']), function(req, res) {
    const { message, active } = req.body;
    db.db.prepare('UPDATE upsell_maps SET message=?, active=? WHERE id=? AND shop_domain=?').run(message, active?1:0, req.params.id, req.shopDomain);
    res.json({ ok: true });
  });

  app.delete('/api/upsells/:id', requireAuth(['admin']), function(req, res) {
    db.db.prepare('UPDATE upsell_maps SET active=0 WHERE id=? AND shop_domain=?').run(req.params.id, req.shopDomain);
    res.json({ ok: true });
  });

  // ── Bundles ────────────────────────────────────────────────────────────────
  app.get('/api/bundles', requireAuth(), function(req, res) {
    const rows = db.db.prepare('SELECT * FROM bundles WHERE shop_domain=? AND active=1 ORDER BY id').all(req.shopDomain);
    res.json(rows.map(r => ({ ...r, products: JSON.parse(r.products || '[]') })));
  });

  app.post('/api/bundles', requireAuth(['admin']), function(req, res) {
    const { name, description, products, price, discount_pct, shopify_id } = req.body;
    db.db.prepare('INSERT INTO bundles (shop_domain, shopify_id, name, description, products, price, discount_pct) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.shopDomain, shopify_id||null, name, description||'', JSON.stringify(products||[]), price||0, discount_pct||0);
    res.json({ ok: true });
  });

  app.patch('/api/bundles/:id', requireAuth(['admin']), function(req, res) {
    const { name, description, products, price, discount_pct, active } = req.body;
    db.db.prepare('UPDATE bundles SET name=?, description=?, products=?, price=?, discount_pct=?, active=? WHERE id=? AND shop_domain=?')
      .run(name, description||'', JSON.stringify(products||[]), price||0, discount_pct||0, active?1:0, req.params.id, req.shopDomain);
    res.json({ ok: true });
  });

  app.delete('/api/bundles/:id', requireAuth(['admin']), function(req, res) {
    db.db.prepare('UPDATE bundles SET active=0 WHERE id=? AND shop_domain=?').run(req.params.id, req.shopDomain);
    res.json({ ok: true });
  });

  // ── Sync bundles from Katching/Shopify ─────────────────────────────────────
  app.post('/api/bundles/sync', requireAuth(['admin']), async function(req, res) {
    const shop = db.getShop(req.shopDomain);
    if (!shop?.access_token) return res.status(400).json({ error: 'No Shopify access token' });
    try {
      const axios = require('axios');
      // Katching bundles appear as products with type "Bundle" in Shopify
      const r = await axios.get(`https://${req.shopDomain}/admin/api/2024-01/products.json?product_type=Bundle&limit=100`, {
        headers: { 'X-Shopify-Access-Token': shop.access_token }
      });
      let synced = 0;
      for (const p of (r.data.products || [])) {
        const price = parseFloat(p.variants?.[0]?.price || 0);
        // Try to extract bundle products from metafields or description
        db.db.prepare(`INSERT OR REPLACE INTO bundles (shop_domain, shopify_id, name, description, price, active)
          VALUES (?, ?, ?, ?, ?, 1)`)
          .run(req.shopDomain, String(p.id), p.title, (p.body_html||'').replace(/<[^>]*>/g,'').substring(0,200), price);
        synced++;
      }
      res.json({ ok: true, synced });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// ── Get upsell suggestion for a product ───────────────────────────────────
function getUpsellForProduct(shopDomain, productId, db) {
  return db.db.prepare('SELECT * FROM upsell_maps WHERE shop_domain=? AND trigger_product_id=? AND active=1 LIMIT 1').get(shopDomain, productId);
}

module.exports = { setupUpsellRoutes, getUpsellForProduct };

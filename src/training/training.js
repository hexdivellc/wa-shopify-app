function setupTrainingRoutes(app, db, requireAuth) {
  app.get('/api/training', requireAuth(['admin']), function(req, res) {
    const d = req.activeDomain; if (!d) return res.json([]);
    const { brand, type } = req.query;
    let q = 'SELECT * FROM ai_training WHERE shop_domain=? AND active=1'; const p = [d];
    if (brand) { q += ' AND brand=?'; p.push(brand); }
    if (type)  { q += ' AND type=?';  p.push(type);  }
    res.json(db.db.prepare(q+' ORDER BY created_at DESC').all(...p).map(r=>({...r,data:JSON.parse(r.data)})));
  });
  app.post('/api/training', requireAuth(['admin']), function(req, res) {
    const d = req.activeDomain; if (!d) return res.status(400).json({error:'No active shop'});
    const { brand, type, data } = req.body;
    db.db.prepare('INSERT INTO ai_training (shop_domain,brand,type,data) VALUES (?,?,?,?)').run(d, brand, type, JSON.stringify(data));
    res.json({ok:true});
  });
  app.patch('/api/training/:id', requireAuth(['admin']), function(req, res) {
    const d = req.activeDomain; if (!d) return res.status(400).json({error:'No active shop'});
    db.db.prepare('UPDATE ai_training SET data=?,active=? WHERE id=? AND shop_domain=?').run(JSON.stringify(req.body.data), req.body.active!==false?1:0, req.params.id, d);
    res.json({ok:true});
  });
  app.delete('/api/training/:id', requireAuth(['admin']), function(req, res) {
    const d = req.activeDomain; if (!d) return res.status(400).json({error:'No active shop'});
    db.db.prepare('UPDATE ai_training SET active=0 WHERE id=? AND shop_domain=?').run(req.params.id, d);
    res.json({ok:true});
  });
  app.get('/api/ai-settings', requireAuth(), function(req, res) {
    const d = req.activeDomain; if (!d) return res.json({global_ai_enabled:1,keshya_ai:1,rawana_ai:1,vitaskin_ai:1,provider:'gemini'});
    res.json(db.db.prepare('SELECT * FROM ai_settings WHERE shop_domain=?').get(d) || {global_ai_enabled:1,keshya_ai:1,rawana_ai:1,vitaskin_ai:1,provider:'gemini'});
  });
  app.post('/api/ai-settings', requireAuth(['admin']), function(req, res) {
    const d = req.activeDomain; if (!d) return res.status(400).json({error:'No active shop'});
    const { global_ai_enabled, provider, keshya_ai, rawana_ai, vitaskin_ai } = req.body;
    db.db.prepare(`INSERT INTO ai_settings (shop_domain,global_ai_enabled,provider,keshya_ai,rawana_ai,vitaskin_ai,updated_at) VALUES (?,?,?,?,?,?,datetime('now')) ON CONFLICT(shop_domain) DO UPDATE SET global_ai_enabled=?,provider=?,keshya_ai=?,rawana_ai=?,vitaskin_ai=?,updated_at=datetime('now')`)
      .run(d,global_ai_enabled?1:0,provider,keshya_ai?1:0,rawana_ai?1:0,vitaskin_ai?1:0,global_ai_enabled?1:0,provider,keshya_ai?1:0,rawana_ai?1:0,vitaskin_ai?1:0);
    res.json({ok:true});
  });
}

function setupUpsellRoutes(app, db, requireAuth) {
  app.get('/api/upsells', requireAuth(), function(req, res) {
    const d = req.activeDomain; if (!d) return res.json([]);
    res.json(db.db.prepare('SELECT * FROM upsell_maps WHERE shop_domain=? AND active=1').all(d));
  });
  app.post('/api/upsells', requireAuth(['admin']), function(req, res) {
    const d = req.activeDomain; if (!d) return res.status(400).json({error:'No active shop'});
    db.db.prepare('INSERT INTO upsell_maps (shop_domain,trigger_product_name,upsell_product_name,message) VALUES (?,?,?,?)').run(d, req.body.trigger_product_name, req.body.upsell_product_name, req.body.message||'');
    res.json({ok:true});
  });
  app.delete('/api/upsells/:id', requireAuth(['admin']), function(req, res) {
    const d = req.activeDomain; if (!d) return res.status(400).json({error:'No active shop'});
    db.db.prepare('UPDATE upsell_maps SET active=0 WHERE id=? AND shop_domain=?').run(req.params.id, d);
    res.json({ok:true});
  });
  app.get('/api/bundles', requireAuth(), function(req, res) {
    const d = req.activeDomain; if (!d) return res.json([]);
    res.json(db.db.prepare('SELECT * FROM bundles WHERE shop_domain=? AND active=1').all(d).map(b=>({...b,products:JSON.parse(b.products||'[]')})));
  });
  app.post('/api/bundles', requireAuth(['admin']), function(req, res) {
    const d = req.activeDomain; if (!d) return res.status(400).json({error:'No active shop'});
    db.db.prepare('INSERT INTO bundles (shop_domain,name,description,price,discount_pct,products) VALUES (?,?,?,?,?,?)').run(d, req.body.name, req.body.description||'', req.body.price||0, req.body.discount_pct||0, JSON.stringify(req.body.products||[]));
    res.json({ok:true});
  });
  app.delete('/api/bundles/:id', requireAuth(['admin']), function(req, res) {
    const d = req.activeDomain; if (!d) return res.status(400).json({error:'No active shop'});
    db.db.prepare('UPDATE bundles SET active=0 WHERE id=? AND shop_domain=?').run(req.params.id, d);
    res.json({ok:true});
  });
  // Sync Katching bundles from Shopify (product_type = Bundle)
  app.post('/api/bundles/sync', requireAuth(['admin']), async function(req, res) {
    const d = req.activeDomain; if (!d) return res.status(400).json({error:'No active shop'});
    const shop = db.getShop(d);
    if (!shop?.access_token) return res.status(400).json({error:'No Shopify access token'});
    try {
      const axios = require('axios');
      const r = await axios.get(`https://${d}/admin/api/2024-01/products.json?product_type=Bundle&limit=100`, { headers: { 'X-Shopify-Access-Token': shop.access_token } });
      let synced = 0;
      for (const p of (r.data.products||[])) {
        const price = parseFloat(p.variants?.[0]?.price||0);
        db.db.prepare(`INSERT OR REPLACE INTO bundles (shop_domain,shopify_id,name,description,price,active) VALUES (?,?,?,?,?,1)`).run(d, String(p.id), p.title, (p.body_html||'').replace(/<[^>]*>/g,'').substring(0,200), price);
        synced++;
      }
      res.json({ok:true,synced});
    } catch(e) { res.status(500).json({error:e.message}); }
  });
}

module.exports = { setupTrainingRoutes, setupUpsellRoutes };

const axios = require('axios');
const db = require('../db/database');

async function syncShopifyProducts(domain, shopifyDomain, accessToken) {
  if (!shopifyDomain || !accessToken) {
    return { synced: 0, message: 'No Shopify credentials — add them in Settings' };
  }
  console.log(`🔄 Syncing products from ${shopifyDomain}...`);
  try {
    const res = await axios.get(`https://${shopifyDomain}/admin/api/2024-01/products.json?limit=250&status=active`, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    });
    const products = res.data.products || [];
    let synced = 0;
    for (const p of products) {
      db.upsertProduct(domain, {
        shopify_id:  String(p.id),
        name:        p.title,
        description: (p.body_html || '').replace(/<[^>]*>/g,'').substring(0,300),
        images:      (p.images || []).map(i => i.src),
        variants:    (p.variants || []).map(v => ({
          name:  v.title === 'Default Title' ? 'Standard' : v.title,
          price: parseFloat(v.price || 0),
          stock: v.inventory_quantity ?? 99,
          sku:   v.sku || '',
        })),
      });
      synced++;
    }
    console.log(`✅ Synced ${synced} products`);
    return { synced, total: products.length };
  } catch(e) {
    console.error('Sync error:', e.response?.data || e.message);
    return { synced: 0, error: e.message };
  }
}

module.exports = { syncShopifyProducts };

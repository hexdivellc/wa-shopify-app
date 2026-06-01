const axios = require('axios');
const db = require('../db/database');

async function syncShopifyProducts(domain, shopifyDomain, accessToken) {
  if (!accessToken) return { synced: 0, message: 'No Shopify access token' };
  try {
    const r = await axios.get(`https://${shopifyDomain}/admin/api/2024-01/products.json?limit=250&status=active`, { headers: { 'X-Shopify-Access-Token': accessToken } });
    let synced = 0;
    for (const p of (r.data.products||[])) {
      db.upsertProduct(domain, { shopify_id: String(p.id), name: p.title, description: (p.body_html||'').replace(/<[^>]*>/g,'').substring(0,300), images: (p.images||[]).map(i=>i.src), variants: (p.variants||[]).map(v => ({ name: v.title==='Default Title'?'Standard':v.title, price: parseFloat(v.price||0), stock: v.inventory_quantity??99, sku: v.sku||'' })) });
      synced++;
    }
    return { synced };
  } catch(e) { return { synced: 0, error: e.message }; }
}

module.exports = { syncShopifyProducts };

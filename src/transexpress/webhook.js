const { sendMessage } = require('../whatsapp');

const STATUS_MSGS = {
  'Processing':                           (n,t) => `Hi ${n}! Your order is being processed. Tracking: ${t}`,
  'Collected and Dispatched to Destination': (n,t) => `Hi ${n}! Your order has been collected and is heading to you!`,
  'Received at Destination':              (n,t) => `Hi ${n}! Your order has arrived at the delivery hub near you. Delivery coming soon!`,
  'Out for Delivery':                     (n,t) => `Hi ${n}! Your order is *out for delivery* today! Our rider will be with you shortly.`,
  'Delivered':                            (n,t) => `Hi ${n}! Your order has been *delivered*. Thank you for your purchase! We hope you love it.`,
  'Partially Delivered':                  (n,t) => `Hi ${n}! Part of your order has been delivered. Our team will follow up on the rest.`,
  'Failed to Deliver':                    (n,t) => `Hi ${n}! Our rider couldn't deliver your order today. We'll attempt re-delivery soon. Please ensure someone is available.`,
  'Rescheduled':                          (n,t) => `Hi ${n}! Your delivery has been rescheduled. We'll attempt delivery again soon.`,
  'Re-delivery':                          (n,t) => `Hi ${n}! Your order is out for *re-delivery* today!`,
  'Returned to Client':                   (n,t) => `Hi ${n}! Your order has been returned to us. Please contact us to arrange re-delivery.`,
  'Cancelled':                            (n,t) => `Hi ${n}! Your order has been cancelled. Please contact us if you have any questions.`,
};

const INTERNAL_STATUSES = ['Different Destination','Returned to Branch','Returned to HO','Received at HO (Returned Item)','Return to HO (Invalid Destination)','Received by HO (Invalid Destination)','HO Clearance','Re-assign Rider','Purchased by TranEx','Received by Client'];

function setupTransExpressWebhook(app, db) {
  // One endpoint per brand — paste in Trans Express Web Hook page
  app.post('/webhook/transexpress/:brand', async function(req, res) {
    res.sendStatus(200);
    const brand = req.params.brand;
    const payload = req.body;
    console.log(`[Trans Express/${brand}]`, JSON.stringify(payload).substring(0,200));
    try {
      const tracking = payload.tracking_number || payload.waybill || payload.waybill_number || payload.barcode || null;
      const status   = payload.status || payload.delivery_status || payload.event || null;
      const custName = payload.customer_name || payload.recipient_name || payload.consignee_name || 'there';
      let custPhone  = payload.customer_phone || payload.recipient_phone || payload.phone || null;
      if (!tracking || !status) return;

      const shop = db.db.prepare("SELECT * FROM shops WHERE brand=? AND active!=0 LIMIT 1").get(brand)
        || db.db.prepare("SELECT * FROM shops LIMIT 1").get();
      if (!shop) return;
      const shopDomain = shop.shop_domain;

      // Find phone from our DB if not in payload
      if (!custPhone) {
        const d = db.db.prepare("SELECT phone FROM trans_express_deliveries WHERE tracking_number=? AND shop_domain=?").get(tracking, shopDomain);
        if (d) custPhone = d.phone;
      }
      if (!custPhone) {
        const o = db.db.prepare("SELECT phone FROM wa_orders WHERE shop_domain=? AND (order_number=? OR notes LIKE ?) LIMIT 1").get(shopDomain, tracking, '%'+tracking+'%');
        if (o) custPhone = o.phone;
      }

      // Save delivery record
      db.db.prepare(`INSERT INTO trans_express_deliveries (shop_domain,tracking_number,phone,status,last_update,raw_data) VALUES (?,?,?,?,datetime('now'),?) ON CONFLICT(shop_domain,tracking_number) DO UPDATE SET phone=COALESCE(?,phone),status=?,last_update=datetime('now'),raw_data=?`)
        .run(shopDomain, tracking, custPhone||null, status, JSON.stringify(payload), custPhone||null, status, JSON.stringify(payload));

      // Update order status
      if (status === 'Delivered') {
        db.db.prepare("UPDATE wa_orders SET status='delivered',updated_at=datetime('now') WHERE shop_domain=? AND order_number=?").run(shopDomain, tracking);
        if (custPhone) {
          try { db.db.prepare("INSERT OR IGNORE INTO review_queue (shop_domain,phone,tracking_number,deliver_date) VALUES (?,?,?,datetime('now'))").run(shopDomain, custPhone, tracking); } catch(e) {}
        }
      }
      if (['Returned to Client','Cancelled'].includes(status)) {
        db.db.prepare("UPDATE wa_orders SET status='cancelled',updated_at=datetime('now') WHERE shop_domain=? AND order_number=?").run(shopDomain, tracking);
      }

      // Send WA message
      if (INTERNAL_STATUSES.includes(status)) return;
      if (!custPhone) return console.warn(`[Trans Express] No phone for ${tracking}`);
      const msgFn = STATUS_MSGS[status];
      if (!msgFn) return;
      await sendMessage(custPhone, msgFn(custName, tracking), shop);
      db.db.prepare("UPDATE trans_express_deliveries SET notified_at=datetime('now') WHERE tracking_number=? AND shop_domain=?").run(tracking, shopDomain);
    } catch(e) { console.error('[Trans Express] Error:', e.message); }
  });

  // Manual: link a tracking number to a customer phone
  app.post('/api/transexpress/link', async function(req, res) {
    const { phone, tracking_number, shop_domain } = req.body;
    if (!phone || !tracking_number || !shop_domain) return res.status(400).json({ error: 'phone, tracking_number and shop_domain required' });
    try {
      db.db.prepare("INSERT OR REPLACE INTO trans_express_deliveries (shop_domain,tracking_number,phone,status) VALUES (?,?,?,'registered')").run(shop_domain, tracking_number, phone);
      const shop = db.getShop(shop_domain);
      if (shop) await sendMessage(phone, `Your tracking number is: *${tracking_number}*\nTrack here: https://transexpress.lk`, shop);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Review queue scheduler
  setInterval(async function() {
    try {
      const settings = db.db.prepare("SELECT * FROM automation_settings WHERE review_enabled=1").all();
      for (const s of settings) {
        const cutoff = new Date(Date.now() - (s.review_days||7) * 86400000).toISOString();
        const pending = db.db.prepare("SELECT r.* FROM review_queue r WHERE r.shop_domain=? AND r.deliver_date<=? AND r.sent_at IS NULL LIMIT 5").all(s.shop_domain, cutoff);
        for (const r of pending) {
          const shop = db.getShop(r.shop_domain);
          if (!shop) continue;
          const contact = db.getContact(r.shop_domain, r.phone);
          const name = contact?.name || 'there';
          const msg = (s.review_msg||'Hi {{name}}! Hope you love your order! Please leave us a review: {{url}}').replace('{{name}}', name).replace('{{url}}', 'https://'+r.shop_domain);
          await sendMessage(r.phone, msg, shop);
          db.db.prepare("UPDATE review_queue SET sent_at=datetime('now') WHERE id=?").run(r.id);
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
    } catch(e) { console.error('[Review scheduler]', e.message); }
  }, 3600000);
}

module.exports = { setupTransExpressWebhook };

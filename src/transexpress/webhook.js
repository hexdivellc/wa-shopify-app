const { sendMessage } = require('../whatsapp');

// ── Status messages sent to customers ─────────────────────────────────────────
const STATUS_MESSAGES = {
  'Processing':                      (name, tracking) => `Hi ${name}! Your order is being processed and will be picked up soon. Tracking: ${tracking}`,
  'Collected and Dispatched to Destination': (name, tracking) => `Hi ${name}! Your order has been collected and is on its way to you. Tracking: ${tracking}`,
  'Received at Destination':         (name, tracking) => `Hi ${name}! Your order has arrived at the delivery hub near you. Expected delivery soon!`,
  'Out for Delivery':                (name, tracking) => `Hi ${name}! Your order is out for delivery today! Our rider will be with you shortly. Tracking: ${tracking}`,
  'Delivered':                       (name, tracking) => `Hi ${name}! Your order has been delivered. Thank you for shopping with us! Hope you love it.`,
  'Partially Delivered':             (name, tracking) => `Hi ${name}! Part of your order has been delivered. Our team will follow up on the remaining items.`,
  'Failed to Deliver':               (name, tracking) => `Hi ${name}! Our rider couldn't deliver your order today. We will attempt re-delivery. Please make sure someone is available. Reply to confirm your availability.`,
  'Rescheduled':                     (name, tracking) => `Hi ${name}! Your delivery has been rescheduled. We will attempt delivery again soon.`,
  'Returned to Branch':              (name, tracking) => `Hi ${name}! Your order has been returned to our branch. Please contact us to arrange re-delivery.`,
  'Returned to Client':              (name, tracking) => `Hi ${name}! Your order has been returned to us. Please contact us so we can sort this out for you.`,
  'Cancelled':                       (name, tracking) => `Hi ${name}! Your order has been cancelled. Please contact us if you have any questions.`,
  'Re-delivery':                     (name, tracking) => `Hi ${name}! Your order is out for re-delivery today! Our rider will be with you shortly.`,
};

// ── Statuses that need internal alert (no customer message) ───────────────────
const INTERNAL_ONLY_STATUSES = ['Different Destination', 'Returned to HO', 'Received at HO (Returned Item)', 'Return to HO (Invalid Destination)', 'Received by HO (Invalid Destination)', 'HO Clearance', 'Re-assign Rider', 'Purchased by TranEx'];

// ── Statuses that mark order as delivered in our DB ───────────────────────────
const DELIVERED_STATUSES = ['Delivered', 'Received by Client'];
const FAILED_STATUSES = ['Failed to Deliver', 'Returned to Client', 'Returned to HO', 'Cancelled'];

function setupTransExpressWebhook(app, db) {

  // ── Webhook endpoint — one per brand ──────────────────────────────────────────
  // In Trans Express, paste: https://yourapp.railway.app/webhook/transexpress/:brand
  app.post('/webhook/transexpress/:brand', async function(req, res) {
    res.sendStatus(200); // Always respond 200 immediately

    const brand = req.params.brand; // keshya | rawana | vitaskin
    const payload = req.body;

    console.log(`[Trans Express] ${brand} webhook:`, JSON.stringify(payload).substring(0, 200));

    try {
      // ── Parse Trans Express payload ──────────────────────────────────────────
      // Trans Express sends different formats — handle both common ones
      const tracking = payload.tracking_number
        || payload.waybill
        || payload.waybill_number
        || payload.order_number
        || payload.barcode
        || null;

      const status = payload.status
        || payload.delivery_status
        || payload.event
        || payload.state
        || null;

      const customerName = payload.customer_name
        || payload.recipient_name
        || payload.consignee_name
        || 'there';

      const customerPhone = payload.customer_phone
        || payload.recipient_phone
        || payload.consignee_phone
        || payload.phone
        || null;

      const rawPayload = JSON.stringify(payload);

      if (!tracking || !status) {
        console.warn('[Trans Express] Missing tracking or status in payload:', rawPayload);
        return;
      }

      // ── Find shop by brand ────────────────────────────────────────────────────
      const shop = db.db.prepare("SELECT * FROM shops WHERE brand=? AND active!=0 LIMIT 1").get(brand)
        || db.db.prepare("SELECT * FROM shops LIMIT 1").get(); // fallback to first shop

      if (!shop) {
        console.warn(`[Trans Express] No shop found for brand: ${brand}`);
        return;
      }

      const shopDomain = shop.shop_domain;

      // ── Find customer phone from our DB if not in payload ─────────────────────
      let phone = customerPhone;
      if (!phone) {
        const delivery = db.db.prepare("SELECT phone FROM trans_express_deliveries WHERE tracking_number=? AND shop_domain=?").get(tracking, shopDomain);
        if (delivery) phone = delivery.phone;
      }

      // Also check wa_orders and Shopify orders
      if (!phone) {
        const order = db.db.prepare("SELECT phone FROM wa_orders WHERE shop_domain=? AND (order_number=? OR notes LIKE ?) LIMIT 1").get(shopDomain, tracking, '%'+tracking+'%');
        if (order) phone = order.phone;
      }

      // ── Save/update delivery record ───────────────────────────────────────────
      db.db.prepare(`INSERT INTO trans_express_deliveries
        (shop_domain, tracking_number, phone, status, last_update, raw_data)
        VALUES (?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(shop_domain, tracking_number) DO UPDATE SET
        phone=COALESCE(?,phone), status=?, last_update=datetime('now'), raw_data=?`)
        .run(shopDomain, tracking, phone||null, status, rawPayload, phone||null, status, rawPayload);

      // ── Update WA order status if we can match ────────────────────────────────
      if (DELIVERED_STATUSES.includes(status)) {
        db.db.prepare("UPDATE wa_orders SET status='delivered', updated_at=datetime('now') WHERE shop_domain=? AND (order_number=? OR notes LIKE ?)").run(shopDomain, tracking, '%'+tracking+'%');
        // Trigger review request after X days (handled by scheduler)
        if (phone) {
          db.db.prepare(`INSERT OR IGNORE INTO review_queue (shop_domain, phone, tracking_number, deliver_date)
            VALUES (?, ?, ?, datetime('now'))`).run(shopDomain, phone, tracking);
        }
      }

      if (FAILED_STATUSES.includes(status)) {
        db.db.prepare("UPDATE wa_orders SET status='cancelled', updated_at=datetime('now') WHERE shop_domain=? AND order_number=?").run(shopDomain, tracking);
      }

      // ── Send WA message to customer ───────────────────────────────────────────
      if (INTERNAL_ONLY_STATUSES.includes(status)) {
        console.log(`[Trans Express] Internal status "${status}" — no customer message`);
        return;
      }

      if (!phone) {
        console.warn(`[Trans Express] No phone for tracking ${tracking} — cannot send WA`);
        return;
      }

      const msgFn = STATUS_MESSAGES[status];
      if (!msgFn) {
        console.log(`[Trans Express] No message template for status: ${status}`);
        return;
      }

      const msg = msgFn(customerName, tracking);
      await sendMessage(phone, msg, shop);

      // Mark as notified
      db.db.prepare("UPDATE trans_express_deliveries SET notified_at=datetime('now') WHERE tracking_number=? AND shop_domain=?").run(tracking, shopDomain);

      console.log(`[Trans Express] Sent "${status}" update to ${phone} for ${tracking}`);

    } catch(e) {
      console.error('[Trans Express] Webhook error:', e.message);
    }
  });

  // ── Manual tracking link endpoint ─────────────────────────────────────────────
  // Agents can call this to send tracking to a customer manually
  app.post('/api/transexpress/send-tracking', async function(req, res) {
    const { phone, tracking_number, shop_domain } = req.body;
    if (!phone || !tracking_number) return res.status(400).json({ error: 'phone and tracking_number required' });
    const shop = db.getShop(shop_domain);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    const msg = `Your delivery tracking number is: ${tracking_number}\nTrack here: https://transexpress.lk\nFor updates, we'll message you automatically.`;
    await sendMessage(phone, msg, shop);
    // Save to deliveries table
    db.db.prepare(`INSERT OR REPLACE INTO trans_express_deliveries (shop_domain, tracking_number, phone, status)
      VALUES (?, ?, ?, 'registered')`).run(shop_domain, tracking_number, phone);
    res.json({ ok: true });
  });

  // ── Get delivery history for a tracking number ────────────────────────────────
  app.get('/api/transexpress/:tracking', async function(req, res) {
    const rows = db.db.prepare("SELECT * FROM trans_express_deliveries WHERE tracking_number=? ORDER BY last_update DESC").all(req.params.tracking);
    res.json(rows);
  });

  // ── Review queue scheduler (send review request X days after delivery) ────────
  function startReviewScheduler() {
    setInterval(async function() {
      try {
        const settings = db.db.prepare("SELECT * FROM automation_settings WHERE review_enabled=1").all();
        for (const s of settings) {
          const days = s.review_days || 7;
          const cutoff = new Date(Date.now() - days * 86400000).toISOString();
          const pending = db.db.prepare(`
            SELECT r.*, sh.wa_token, sh.wa_phone_id, sh.shop_domain as sd
            FROM review_queue r
            JOIN shops sh ON sh.shop_domain=r.shop_domain
            WHERE r.shop_domain=? AND r.deliver_date<=? AND r.sent_at IS NULL
            LIMIT 10
          `).all(s.shop_domain, cutoff);

          for (const r of pending) {
            const shop = db.getShop(r.shop_domain);
            if (!shop) continue;
            const contact = db.getContact(r.shop_domain, r.phone);
            const name = contact?.name || 'there';
            const msg = (s.review_msg || 'Hi {{name}}! Hope you love your order! Leave us a review: {{url}}')
              .replace('{{name}}', name)
              .replace('{{url}}', 'https://'+r.shop_domain);
            await sendMessage(r.phone, msg, shop);
            db.db.prepare("UPDATE review_queue SET sent_at=datetime('now') WHERE id=?").run(r.id);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      } catch(e) { console.error('Review scheduler error:', e.message); }
    }, 3600000); // check every hour
  }

  startReviewScheduler();
}

module.exports = { setupTransExpressWebhook };

const { sendMessage } = require('../whatsapp');
const db = require('../db/database');

async function sendBroadcast(domain, broadcastId, shop) {
  const bc = db.getBroadcasts(domain).find(b => b.id === broadcastId);
  if (!bc) return;

  // Get segment
  let contacts = db.getAllConversations(domain);
  if (bc.segment === 'buyers') {
    const buyers = new Set(db.getWAOrders(domain).map(o => o.phone));
    contacts = contacts.filter(c => buyers.has(c.phone));
  } else if (bc.segment === 'non_buyers') {
    const buyers = new Set(db.getWAOrders(domain).map(o => o.phone));
    contacts = contacts.filter(c => !buyers.has(c.phone));
  } else if (bc.segment === 'active_7d') {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const active = new Set(
      db.db.prepare('SELECT DISTINCT phone FROM messages WHERE shop_domain = ? AND created_at >= ?').all(domain, since).map(r => r.phone)
    );
    contacts = contacts.filter(c => active.has(c.phone));
  }

  db.updateBroadcast(broadcastId, { status: 'sending', sent_count: 0, total_count: contacts.length });

  let sent = 0, failed = 0;
  for (const contact of contacts) {
    try {
      const msg = bc.message.replace('{{name}}', contact.name || 'there');
      await sendMessage(contact.phone, msg, shop);
      db.saveMessage(domain, { phone: contact.phone, direction: 'outbound', text: msg, ai_provider: 'broadcast' });
      sent++;
      if (sent % 10 === 0) db.updateBroadcast(broadcastId, { status: 'sending', sent_count: sent, total_count: contacts.length });
      await new Promise(r => setTimeout(r, 1200)); // 1.2s between messages
    } catch(e) { failed++; }
  }

  db.updateBroadcast(broadcastId, { status: 'done', sent_count: sent, total_count: contacts.length });
  console.log(`📢 Broadcast done: ${sent} sent, ${failed} failed`);
  return { sent, failed };
}

module.exports = { sendBroadcast };

const { sendMessage } = require('../whatsapp');
const db = require('../db/database');

async function sendBroadcast(domain, broadcastId, shop) {
  const bc = db.getBroadcasts(domain).find(b => b.id === broadcastId);
  if (!bc) return;
  let contacts = db.getAllConversations(domain);
  if (bc.segment === 'buyers') {
    const buyers = new Set(db.getWAOrders(domain).map(o => o.phone));
    contacts = contacts.filter(c => buyers.has(c.phone));
  } else if (bc.segment === 'non_buyers') {
    const buyers = new Set(db.getWAOrders(domain).map(o => o.phone));
    contacts = contacts.filter(c => !buyers.has(c.phone));
  }
  db.updateBroadcast(broadcastId, { status: 'sending', sent_count: 0, total_count: contacts.length });
  let sent = 0;
  for (const contact of contacts) {
    try {
      const msg = bc.message.replace('{{name}}', contact.name||'there');
      await sendMessage(contact.phone, msg, shop);
      db.saveMessage(domain, { phone: contact.phone, direction: 'outbound', text: msg, ai_provider: 'broadcast' });
      sent++;
      if (sent % 10 === 0) db.updateBroadcast(broadcastId, { status: 'sending', sent_count: sent, total_count: contacts.length });
      await new Promise(r => setTimeout(r, 1200));
    } catch(e) {}
  }
  db.updateBroadcast(broadcastId, { status: 'done', sent_count: sent, total_count: contacts.length });
}

module.exports = { sendBroadcast };

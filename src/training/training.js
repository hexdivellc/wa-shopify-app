function setupTrainingRoutes(app, db, requireAuth) {

  // ── Get all training data for a brand ─────────────────────────────────────
  app.get('/api/training', requireAuth(['admin']), function(req, res) {
    const { brand, type } = req.query;
    let q = 'SELECT * FROM ai_training WHERE shop_domain = ? AND active = 1';
    const params = [req.shopDomain];
    if (brand) { q += ' AND brand = ?'; params.push(brand); }
    if (type)  { q += ' AND type = ?';  params.push(type);  }
    q += ' ORDER BY created_at DESC';
    const rows = db.db.prepare(q).all(...params);
    res.json(rows.map(r => ({ ...r, data: JSON.parse(r.data) })));
  });

  // ── Add training entry ─────────────────────────────────────────────────────
  app.post('/api/training', requireAuth(['admin']), function(req, res) {
    const { brand, type, data } = req.body;
    if (!brand || !type || !data) return res.status(400).json({ error: 'brand, type and data required' });
    db.db.prepare('INSERT INTO ai_training (shop_domain, brand, type, data) VALUES (?, ?, ?, ?)').run(req.shopDomain, brand, type, JSON.stringify(data));
    res.json({ ok: true });
  });

  // ── Update training entry ──────────────────────────────────────────────────
  app.patch('/api/training/:id', requireAuth(['admin']), function(req, res) {
    const { data, active } = req.body;
    db.db.prepare('UPDATE ai_training SET data=?, active=? WHERE id=? AND shop_domain=?').run(JSON.stringify(data), active !== false ? 1 : 0, req.params.id, req.shopDomain);
    res.json({ ok: true });
  });

  // ── Delete training entry ──────────────────────────────────────────────────
  app.delete('/api/training/:id', requireAuth(['admin']), function(req, res) {
    db.db.prepare('UPDATE ai_training SET active = 0 WHERE id = ? AND shop_domain = ?').run(req.params.id, req.shopDomain);
    res.json({ ok: true });
  });

  // ── Get/set AI global settings ─────────────────────────────────────────────
  app.get('/api/ai-settings', requireAuth(), function(req, res) {
    const s = db.db.prepare('SELECT * FROM ai_settings WHERE shop_domain = ?').get(req.shopDomain);
    res.json(s || { global_ai_enabled: 1, keshya_ai: 1, rawana_ai: 1, vitaskin_ai: 1, provider: 'gemini' });
  });

  app.post('/api/ai-settings', requireAuth(['admin']), function(req, res) {
    const { global_ai_enabled, provider, keshya_ai, rawana_ai, vitaskin_ai } = req.body;
    db.db.prepare(`INSERT INTO ai_settings (shop_domain, global_ai_enabled, provider, keshya_ai, rawana_ai, vitaskin_ai, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(shop_domain) DO UPDATE SET global_ai_enabled=?, provider=?, keshya_ai=?, rawana_ai=?, vitaskin_ai=?, updated_at=datetime('now')`)
      .run(req.shopDomain, global_ai_enabled?1:0, provider, keshya_ai?1:0, rawana_ai?1:0, vitaskin_ai?1:0,
           global_ai_enabled?1:0, provider, keshya_ai?1:0, rawana_ai?1:0, vitaskin_ai?1:0);
    res.json({ ok: true });
  });
}

// ── Build system prompt from training data ─────────────────────────────────
function buildSystemPrompt(shopDomain, brand, db) {
  const BASE = {
    keshya:   'You are a warm, knowledgeable support agent for Keshya Ceylon, a natural hair growth supplement brand from Sri Lanka.',
    rawana:   'You are a calm, trustworthy support agent for Rawana Roots, an Ayurvedic herbal supplement brand from Sri Lanka.',
    vitaskin: 'You are a modern, glowing support agent for Vita Skin, a clean beauty skincare brand from Sri Lanka.',
    default:  'You are a friendly customer support agent for an e-commerce store in Sri Lanka.',
  };

  let prompt = BASE[brand] || BASE.default;
  prompt += '\nAlways reply in the same language the customer uses (English or Sinhala). Keep replies short (2-4 sentences), conversational, no bullet points.';

  try {
    const training = db.db.prepare("SELECT type, data FROM ai_training WHERE shop_domain=? AND brand=? AND active=1").all(shopDomain, brand);

    // Personality
    const personality = training.filter(t => t.type === 'personality').map(t => JSON.parse(t.data));
    if (personality.length) {
      const p = personality[0];
      if (p.tone)        prompt += `\nTone: ${p.tone}`;
      if (p.description) prompt += `\nAdditional context: ${p.description}`;
    }

    // FAQs
    const faqs = training.filter(t => t.type === 'faq').map(t => JSON.parse(t.data));
    if (faqs.length) {
      prompt += '\n\nKnowledge base:';
      faqs.forEach(f => { prompt += `\nQ: ${f.question}\nA: ${f.answer}`; });
    }

    // Rules
    const rules = training.filter(t => t.type === 'rule').map(t => JSON.parse(t.data));
    if (rules.length) {
      prompt += '\n\nCustom rules:';
      rules.forEach(r => { prompt += `\nIf customer says "${r.trigger}", respond with: "${r.response}"`; });
    }
  } catch(e) { console.error('Training load error:', e.message); }

  return prompt;
}

module.exports = { setupTrainingRoutes, buildSystemPrompt };

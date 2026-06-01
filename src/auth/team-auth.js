const crypto = require('crypto');

function hashPw(pw) { return crypto.createHash('sha256').update(pw + (process.env.SESSION_SECRET||'wabot')).digest('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }

function setupAuthRoutes(app, db) {
  function ensureAdmin() {
    const existing = db.db.prepare("SELECT id FROM team_members WHERE role='admin' LIMIT 1").get();
    if (!existing) {
      db.db.prepare("INSERT OR IGNORE INTO team_members (name,email,password_hash,role,must_change_pw) VALUES ('Admin','admin@wabot.com',?,'admin',0)").run(hashPw('admin123'));
      console.log('Created default admin: admin@wabot.com / admin123');
    } else {
      db.db.prepare("UPDATE team_members SET must_change_pw=0 WHERE id=? AND must_change_pw=1").run(existing.id);
    }
  }
  ensureAdmin();

  function requireAuth(roles) {
    return function(req, res, next) {
      const token = req.headers['x-auth-token'];
      if (!token) return res.status(401).json({ error: 'Not authenticated' });
      const s = db.db.prepare(`SELECT s.*,m.name,m.email,m.role,m.must_change_pw FROM team_sessions s JOIN team_members m ON m.id=s.member_id WHERE s.token=? AND s.expires_at>datetime('now') AND m.active=1`).get(token);
      if (!s) return res.status(401).json({ error: 'Session expired' });
      if (roles && roles.length && !roles.includes(s.role)) return res.status(403).json({ error: 'Insufficient permissions' });
      req.member = s;
      req.activeDomain = req.headers['x-active-shop'] || req.query.active_shop || null;
      next();
    };
  }

  app.post('/api/auth/login', function(req, res) {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const m = db.db.prepare("SELECT * FROM team_members WHERE email=? AND active=1").get(email.toLowerCase().trim());
    if (!m || m.password_hash !== hashPw(password)) return res.status(401).json({ error: 'Invalid email or password' });
    const token = genToken();
    db.db.prepare("INSERT INTO team_sessions (member_id,token,expires_at) VALUES (?,?,datetime('now','+7 days'))").run(m.id, token);
    db.db.prepare("UPDATE team_members SET last_login=datetime('now') WHERE id=?").run(m.id);
    res.json({ ok: true, token, member: { id: m.id, name: m.name, email: m.email, role: m.role, must_change_pw: m.must_change_pw === 1 } });
  });

  app.post('/api/auth/change-password', requireAuth(), function(req, res) {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
    const m = db.db.prepare("SELECT * FROM team_members WHERE id=?").get(req.member.member_id);
    if (m.password_hash !== hashPw(current_password)) return res.status(401).json({ error: 'Current password incorrect' });
    db.db.prepare("UPDATE team_members SET password_hash=?,must_change_pw=0 WHERE id=?").run(hashPw(new_password), req.member.member_id);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth(), function(req, res) { res.json({ member: req.member }); });

  app.post('/api/auth/logout', function(req, res) {
    const token = req.headers['x-auth-token'];
    if (token) db.db.prepare("DELETE FROM team_sessions WHERE token=?").run(token);
    res.json({ ok: true });
  });

  app.get('/api/team', requireAuth(['admin']), function(req, res) {
    res.json(db.db.prepare("SELECT id,name,email,role,active,last_login FROM team_members ORDER BY id").all());
  });

  app.post('/api/team', requireAuth(['admin']), function(req, res) {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
    if (!['admin','agent','viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    try {
      db.db.prepare("INSERT INTO team_members (name,email,password_hash,role) VALUES (?,?,?,?)").run(name, email.toLowerCase(), hashPw(password), role);
      res.json({ ok: true });
    } catch(e) { res.status(400).json({ error: 'Email already exists' }); }
  });

  app.patch('/api/team/:id', requireAuth(['admin']), function(req, res) {
    const { name, role, active, password } = req.body;
    if (password) {
      db.db.prepare("UPDATE team_members SET name=?,role=?,active=?,password_hash=?,must_change_pw=1 WHERE id=?").run(name, role, active?1:0, hashPw(password), req.params.id);
    } else {
      db.db.prepare("UPDATE team_members SET name=?,role=?,active=? WHERE id=?").run(name, role, active?1:0, req.params.id);
    }
    res.json({ ok: true });
  });

  app.delete('/api/team/:id', requireAuth(['admin']), function(req, res) {
    if (parseInt(req.params.id) === req.member.member_id) return res.status(400).json({ error: 'Cannot delete yourself' });
    db.db.prepare("UPDATE team_members SET active=0 WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });

  return { requireAuth };
}

module.exports = { setupAuthRoutes };

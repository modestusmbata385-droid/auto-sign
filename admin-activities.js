// AUTO SIGN - Admin role + Daily Activity (text, images, files)
// Loaded from server.js: const extras=require('./admin-activities');
const bcrypt = require('bcryptjs');

const schema = `
CREATE TABLE IF NOT EXISTS activities(
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  teacher_id INT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  day DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS activity_files(
  id SERIAL PRIMARY KEY,
  activity_id INT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  name TEXT,
  mime TEXT,
  size INT,
  data BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_student_idx ON activities(student_id, day DESC);
CREATE INDEX IF NOT EXISTS activity_files_activity_idx ON activity_files(activity_id);
`;

const ROLES = ['teacher', 'parent', 'admin'];
const FILE_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];
const MAX_FILE = 3 * 1024 * 1024;   // 3 MB per file
const MAX_TOTAL = 5 * 1024 * 1024;  // 5 MB per activity
const idOf = n => (Number.isSafeInteger(Number(n)) && Number(n) > 0 ? Number(n) : 0);
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const validAmount = n => Number.isSafeInteger(Number(n)) && Number(n) > 0 && Number(n) <= 100000000;

const ACTIVITY_SQL = `
SELECT a.id, a.student_id, s.name student_name, a.title, a.description,
       to_char(a.day,'YYYY-MM-DD') AS day, a.created_at,
       COALESCE((SELECT json_agg(json_build_object('id',f.id,'name',f.name,'mime',f.mime,'size',f.size) ORDER BY f.id)
                 FROM activity_files f WHERE f.activity_id=a.id), '[]'::json) AS files
FROM activities a JOIN students s ON s.id=a.student_id`;

function install({ app, db, auth, q, notice, owned, fee }) {
  // ---------- DAILY ACTIVITY ----------
  // Teacher: list own activities + students for the form
  app.get('/api/activities', auth('teacher'), async (req, res) => {
    const activities = await q(ACTIVITY_SQL + ' WHERE a.teacher_id=$1 ORDER BY a.day DESC, a.id DESC LIMIT 50', [req.user.id]);
    const students = await q('SELECT id,name FROM students WHERE teacher_id=$1 ORDER BY name', [req.user.id]);
    res.json({ activities, students });
  });

  // Teacher: create activity (with optional files, base64)
  app.post('/api/activities', auth('teacher'), async (req, res) => {
    const x = req.body || {};
    const s = await owned(x.studentId, req.user.id);
    if (!s) return res.status(404).json({ error: 'Mwanafunzi hajapatikana' });
    const title = String(x.title || '').trim().slice(0, 200);
    const description = String(x.description || '').trim().slice(0, 5000);
    if (!title) return res.status(400).json({ error: 'Weka kichwa cha activity' });
    const day = isDay(x.day) ? x.day : null;
    const list = Array.isArray(x.files) ? x.files : [];
    if (list.length > 5) return res.status(400).json({ error: 'Faili zisizidi 5 kwa activity moja' });
    let total = 0;
    const files = [];
    for (const f of list) {
      if (!f || !FILE_TYPES.includes(f.type) || typeof f.data !== 'string')
        return res.status(400).json({ error: 'Aina ya faili hairuhusiwi: ' + String((f && f.name) || '') });
      const buf = Buffer.from(f.data, 'base64');
      total += buf.length;
      if (!buf.length || buf.length > MAX_FILE || total > MAX_TOTAL)
        return res.status(400).json({ error: 'Faili ni kubwa mno (kila faili hadi 3 MB, jumla hadi 5 MB)' });
      files.push({ name: String(f.name || 'file').slice(0, 150), type: f.type, buf });
    }
    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');
      const a = (await client.query(
        'INSERT INTO activities(student_id,teacher_id,title,description,day) VALUES($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE)) RETURNING id',
        [s.id, req.user.id, title, description, day])).rows[0];
      for (const f of files)
        await client.query('INSERT INTO activity_files(activity_id,name,mime,size,data) VALUES($1,$2,$3,$4,$5)', [a.id, f.name, f.type, f.buf.length, f.buf]);
      await client.query('COMMIT');
    } catch (e) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      if (client) client.release();
    }
    await notice(s.id, `Activity mpya ya ${s.name}: ${title}`);
    res.status(201).json({ ok: true });
  });

  // Parent: activities of own children only
  app.get('/api/parent/activities', auth('parent'), async (req, res) => {
    const activities = await q(
      ACTIVITY_SQL + ' WHERE a.student_id IN (SELECT student_id FROM parent_student_access WHERE parent_id=$1) ORDER BY a.day DESC, a.id DESC LIMIT 100',
      [req.user.id]);
    res.json({ activities });
  });

  // Teacher (own) or admin: delete activity
  app.post('/api/activities/:id/delete', auth('teacher', 'admin'), async (req, res) => {
    const r = await db.query('DELETE FROM activities WHERE id=$1 AND ($2::boolean OR teacher_id=$3)',
      [idOf(req.params.id), req.user.role === 'admin', req.user.id]);
    res.json({ ok: true, deleted: r.rowCount });
  });

  // File download (teacher who owns it, parent of that child, or admin)
  app.get('/api/activity-files/:id', auth('teacher', 'parent', 'admin'), async (req, res) => {
    const f = (await q(
      `SELECT f.name, f.mime, f.data FROM activity_files f JOIN activities a ON a.id=f.activity_id
       WHERE f.id=$1 AND ($2::boolean OR a.teacher_id=$3
         OR a.student_id IN (SELECT student_id FROM parent_student_access WHERE parent_id=$3))`,
      [idOf(req.params.id), req.user.role === 'admin', req.user.id]))[0];
    if (!f) return res.status(404).json({ error: 'Faili halipatikani' });
    res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' });
    res.send(f.data);
  });

  // ---------- ADMIN ----------
  app.get('/api/admin', auth('admin'), async (req, res) => {
    const users = await q(`SELECT id,name,email,role FROM users
      ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'teacher' THEN 1 ELSE 2 END, id`);
    const students = await q(`SELECT s.id,s.name,s.school,s.class_name,s.access_code,s.teacher_id,t.name teacher_name,
      (SELECT COUNT(*) FROM parent_student_access x WHERE x.student_id=s.id)::int parents,
      (SELECT COUNT(*) FROM student_attendance a WHERE a.student_id=s.id AND a.status='present')::int days,
      (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.student_id=s.id)::int paid
      FROM students s LEFT JOIN users t ON t.id=s.teacher_id ORDER BY s.id`);
    const payments = await q(`SELECT p.id,s.name student_name,p.amount,p.note,to_char(p.paid_on,'YYYY-MM-DD') paid_on
      FROM payments p JOIN students s ON s.id=p.student_id ORDER BY p.id DESC LIMIT 100`);
    const activities = await q(ACTIVITY_SQL + ' ORDER BY a.day DESC, a.id DESC LIMIT 100');
    res.json({ me: req.user.id, fee, users, students, payments, activities });
  });

  app.post('/api/admin/users/:id/update', auth('admin'), async (req, res) => {
    const id = idOf(req.params.id), x = req.body || {};
    const name = String(x.name || '').trim(), email = String(x.email || '').trim().toLowerCase(), role = String(x.role || '');
    const password = String(x.password || '');
    if (!(await q('SELECT id FROM users WHERE id=$1', [id]))[0]) return res.status(404).json({ error: 'Mtumiaji hajapatikana' });
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || !ROLES.includes(role))
      return res.status(400).json({ error: 'Jina, email sahihi na role (teacher / parent / admin) vinahitajika' });
    if (id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'Huwezi kujishushia role yako mwenyewe' });
    if (password && password.length < 8) return res.status(400).json({ error: 'Password iwe na herufi 8 au zaidi' });
    if ((await q('SELECT id FROM users WHERE email=$1 AND id<>$2', [email, id]))[0]) return res.status(409).json({ error: 'Email hiyo inatumika tayari' });
    if (password) await q('UPDATE users SET name=$1,email=$2,role=$3,password=$4 WHERE id=$5', [name, email, role, await bcrypt.hash(password, 10), id]);
    else await q('UPDATE users SET name=$1,email=$2,role=$3 WHERE id=$4', [name, email, role, id]);
    res.json({ ok: true });
  });

  app.post('/api/admin/users/:id/delete', auth('admin'), async (req, res) => {
    const id = idOf(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Huwezi kujifuta mwenyewe' });
    if (!(await q('SELECT id FROM users WHERE id=$1', [id]))[0]) return res.status(404).json({ error: 'Mtumiaji hajapatikana' });
    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');
      await client.query('UPDATE students SET teacher_id=NULL WHERE teacher_id=$1', [id]);
      await client.query('DELETE FROM teacher_attendance WHERE teacher_id=$1', [id]);
      await client.query('DELETE FROM parent_student_access WHERE parent_id=$1', [id]);
      await client.query('DELETE FROM notifications WHERE parent_id=$1', [id]);
      await client.query('DELETE FROM users WHERE id=$1', [id]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      res.status(e.code === '23503' ? 409 : 500).json({
        error: e.code === '23503'
          ? 'Mtumiaji huyu ana rekodi nyingine zinazomtegemea (mfano malipo ya mtandaoni), kwa hiyo hawezi kufutwa.'
          : 'Imeshindikana kufuta. Jaribu tena.'
      });
    } finally {
      if (client) client.release();
    }
  });

  app.post('/api/admin/students/:id/update', auth('admin'), async (req, res) => {
    const id = idOf(req.params.id), x = req.body || {}, name = String(x.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Jina la mwanafunzi linahitajika' });
    const teacherId = x.teacherId === '' || x.teacherId == null ? null : idOf(x.teacherId);
    if (x.teacherId !== '' && x.teacherId != null && !(await q("SELECT id FROM users WHERE id=$1 AND role='teacher'", [teacherId]))[0])
      return res.status(400).json({ error: 'Mwalimu huyo hapatikani (weka ID sahihi ya mwalimu)' });
    const r = await db.query('UPDATE students SET name=$1,school=$2,class_name=$3,teacher_id=$4 WHERE id=$5',
      [name, String(x.school || ''), String(x.className || ''), teacherId, id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Mwanafunzi hajapatikana' });
    res.json({ ok: true });
  });

  app.post('/api/admin/students/:id/delete', auth('admin'), async (req, res) => {
    const id = idOf(req.params.id);
    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');
      await client.query('DELETE FROM student_attendance WHERE student_id=$1', [id]);
      await client.query('DELETE FROM payments WHERE student_id=$1', [id]);
      await client.query('DELETE FROM parent_student_access WHERE student_id=$1', [id]);
      const r = await client.query('DELETE FROM students WHERE id=$1', [id]);
      await client.query('COMMIT');
      if (!r.rowCount) return res.status(404).json({ error: 'Mwanafunzi hajapatikana' });
      res.json({ ok: true });
    } catch (e) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      res.status(e.code === '23503' ? 409 : 500).json({
        error: e.code === '23503'
          ? 'Mwanafunzi huyu ana rekodi nyingine (mfano malipo ya mtandaoni), kwa hiyo hawezi kufutwa.'
          : 'Imeshindikana kufuta. Jaribu tena.'
      });
    } finally {
      if (client) client.release();
    }
  });

  app.post('/api/admin/attendance', auth('admin'), async (req, res) => {
    const x = req.body || {}, id = idOf(x.studentId);
    if (!isDay(x.day) || !['present', 'absent', 'clear'].includes(x.status))
      return res.status(400).json({ error: 'Weka tarehe (YYYY-MM-DD) na hali: present, absent au clear' });
    if (!(await q('SELECT id FROM students WHERE id=$1', [id]))[0]) return res.status(404).json({ error: 'Mwanafunzi hajapatikana' });
    if (x.status === 'clear') await q('DELETE FROM student_attendance WHERE student_id=$1 AND day=$2::date', [id, x.day]);
    else await q('INSERT INTO student_attendance(student_id,day,status) VALUES($1,$2::date,$3) ON CONFLICT(student_id,day) DO UPDATE SET status=EXCLUDED.status', [id, x.day, x.status]);
    res.json({ ok: true });
  });

  app.post('/api/admin/payments/:id/update', auth('admin'), async (req, res) => {
    const x = req.body || {};
    if (!validAmount(x.amount)) return res.status(400).json({ error: 'Kiasi sahihi kinahitajika' });
    const r = await db.query('UPDATE payments SET amount=$1,note=$2 WHERE id=$3', [Number(x.amount), String(x.note || ''), idOf(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Malipo hayajapatikana' });
    res.json({ ok: true });
  });

  app.post('/api/admin/payments/:id/delete', auth('admin'), async (req, res) => {
    const r = await db.query('DELETE FROM payments WHERE id=$1', [idOf(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Malipo hayajapatikana' });
    res.json({ ok: true });
  });
}

// Creates (or resets) the admin account from Render environment variables.
// ADMIN_EMAIL + ADMIN_PASSWORD (8+ chars) are required; ADMIN_NAME is optional.
async function ensureAdmin(db, config = process.env) {
  const email = String(config.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(config.ADMIN_PASSWORD || '');
  if (!email || password.length < 8) return;
  const hash = await bcrypt.hash(password, 10);
  const found = (await db.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
  if (found) await db.query("UPDATE users SET role='admin',password=$1 WHERE id=$2", [hash, found.id]);
  else await db.query("INSERT INTO users(name,email,password,role) VALUES($1,$2,$3,'admin')", [config.ADMIN_NAME || 'Admin', email, hash]);
}

module.exports = { schema, install, ensureAdmin };

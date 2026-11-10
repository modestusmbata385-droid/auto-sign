// AUTO SIGN - Admin dashboard + Daily Activity UI
// Loaded BEFORE app.js. Uses helpers from app.js (el, api, esc, money, token) only at run time.
let adminData = null;

const MIME_BY_EXT = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', gif: 'image/gif'
};
const mimeOf = f => f.type || MIME_BY_EXT[(f.name.split('.').pop() || '').toLowerCase()] || '';
const toB64 = f => new Promise((ok, no) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1]);
  r.onerror = no;
  r.readAsDataURL(f);
});

// Shrinks phone photos (max 1280px, JPEG) so uploads stay small; other files are sent as-is.
async function prepareFile(f) {
  const type = mimeOf(f);
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return { name: f.name, type, data: await toB64(f) };
  const url = URL.createObjectURL(f);
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
  const k = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return { name: f.name.replace(/\.\w+$/, '') + '.jpg', type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.8).split(',')[1] };
}

async function fileUrl(id) {
  const r = await fetch('/api/activity-files/' + id, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw Error('Faili halipatikani');
  return URL.createObjectURL(await r.blob());
}

function activityHtml(a, canDelete) {
  const files = a.files || [];
  const imgs = files.filter(f => f.mime.startsWith('image/'));
  const others = files.filter(f => !f.mime.startsWith('image/'));
  return '<div class="notice"><b>' + esc(a.title) + '</b> · ' + esc(a.student_name) + ' · ' + esc(a.day) +
    (a.description ? '<p>' + esc(a.description).replace(/\n/g, '<br>') + '</p>' : '') +
    imgs.map(f => '<img data-file="' + f.id + '" alt="' + esc(f.name) + '" style="max-width:100%;border-radius:8px;margin:6px 0;display:block">').join('') +
    others.map(f => '<button type="button" class="alt dl" data-file="' + f.id + '" data-name="' + esc(f.name) + '">📎 ' + esc(f.name) + '</button> ').join('') +
    (canDelete ? ' <button type="button" class="alt delAct" data-id="' + a.id + '">Futa</button>' : '') + '</div>';
}

function wireActivities(root, reload) {
  root.querySelectorAll('img[data-file]').forEach(i => fileUrl(i.dataset.file).then(u => { i.src = u; }).catch(() => {}));
  root.querySelectorAll('.dl').forEach(b => b.onclick = async () => {
    try { const a = document.createElement('a'); a.href = await fileUrl(b.dataset.file); a.download = b.dataset.name; a.click(); }
    catch (x) { alert(x.message); }
  });
  root.querySelectorAll('.delAct').forEach(b => b.onclick = async () => {
    if (!confirm('Futa activity hii?')) return;
    try { await api('/activities/' + b.dataset.id + '/delete', { method: 'POST' }); reload(); }
    catch (x) { alert(x.message); }
  });
}

// ---------- TEACHER: add + list activities ----------
async function teacherActivities() {
  const box = document.createElement('section');
  box.className = 'card';
  el('#app').appendChild(box);
  box.innerHTML = '<h2>Daily Activity</h2><p>Inapakia...</p>';
  try {
    const d = await api('/activities');
    if (!d.students.length) { box.innerHTML = '<h2>Daily Activity</h2><p>Sajili mwanafunzi kwanza ili uweke activity.</p>'; return; }
    box.innerHTML = '<h2>Daily Activity</h2><p>Weka shughuli/kazi ya mtoto. Mzazi wa mtoto huyo ataiona kwenye akaunti yake.</p>' +
      '<form id="actForm"><select name="studentId" required>' + d.students.map(s => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('') + '</select>' +
      '<input name="title" placeholder="Kichwa (mf. Hisabati: kujumlisha)" maxlength="200" required>' +
      '<textarea name="description" rows="3" placeholder="Maelezo"></textarea>' +
      '<input name="day" type="date" value="' + new Date().toISOString().slice(0, 10) + '">' +
      '<label>Picha / faili (hadi 5) <input name="files" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"></label>' +
      '<button>Hifadhi activity</button></form><h3>Activity za hivi karibuni</h3>' +
      (d.activities.map(a => activityHtml(a, true)).join('') || '<p>Bado hakuna.</p>');
    wireActivities(box, load);
    box.querySelector('#actForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, b = f.querySelector('button');
      b.disabled = true;
      try {
        const files = await Promise.all([...f.elements.files.files].map(prepareFile));
        await api('/activities', { method: 'POST', body: JSON.stringify({
          studentId: f.elements.studentId.value, title: f.elements.title.value,
          description: f.elements.description.value, day: f.elements.day.value, files }) });
        load();
      } catch (x) { alert(x.message); } finally { b.disabled = false; }
    };
  } catch (x) { box.innerHTML = '<h2>Daily Activity</h2><p>' + esc(x.message) + '</p>'; }
}

// ---------- PARENT: view activities ----------
async function parentActivities() {
  const box = document.createElement('section');
  box.className = 'card';
  el('#app').appendChild(box);
  box.innerHTML = '<h2>Daily Activity</h2><p>Inapakia...</p>';
  try {
    const d = await api('/parent/activities');
    box.innerHTML = '<h2>Daily Activity</h2><p>Shughuli alizoweka mwalimu kwa mtoto wako.</p>' +
      (d.activities.map(a => activityHtml(a, false)).join('') || '<p>Hakuna activity bado.</p>');
    wireActivities(box, load);
  } catch (x) { box.innerHTML = '<h2>Daily Activity</h2><p>' + esc(x.message) + '</p>'; }
}

// ---------- ADMIN ----------
async function showAdmin(tab) {
  adminData = await api('/admin');
  adminView(tab || localStorage.adminTab || 'users');
}

function adminView(tab) {
  const d = adminData;
  localStorage.adminTab = tab;
  const b = (act, id, label) => '<button class="alt" data-act="' + act + '" data-id="' + id + '">' + label + '</button> ';
  const tabs = [['users', 'Watumiaji (' + d.users.length + ')'], ['students', 'Wanafunzi (' + d.students.length + ')'], ['payments', 'Malipo'], ['acts', 'Activities']];
  let body = '';
  if (tab === 'users') body = '<table><tr><th>Jina</th><th>Email</th><th>Role</th><th></th></tr>' +
    d.users.map(u => '<tr><td>' + esc(u.name) + '</td><td>' + esc(u.email) + '</td><td>' + esc(u.role) + '</td><td>' +
      b('userEdit', u.id, 'Hariri') + (u.id === d.me ? '' : b('userDel', u.id, 'Futa')) + '</td></tr>').join('') + '</table>';
  if (tab === 'students') body = '<table><tr><th>Mwanafunzi</th><th>Shule / Darasa</th><th>Mwalimu</th><th>Code</th><th>Wazazi</th><th>Siku</th><th>Imelipwa</th><th></th></tr>' +
    d.students.map(s => '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.school) + ' / ' + esc(s.class_name) + '</td><td>' + esc(s.teacher_name || '—') + '</td><td>' + esc(s.access_code) + '</td><td>' + s.parents + '</td><td>' + s.days + '</td><td>' + money(s.paid) + '</td><td>' +
      b('stuEdit', s.id, 'Hariri') + b('stuAtt', s.id, 'Mahudhurio') + b('stuDel', s.id, 'Futa') + '</td></tr>').join('') + '</table>';
  if (tab === 'payments') body = '<table><tr><th>Mwanafunzi</th><th>Kiasi</th><th>Maelezo</th><th>Tarehe</th><th></th></tr>' +
    d.payments.map(p => '<tr><td>' + esc(p.student_name) + '</td><td>' + money(p.amount) + '</td><td>' + esc(p.note) + '</td><td>' + esc(p.paid_on) + '</td><td>' +
      b('payEdit', p.id, 'Hariri') + b('payDel', p.id, 'Futa') + '</td></tr>').join('') + '</table>';
  if (tab === 'acts') body = d.activities.map(a => activityHtml(a, true)).join('') || '<p>Hakuna activity bado.</p>';
  el('#app').innerHTML = '<h1>Admin dashboard</h1><div class="row">' +
    tabs.map(t => '<button class="' + (t[0] === tab ? '' : 'alt') + '" data-act="tab" data-id="' + t[0] + '">' + t[1] + '</button>').join(' ') +
    '</div><section class="card" style="overflow-x:auto">' + body + '</section>';
  wireActivities(el('#app'), () => showAdmin());
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !adminData || typeof user === 'undefined' || !user || user.role !== 'admin') return;
  const d = adminData, id = btn.dataset.id, act = btn.dataset.act;
  const post = async (path, body) => {
    try { await api('/admin' + path, { method: 'POST', body: JSON.stringify(body || {}) }); await showAdmin(); }
    catch (x) { alert(x.message); }
  };
  if (act === 'tab') return adminView(id);
  if (act === 'userEdit') {
    const u = d.users.find(x => x.id == id);
    const name = prompt('Jina', u.name); if (name === null) return;
    const email = prompt('Email', u.email); if (email === null) return;
    const role = prompt('Role (teacher / parent / admin)', u.role); if (role === null) return;
    const password = prompt('Password mpya (acha tupu usibadilishe)', ''); if (password === null) return;
    return post('/users/' + id + '/update', { name, email, role, password });
  }
  if (act === 'userDel') {
    if (confirm('Futa mtumiaji huyu? Hatua hii haiwezi kurudishwa.')) post('/users/' + id + '/delete');
    return;
  }
  if (act === 'stuEdit') {
    const s = d.students.find(x => x.id == id);
    const name = prompt('Jina la mwanafunzi', s.name); if (name === null) return;
    const school = prompt('Shule', s.school || ''); if (school === null) return;
    const className = prompt('Darasa', s.class_name || ''); if (className === null) return;
    const list = d.users.filter(u => u.role === 'teacher').map(u => u.id + ': ' + u.name).join('\n');
    const teacherId = prompt('ID ya mwalimu (acha tupu = hakuna):\n' + list, s.teacher_id || ''); if (teacherId === null) return;
    return post('/students/' + id + '/update', { name, school, className, teacherId });
  }
  if (act === 'stuAtt') {
    const day = prompt('Tarehe (YYYY-MM-DD)', new Date().toISOString().slice(0, 10)); if (day === null) return;
    const status = prompt('Hali: present / absent / clear (futa rekodi)', 'present'); if (status === null) return;
    return post('/attendance', { studentId: id, day, status });
  }
  if (act === 'stuDel') {
    if (confirm('Futa mwanafunzi huyu pamoja na mahudhurio, malipo na activities zake?')) post('/students/' + id + '/delete');
    return;
  }
  if (act === 'payEdit') {
    const p = d.payments.find(x => x.id == id);
    const amount = prompt('Kiasi (TSh)', p.amount); if (amount === null) return;
    const note = prompt('Maelezo', p.note || ''); if (note === null) return;
    return post('/payments/' + id + '/update', { amount, note });
  }
  if (act === 'payDel') {
    if (confirm('Futa malipo haya?')) post('/payments/' + id + '/delete');
  }
});

'use strict';
// Nongpoom Shop backend — zero dependencies (Node 22+: node:http, node:sqlite, node:crypto)
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || 'shop.db';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
// บัญชีรับเงินของร้าน ตั้งผ่านตัวแปรสภาพแวดล้อม เช่น PAY_KBANK='ชื่อบัญชี|เลขบัญชี' PAY_TRUEMONEY='ชื่อ|เบอร์'
const PAY = { truemoney: process.env.PAY_TRUEMONEY || '', kbank: process.env.PAY_KBANK || '' };
const payTo = m => { const [name, account] = (PAY[m] || '').split('|'); return account ? { name, account, qr: m === 'kbank' && fs.existsSync(path.join(__dirname, 'public', 'pay', 'kbank-qr.jpg')) ? '/pay/kbank-qr.jpg' : null } : null; };
const SECRET = process.env.APP_SECRET || (console.warn('WARNING: APP_SECRET not set; logins reset on restart'), crypto.randomBytes(32).toString('hex'));
const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, phone TEXT, pw TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), created INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>0), descr TEXT, tags TEXT, imgs TEXT, cred TEXT, sold INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coupons(code TEXT PRIMARY KEY, type TEXT NOT NULL, val INTEGER NOT NULL, minspend INTEGER NOT NULL DEFAULT 0, remaining INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, no TEXT UNIQUE, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, price INTEGER NOT NULL, discount INTEGER NOT NULL, total INTEGER NOT NULL, coupon TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS topups(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, method TEXT NOT NULL, amount INTEGER NOT NULL, ref TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, decided INTEGER);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, delta INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, note TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), body TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(user_id,product_id));
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, reply TEXT, created INTEGER NOT NULL);`);

try { db.exec('ALTER TABLE topups ADD COLUMN slip TEXT'); } catch {}
class HttpErr extends Error { constructor(c, m) { super(m); this.c = c; } }
const bad = (c, m) => { throw new HttpErr(c, m); };
const now = () => Date.now();
const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const tx = f => { db.exec('BEGIN IMMEDIATE'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const int = (v, min, max, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) bad(400, msg); return n; };
const str = (v, min, max, msg) => { const s = typeof v === 'string' ? v.trim() : ''; if (s.length < min || s.length > max) bad(400, msg); return s; };

// ---- auth ----
const hashPw = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(k, 'hex')); };
const mac = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const sign = u => { const p = Buffer.from(JSON.stringify({ id: u.id, exp: now() + 7 * 864e5 })).toString('base64url'); return p + '.' + mac(p); };
const verify = t => { const [p, m] = String(t || '').split('.'); if (!p || !m) return null; const e = mac(p); if (m.length !== e.length || !crypto.timingSafeEqual(Buffer.from(m), Buffer.from(e))) return null; try { const o = JSON.parse(Buffer.from(p, 'base64url')); return o.exp > now() ? o : null; } catch { return null; } };
const auth = (req, role) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''), t = m && verify(m[1]);
  const u = t && one('SELECT id,username,phone,role,balance FROM users WHERE id=?', t.id);
  if (!u) bad(401, 'กรุณาเข้าสู่ระบบ');
  if (role && u.role !== role) bad(403, 'ไม่มีสิทธิ์เข้าถึง');
  run('UPDATE users SET last_seen=? WHERE id=?', now(), u.id);
  return u;
};
const tries = new Map();
const throttle = (k, max = 10) => { const r = (tries.get(k) || []).filter(x => now() - x < 9e5); if (r.length >= max) bad(429, 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาที'); r.push(now()); tries.set(k, r); };

// ---- money (every change goes through the ledger) ----
const credit = (uid, delta, kind, ref, note) => {
  const r = run('UPDATE users SET balance=balance+? WHERE id=? AND balance+?>=0', delta, uid, delta);
  if (!r.changes) bad(400, 'เครดิตไม่พอ');
  run('INSERT INTO ledger(user_id,delta,kind,ref,note,created) VALUES(?,?,?,?,?,?)', uid, delta, kind, ref || null, note || null, now());
};
const decideTopup = (id, approve) => tx(() => {
  const t = one('SELECT * FROM topups WHERE id=?', id);
  if (!t) bad(404, 'ไม่พบรายการ');
  if (t.status !== 'pending') bad(409, 'รายการนี้ดำเนินการแล้ว');
  run('UPDATE topups SET status=?, decided=? WHERE id=?', approve ? 'approved' : 'rejected', now(), id);
  if (approve) credit(t.user_id, t.amount, 'topup', t.ref, t.method);
  return { ...t, status: approve ? 'approved' : 'rejected' };
});
const discount = (c, s) => (!c || c.remaining < 1 || s < c.minspend) ? 0 : Math.min(s, c.type === 'p' ? Math.floor(s * c.val / 100) : c.val);

const pub = p => ({ id: p.id, name: p.name, price: p.price, descr: p.descr, tags: JSON.parse(p.tags || '[]'), imgs: JSON.parse(p.imgs || '[]'), sold: !!p.sold, views: p.views, created: p.created });
const prodIn = b => ({
  name: str(b.name, 1, 120, 'ชื่อสินค้าไม่ถูกต้อง'), price: int(b.price, 1, 1e7, 'ราคาไม่ถูกต้อง'),
  descr: str(b.descr || '', 0, 500, 'รายละเอียดยาวเกินไป') , cred: str(b.cred || '', 0, 2000, 'ข้อมูลไอดียาวเกินไป'),
  tags: JSON.stringify((Array.isArray(b.tags) ? b.tags : []).slice(0, 12).map(t => String(t).slice(0, 40))),
  imgs: JSON.stringify((Array.isArray(b.imgs) ? b.imgs : []).slice(0, 8).map(String)),
});

// ---- routes ----
const R = [];
const route = (m, re, f) => R.push([m, new RegExp('^' + re + '$'), f]);
const A = f => (req, p, b) => f(auth(req, 'admin'), p, b, req);
const U = f => (req, p, b) => f(auth(req), p, b, req);

route('POST', '/api/register', (req, p, b) => {
  const username = str(b.username, 3, 30, 'ชื่อผู้ใช้ต้องมี 3-30 ตัวอักษร'), phone = str(b.phone, 10, 10, 'เบอร์โทรไม่ถูกต้อง');
  if (!/^0\d{9}$/.test(phone)) bad(400, 'เบอร์โทรไม่ถูกต้อง');
  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) bad(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  try { const r = run('INSERT INTO users(username,phone,pw,created) VALUES(?,?,?,?)', username, phone, hashPw(b.password), now()); return { token: sign({ id: Number(r.lastInsertRowid) }), user: { id: Number(r.lastInsertRowid), username, balance: 0 } }; }
  catch (e) { if (/UNIQUE/.test(e.message)) bad(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว'); throw e; }
});
route('POST', '/api/login', (req, p, b) => {
  const name = String(b.username || '');
  throttle(req.socket.remoteAddress + '|' + name.toLowerCase());
  const u = one('SELECT * FROM users WHERE username=?', name);
  const okPw = u ? checkPw(String(b.password || ''), u.pw) : (crypto.scryptSync('x', 'x', 64), false);
  if (!okPw) bad(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  return { token: sign(u), user: { id: u.id, username: u.username, role: u.role, balance: u.balance } };
});
route('GET', '/api/me', U(u => u));
route('GET', '/api/payinfo', () => ({ truemoney: payTo('truemoney'), kbank: payTo('kbank') }));
route('GET', '/api/products', (req, p, b, url) => q('SELECT * FROM products ORDER BY sold ASC, id DESC').map(pub));
route('GET', '/api/products/(\\d+)', (req, p) => { run('UPDATE products SET views=views+1 WHERE id=?', p[1]); const x = one('SELECT * FROM products WHERE id=?', p[1]); if (!x) bad(404, 'ไม่พบสินค้า'); return pub(x); });
route('POST', '/api/orders', U((u, p, b) => tx(() => {
  const pr = one('SELECT * FROM products WHERE id=?', int(b.product_id, 1, 1e12, 'สินค้าไม่ถูกต้อง'));
  if (!pr) bad(404, 'ไม่พบสินค้า');
  if (!run('UPDATE products SET sold=1 WHERE id=? AND sold=0', pr.id).changes) bad(409, 'ไอดีนี้ขายแล้ว');
  const c = b.coupon ? one('SELECT * FROM coupons WHERE code=?', String(b.coupon).toUpperCase()) : null;
  if (b.coupon && !c) bad(400, 'ไม่พบรหัสคูปอง');
  const d = discount(c, pr.price), total = pr.price - d, no = 'NP' + crypto.randomBytes(5).toString('hex').toUpperCase();
  if (c && d > 0) run('UPDATE coupons SET remaining=remaining-1 WHERE code=? AND remaining>0', c.code);
  credit(u.id, -total, 'purchase', no, pr.name);
  run('INSERT INTO orders(no,user_id,product_id,price,discount,total,coupon,created) VALUES(?,?,?,?,?,?,?,?)', no, u.id, pr.id, pr.price, d, total, d > 0 ? c.code : null, now());
  return { no, product: pr.name, price: pr.price, discount: d, total, credentials: pr.cred };
})));
route('GET', '/api/orders', U(u => q('SELECT o.no,o.product_id,o.price,o.discount,o.total,o.created,p.name product,p.cred credentials FROM orders o JOIN products p ON p.id=o.product_id WHERE o.user_id=? ORDER BY o.id DESC', u.id)));
route('POST', '/api/coupon-check', U((u, p, b) => {
  throttle('cpn|' + u.id, 40);
  const pr = one('SELECT * FROM products WHERE id=?', int(b.product_id, 1, 1e12, 'สินค้าไม่ถูกต้อง'));
  if (!pr) bad(404, 'ไม่พบสินค้า');
  const c = one('SELECT * FROM coupons WHERE code=?', String(b.code || '').toUpperCase());
  if (!c) bad(400, 'ไม่พบรหัสคูปอง');
  if (c.remaining < 1) bad(400, 'คูปองนี้ใช้ครบแล้ว');
  if (pr.price < c.minspend) bad(400, 'ราคาสินค้าต้องไม่ต่ำกว่าขั้นต่ำ ' + c.minspend + ' บาท');
  const d = discount(c, pr.price); return { discount: d, total: pr.price - d };
}));
route('POST', '/api/me/password', U((u, p, b) => {
  throttle('pw|' + u.id);
  if (!checkPw(String(b.current || ''), one('SELECT pw FROM users WHERE id=?', u.id).pw)) bad(401, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
  if (typeof b.next !== 'string' || b.next.length < 8 || b.next.length > 200) bad(400, 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
  run('UPDATE users SET pw=? WHERE id=?', hashPw(b.next), u.id); return { ok: true };
}));
const mask = n => n.slice(0, 2) + '***';
route('GET', '/api/reviews', () => q('SELECT r.stars,r.body,r.created,r.product_id,u.username FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 30').map(r => ({ stars: r.stars, body: r.body, created: r.created, code: String(r.product_id).slice(-5), user: mask(r.username) })));
route('POST', '/api/reviews', U((u, p, b) => {
  const pid = int(b.product_id, 1, 1e12, 'สินค้าไม่ถูกต้อง'), stars = int(b.stars, 1, 5, 'ให้ดาว 1-5'), body = str(b.body, 1, 200, 'เขียนรีวิว 1-200 ตัวอักษร');
  if (!one('SELECT 1 x FROM orders WHERE user_id=? AND product_id=?', u.id, pid)) bad(403, 'รีวิวได้เฉพาะสินค้าที่คุณซื้อแล้ว');
  try { run('INSERT INTO reviews(user_id,product_id,stars,body,created) VALUES(?,?,?,?,?)', u.id, pid, stars, body, now()); } catch (e) { if (/UNIQUE/.test(e.message)) bad(409, 'คุณรีวิวสินค้านี้แล้ว'); throw e; }
  return { ok: true };
}));
route('POST', '/api/topups', U((u, p, b) => {
  if (!['truemoney', 'kbank'].includes(b.method)) bad(400, 'ช่องทางชำระเงินไม่ถูกต้อง');
  const amount = int(b.amount, 20, 50000, 'จำนวนเงิน 20 ถึง 50,000 บาท'), ref = 'TP' + crypto.randomBytes(6).toString('hex').toUpperCase();
  run('INSERT INTO topups(user_id,method,amount,ref,created) VALUES(?,?,?,?,?)', u.id, b.method, amount, ref, now());
  return { ref, amount, method: b.method, pay_to: payTo(b.method), status: 'pending', note: 'เครดิตจะเพิ่มเมื่อยืนยันยอดแล้ว เติมแล้วขอคืนไม่ได้ ใช้ซื้อรหัสในเว็บเท่านั้น' };
}));
route('POST', '/api/topups/(TP[0-9A-F]+)/slip', U((u, p, b) => {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
  if (!m || m[2].length > 4.2e6) bad(400, 'ไฟล์สลิปต้องเป็นรูป jpg/png/webp ขนาดไม่เกิน 3MB');
  const t = one('SELECT * FROM topups WHERE ref=? AND user_id=?', p[1], u.id);
  if (!t) bad(404, 'ไม่พบรายการ'); if (t.status !== 'pending') bad(409, 'รายการนี้ดำเนินการแล้ว');
  run('UPDATE topups SET slip=? WHERE id=?', b.image, t.id); return { ok: true };
}));
route('GET', '/api/topups', U(u => q('SELECT ref,method,amount,status,created FROM topups WHERE user_id=? ORDER BY id DESC', u.id)));
route('POST', '/api/tickets', U((u, p, b) => { run('INSERT INTO tickets(user_id,subject,body,created) VALUES(?,?,?,?)', u.id, str(b.subject, 1, 80, 'กรอกหัวข้อ'), str(b.body, 1, 1000, 'กรอกรายละเอียด'), now()); return { ok: true }; }));
route('GET', '/api/tickets', U(u => q('SELECT id,subject,body,reply,created FROM tickets WHERE user_id=? ORDER BY id DESC', u.id)));
// Payment-provider callback (provider-agnostic). Body must be signed: x-signature = hex HMAC-SHA256(rawBody, WEBHOOK_SECRET)
route('POST', '/api/webhook/payment', (req, p, b) => {
  if (!WEBHOOK_SECRET) bad(503, 'webhook ยังไม่ได้ตั้งค่า');
  const sig = String(req.headers['x-signature'] || ''), exp = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.raw).digest('hex');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) bad(401, 'signature ไม่ถูกต้อง');
  const t = one('SELECT * FROM topups WHERE ref=?', String(b.ref || ''));
  if (!t) bad(404, 'ไม่พบรายการ');
  if (b.status !== 'paid' || +b.amount !== t.amount) bad(400, 'ยอดหรือสถานะไม่ตรง');
  if (t.status === 'approved') return { ok: true, duplicate: true };
  decideTopup(t.id, true); return { ok: true };
});

// admin
route('GET', '/api/admin/stats', A(() => ({
  products_ready: one('SELECT COUNT(*) n FROM products WHERE sold=0').n, products_sold: one('SELECT COUNT(*) n FROM products WHERE sold=1').n,
  orders: one('SELECT COUNT(*) n FROM orders').n, sales: one('SELECT COALESCE(SUM(total),0) n FROM orders').n,
  members: one("SELECT COUNT(*) n FROM users WHERE role='user'").n, credit_total: one('SELECT COALESCE(SUM(balance),0) n FROM users').n,
  topups_pending: one("SELECT COUNT(*) n FROM topups WHERE status='pending'").n, tickets_open: one('SELECT COUNT(*) n FROM tickets WHERE reply IS NULL').n })));
route('GET', '/api/admin/products', A(() => q('SELECT * FROM products ORDER BY id DESC').map(x => ({ ...pub(x), cred: x.cred }))));
route('POST', '/api/admin/products', A((u, p, b) => { const x = prodIn(b); return { id: Number(run('INSERT INTO products(name,price,descr,tags,imgs,cred,created) VALUES(?,?,?,?,?,?,?)', x.name, x.price, x.descr, x.tags, x.imgs, x.cred, now()).lastInsertRowid) }; }));
route('PUT', '/api/admin/products/(\\d+)', A((u, p, b) => { const x = prodIn(b); if (!run('UPDATE products SET name=?,price=?,descr=?,tags=?,imgs=?,cred=?,sold=? WHERE id=?', x.name, x.price, x.descr, x.tags, x.imgs, x.cred, b.sold ? 1 : 0, p[1]).changes) bad(404, 'ไม่พบสินค้า'); return { ok: true }; }));
route('DELETE', '/api/admin/products/(\\d+)', A((u, p) => { if (one('SELECT 1 x FROM orders WHERE product_id=?', p[1])) bad(409, 'สินค้ามีประวัติการขาย ลบไม่ได้'); run('DELETE FROM products WHERE id=?', p[1]); return { ok: true }; }));
route('GET', '/api/admin/coupons', A(() => q('SELECT * FROM coupons')));
route('POST', '/api/admin/coupons', A((u, p, b) => {
  const code = String(b.code || '').toUpperCase(); if (!/^[A-Z0-9]{3,20}$/.test(code)) bad(400, 'รหัสคูปองใช้ A-Z และตัวเลข 3-20 ตัว');
  if (!['p', 'b'].includes(b.type)) bad(400, 'ประเภทคูปองไม่ถูกต้อง');
  const val = int(b.val, 1, b.type === 'p' ? 100 : 1e6, 'ส่วนลดไม่ถูกต้อง');
  try { run('INSERT INTO coupons VALUES(?,?,?,?,?)', code, b.type, val, int(b.minspend ?? 0, 0, 1e7, 'ขั้นต่ำไม่ถูกต้อง'), int(b.remaining, 1, 1e6, 'จำนวนครั้งไม่ถูกต้อง')); } catch (e) { if (/UNIQUE|PRIMARY/.test(e.message)) bad(409, 'รหัสนี้มีอยู่แล้ว'); throw e; }
  return { ok: true };
}));
route('DELETE', '/api/admin/coupons/([A-Za-z0-9]+)', A((u, p) => { run('DELETE FROM coupons WHERE code=?', p[1].toUpperCase()); return { ok: true }; }));
route('GET', '/api/admin/members', A(() => q("SELECT id,username,phone,balance,created,last_seen FROM users WHERE role='user' ORDER BY id DESC")));
route('POST', '/api/admin/members/(\\d+)/adjust', A((u, p, b) => tx(() => {
  const delta = int(b.delta, -1e6, 1e6, 'จำนวนไม่ถูกต้อง'); if (!delta) bad(400, 'จำนวนไม่ถูกต้อง');
  if (!one('SELECT 1 x FROM users WHERE id=?', p[1])) bad(404, 'ไม่พบสมาชิก');
  credit(+p[1], delta, 'admin_adjust', 'by:' + u.username, str(b.reason, 3, 200, 'ต้องระบุเหตุผลอย่างน้อย 3 ตัวอักษร')); return { ok: true };
})));
route('GET', '/api/admin/ledger/(\\d+)', A((u, p) => q('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 200', p[1])));
route('GET', '/api/admin/orders', A(() => q('SELECT o.no,o.price,o.discount,o.total,o.coupon,o.created,u.username,p.name product FROM orders o JOIN users u ON u.id=o.user_id JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 500')));
route('GET', '/api/admin/topups/(\\d+)/slip', A((u, p) => ({ slip: (one('SELECT slip FROM topups WHERE id=?', p[1]) || {}).slip || null })));
route('GET', '/api/admin/topups', A(() => q('SELECT t.id,t.ref,t.method,t.amount,t.status,t.created,(t.slip IS NOT NULL) has_slip,u.username FROM topups t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 500')));
route('POST', '/api/admin/topups/(\\d+)/(approve|reject)', A((u, p) => decideTopup(+p[1], p[2] === 'approve')));
route('GET', '/api/admin/tickets', A(() => q('SELECT t.id,t.subject,t.body,t.reply,t.created,u.username FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 500')));
route('POST', '/api/admin/tickets/(\\d+)/reply', A((u, p, b) => { run('UPDATE tickets SET reply=? WHERE id=?', str(b.reply, 1, 1000, 'พิมพ์คำตอบ'), p[1]); return { ok: true }; }));

// ---- server ----
const PUB = path.resolve(__dirname, 'public'), TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 8e6) { res.writeHead(413).end(); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x'), sec = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
    const send = (c, d) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...sec }); res.end(JSON.stringify(d)); };
    if (url.pathname.startsWith('/api/')) {
      try {
        req.raw = Buffer.concat(chunks); let b = {};
        if (req.raw.length) try { b = JSON.parse(req.raw.toString('utf8')); } catch { bad(400, 'JSON ไม่ถูกต้อง'); }
        for (const [m, re, f] of R) { const p = re.exec(url.pathname); if (m === req.method && p) return send(200, f(req, p, b, url)); }
        bad(404, 'ไม่พบ API');
      } catch (e) { if (e instanceof HttpErr) return send(e.c, { error: e.message }); console.error(e); return send(500, { error: 'เกิดข้อผิดพลาดของระบบ' }); }
    }
    const f = path.join(PUB, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, sec); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', ...sec }); fs.createReadStream(f).pipe(res);
  });
});

if (process.env.ADMIN_USER && process.env.ADMIN_PASS && !one('SELECT 1 x FROM users WHERE username=?', process.env.ADMIN_USER)) {
  if (process.env.ADMIN_PASS.length < 10) { console.error('ADMIN_PASS ต้องยาวอย่างน้อย 10 ตัวอักษร'); process.exit(1); }
  run("INSERT INTO users(username,pw,role,created) VALUES(?,?, 'admin',?)", process.env.ADMIN_USER, hashPw(process.env.ADMIN_PASS), now());
  console.log('สร้างผู้ดูแลแล้ว:', process.env.ADMIN_USER);
}
server.listen(PORT, () => console.log('Nongpoom Shop backend on :' + PORT));

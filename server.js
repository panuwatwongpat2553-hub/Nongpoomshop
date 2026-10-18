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
// LINE alerts to the shop owner (Messaging API push). Off unless both variables are set. Free plans have a small monthly quota, so only actionable events notify and a monthly cap applies.
const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || '', LINE_TO = process.env.LINE_ADMIN_USER_ID || '', LINE_API = process.env.LINE_API || 'https://api.line.me', LINE_MAX = +process.env.LINE_MAX_PER_MONTH || 150;
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

for (const m of ['ALTER TABLE topups ADD COLUMN slip TEXT', 'ALTER TABLE topups ADD COLUMN slip_hash TEXT', 'ALTER TABLE users ADD COLUMN tv INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN owner INTEGER NOT NULL DEFAULT 0']) try { db.exec(m); } catch {}
db.exec('CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL, admin_name TEXT NOT NULL, action TEXT NOT NULL, target_id INTEGER, target_name TEXT, detail TEXT, created INTEGER NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
class HttpErr extends Error { constructor(c, m) { super(m); this.c = c; } }
const bad = (c, m) => { throw new HttpErr(c, m); };
const now = () => Date.now();
const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const tx = f => { db.exec('BEGIN IMMEDIATE'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const int = (v, min, max, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) bad(400, msg); return n; };
const str = (v, min, max, msg) => { const s = typeof v === 'string' ? v.trim() : ''; if (s.length < min || s.length > max) bad(400, msg); return s; };

const notify = text => {
  if (!LINE_TOKEN || !LINE_TO) return;
  const key = 'line:' + new Date().toISOString().slice(0, 7);
  if (((one('SELECT v FROM kv WHERE k=?', key) || {}).v || 0) >= LINE_MAX) return;
  run('INSERT INTO kv(k,v) VALUES(?,1) ON CONFLICT(k) DO UPDATE SET v=v+1', key);
  fetch(LINE_API + '/v2/bot/message/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN }, body: JSON.stringify({ to: LINE_TO, messages: [{ type: 'text', text: String(text).slice(0, 900) }] }) })
    .then(r => { if (!r.ok) console.error('LINE notify HTTP', r.status); }).catch(e => console.error('LINE notify failed:', e.message));
};

// ---- auth ----
const hashPw = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(k, 'hex')); };
const mac = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const sign = u => { const p = Buffer.from(JSON.stringify({ id: u.id, tv: u.tv || 0, exp: now() + 7 * 864e5 })).toString('base64url'); return p + '.' + mac(p); };
const verify = t => { const [p, m] = String(t || '').split('.'); if (!p || !m) return null; const e = mac(p); if (m.length !== e.length || !crypto.timingSafeEqual(Buffer.from(m), Buffer.from(e))) return null; try { const o = JSON.parse(Buffer.from(p, 'base64url')); return o.exp > now() ? o : null; } catch { return null; } };
const auth = (req, role) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''), t = m && verify(m[1]);
  const u = t && one('SELECT id,username,phone,role,balance,tv,owner FROM users WHERE id=?', t.id);
  if (!u || (t.tv || 0) !== u.tv) bad(401, 'กรุณาเข้าสู่ระบบ');
  if (role && u.role !== role) bad(403, 'ไม่มีสิทธิ์เข้าถึง');
  run('UPDATE users SET last_seen=? WHERE id=?', now(), u.id);
  return u;
};
const tries = new Map();
const throttle = (k, max = 10) => { const r = (tries.get(k) || []).filter(x => now() - x < 9e5); if (r.length >= max) bad(429, 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาที'); r.push(now()); tries.set(k, r); };

const audit = (adm, action, target, detail) => run('INSERT INTO audit(admin_id,admin_name,action,target_id,target_name,detail,created) VALUES(?,?,?,?,?,?,?)', adm.id, adm.username, action, target ? target.id : null, target ? target.username : null, detail || null, now());
// A transfer slip must be a real jpg/png/webp (checked by file signature, not just the declared type) and may only be used once.
const parseSlip = v => {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(v || ''));
  if (!m || m[2].length > 4.2e6) bad(400, 'ต้องแนบสลิปเป็นรูป jpg/png/webp ขนาดไม่เกิน 3MB');
  const buf = Buffer.from(m[2], 'base64'), head = buf.subarray(0, 12);
  const okSig = m[1] === 'png' ? head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : m[1] === 'jpeg' ? head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    : head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!okSig) bad(400, 'ไฟล์สลิปไม่ใช่รูปภาพที่ถูกต้อง');
  return { image: String(v), hash: crypto.createHash('sha256').update(buf).digest('hex') };
};

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
  if (approve && !t.slip) bad(400, 'รายการนี้ไม่มีสลิป อนุมัติไม่ได้');
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
  return { token: sign(u), user: { id: u.id, username: u.username, role: u.role, owner: !!u.owner, balance: u.balance } };
});
route('GET', '/api/me', U(({ tv, ...u }) => u));
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
  run('UPDATE users SET pw=?, tv=tv+1 WHERE id=?', hashPw(b.next), u.id); return { ok: true, token: sign({ id: u.id, tv: u.tv + 1 }) };
}));
const mask = n => n.slice(0, 2) + '***';
route('GET', '/api/reviews', () => q('SELECT r.stars,r.body,r.created,r.product_id,u.username FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 30').map(r => ({ stars: r.stars, body: r.body, created: r.created, code: String(r.product_id).slice(-5), user: mask(r.username) })));
// public storefront stats (real numbers only; no personal data)
route('GET', '/api/public/stats', () => {
  const r = one('SELECT COUNT(*) n, COALESCE(AVG(stars),0) avg FROM reviews');
  return { ready: one('SELECT COUNT(*) n FROM products WHERE sold=0').n, orders: one('SELECT COUNT(*) n FROM orders').n,
    members: one("SELECT COUNT(*) n FROM users WHERE role='user'").n, reviews: r.n, rating: Math.round(r.avg * 10) / 10 };
});
route('GET', '/api/recent-sales', () => q('SELECT o.created,o.product_id,p.name,u.username FROM orders o JOIN products p ON p.id=o.product_id JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 8')
  .map(r => ({ created: r.created, code: String(r.product_id).slice(-5), name: r.name, user: mask(r.username) })));
route('POST', '/api/reviews', U((u, p, b) => {
  const pid = int(b.product_id, 1, 1e12, 'สินค้าไม่ถูกต้อง'), stars = int(b.stars, 1, 5, 'ให้ดาว 1-5'), body = str(b.body, 1, 200, 'เขียนรีวิว 1-200 ตัวอักษร');
  if (!one('SELECT 1 x FROM orders WHERE user_id=? AND product_id=?', u.id, pid)) bad(403, 'รีวิวได้เฉพาะสินค้าที่คุณซื้อแล้ว');
  try { run('INSERT INTO reviews(user_id,product_id,stars,body,created) VALUES(?,?,?,?,?)', u.id, pid, stars, body, now()); } catch (e) { if (/UNIQUE/.test(e.message)) bad(409, 'คุณรีวิวสินค้านี้แล้ว'); throw e; }
  return { ok: true };
}));
route('POST', '/api/topups', U((u, p, b) => {
  throttle('tp|' + u.id, 20);
  if (!['truemoney', 'kbank'].includes(b.method)) bad(400, 'ช่องทางชำระเงินไม่ถูกต้อง');
  const amount = int(b.amount, 20, 50000, 'จำนวนเงิน 20 ถึง 50,000 บาท');
  if (!b.slip) bad(400, 'ต้องแนบสลิปการโอนเงินทุกครั้ง ไม่มีสลิประบบจะไม่รับรายการ');
  const sl = parseSlip(b.slip), ref = 'TP' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const t = tx(() => {
    if (one('SELECT 1 x FROM topups WHERE slip_hash=?', sl.hash)) bad(409, 'สลิปนี้เคยถูกส่งมาแล้ว กรุณาแนบสลิปของการโอนครั้งนี้');
    if (one("SELECT COUNT(*) n FROM topups WHERE user_id=? AND status='pending'", u.id).n >= 5) bad(429, 'มีรายการรอตรวจสอบหลายรายการแล้ว กรุณารอร้านตรวจสอบก่อน');
    run('INSERT INTO topups(user_id,method,amount,ref,slip,slip_hash,created) VALUES(?,?,?,?,?,?,?)', u.id, b.method, amount, ref, sl.image, sl.hash, now());
    return { ref, amount, method: b.method, status: 'pending' };
  });
  notify(`💰 สลิปเติมเงินใหม่\nรายการ ${ref}\nยอด ${amount} บาท (${b.method})\nสมาชิก ${u.username}\nตรวจยอดเข้าบัญชีแล้วอนุมัติที่หน้าแอดมิน`);
  return { ...t, note: 'ส่งสลิปแล้ว เครดิตจะเพิ่มเมื่อร้านตรวจสอบยอดเข้าบัญชีแล้ว เติมแล้วขอคืนไม่ได้ ใช้ซื้อรหัสในเว็บเท่านั้น' };
}));
route('GET', '/api/topups', U(u => q('SELECT ref,method,amount,status,created FROM topups WHERE user_id=? ORDER BY id DESC', u.id)));
route('POST', '/api/tickets', U((u, p, b) => { const subj = str(b.subject, 1, 80, 'กรอกหัวข้อ'); run('INSERT INTO tickets(user_id,subject,body,created) VALUES(?,?,?,?)', u.id, subj, str(b.body, 1, 1000, 'กรอกรายละเอียด'), now()); notify(`📩 มีเรื่องแจ้งใหม่\nจาก ${u.username}\nหัวข้อ: ${subj}`); return { ok: true }; }));
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
const member = id => one('SELECT id,username,phone,role,owner,balance,created,last_seen FROM users WHERE id=?', id) || bad(404, 'ไม่พบสมาชิก');
route('GET', '/api/admin/members', A(() => q('SELECT id,username,phone,role,owner,balance,created,last_seen FROM users ORDER BY role=\'admin\' DESC, id DESC')));
// everything about one customer. Passwords are stored as one-way hashes and cannot be read back; use the reset route instead.
route('GET', '/api/admin/members/(\\d+)', A((u, p) => ({ member: member(+p[1]),
  orders: q('SELECT o.no,o.price,o.discount,o.total,o.coupon,o.created,p.name product,p.cred credentials FROM orders o JOIN products p ON p.id=o.product_id WHERE o.user_id=? ORDER BY o.id DESC LIMIT 100', p[1]),
  topups: q('SELECT id,ref,method,amount,status,created,decided FROM topups WHERE user_id=? ORDER BY id DESC LIMIT 100', p[1]),
  tickets: q('SELECT id,subject,body,reply,created FROM tickets WHERE user_id=? ORDER BY id DESC LIMIT 50', p[1]),
  ledger: q('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100', p[1]) })));
route('POST', '/api/admin/members/(\\d+)/adjust', A((u, p, b) => tx(() => {
  const m = member(+p[1]); let delta;
  if (b.set !== undefined && b.set !== null && b.set !== '') delta = int(b.set, 0, 1e9, 'ยอดที่ตั้งไม่ถูกต้อง') - m.balance;
  else delta = int(b.delta, -1e9, 1e9, 'จำนวนไม่ถูกต้อง');
  if (!delta) bad(400, 'จำนวนไม่ถูกต้อง หรือยอดเท่าเดิมอยู่แล้ว');
  const reason = str(b.reason, 3, 200, 'ต้องระบุเหตุผลอย่างน้อย 3 ตัวอักษร');
  credit(m.id, delta, 'admin_adjust', 'by:' + u.username, reason);
  audit(u, 'adjust_credit', m, `${delta > 0 ? '+' : ''}${delta} (${m.balance} → ${m.balance + delta}) เหตุผล: ${reason}`);
  return { ok: true, balance: m.balance + delta };
})));
// Reset a member's password (blank = generate a random one, shown once). Old logins stop working. Only the owner may reset another admin.
route('POST', '/api/admin/members/(\\d+)/password', A((u, p, b) => {
  const m = member(+p[1]);
  if (m.role === 'admin' && m.id !== u.id && !u.owner) bad(403, 'เฉพาะเจ้าของร้านเท่านั้นที่รีเซ็ตรหัสผ่านของผู้ดูแลคนอื่นได้');
  let pw = b.password;
  if (pw === undefined || pw === null || pw === '') pw = Array.from(crypto.randomBytes(10), x => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 55]).join('');
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) bad(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  run('UPDATE users SET pw=?, tv=tv+1 WHERE id=?', hashPw(pw), m.id);
  audit(u, 'reset_password', m);
  return { ok: true, username: m.username, password: pw };
}));
// Appoint / remove an admin. Owner only; the owner cannot be demoted and nobody can change their own role.
route('POST', '/api/admin/members/(\\d+)/role', A((u, p, b) => {
  if (!u.owner) bad(403, 'เฉพาะเจ้าของร้านเท่านั้นที่ตั้งหรือถอดผู้ดูแลได้');
  if (!['admin', 'user'].includes(b.role)) bad(400, 'สิทธิ์ไม่ถูกต้อง');
  const m = member(+p[1]);
  if (m.owner || m.id === u.id) bad(400, 'เปลี่ยนสิทธิ์ของเจ้าของร้านหรือของตัวเองไม่ได้');
  run('UPDATE users SET role=?, tv=tv+1 WHERE id=?', b.role, m.id);
  audit(u, b.role === 'admin' ? 'make_admin' : 'remove_admin', m);
  return { ok: true };
}));
route('GET', '/api/admin/audit', A(() => q('SELECT * FROM audit ORDER BY id DESC LIMIT 300')));
route('GET', '/api/admin/ledger/(\\d+)', A((u, p) => q('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 200', p[1])));
route('GET', '/api/admin/orders', A(() => q('SELECT o.no,o.price,o.discount,o.total,o.coupon,o.created,u.username,p.name product FROM orders o JOIN users u ON u.id=o.user_id JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 500')));
route('GET', '/api/admin/topups/(\\d+)/slip', A((u, p) => ({ slip: (one('SELECT slip FROM topups WHERE id=?', p[1]) || {}).slip || null })));
route('GET', '/api/admin/topups', A(() => q('SELECT t.id,t.ref,t.method,t.amount,t.status,t.created,(t.slip IS NOT NULL) has_slip,u.username FROM topups t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 500')));
route('POST', '/api/admin/topups/(\\d+)/(approve|reject)', A((u, p) => { const t = decideTopup(+p[1], p[2] === 'approve'); audit(u, 'topup_' + t.status, one('SELECT id,username FROM users WHERE id=?', t.user_id), `${t.ref} ${t.amount} บาท`); return t; }));
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
// Owner = the ADMIN_USER account (or the oldest admin). Only the owner can appoint/remove admins.
if (!one('SELECT 1 x FROM users WHERE owner=1')) {
  const o = one("SELECT id FROM users WHERE username=? AND role='admin'", process.env.ADMIN_USER || '') || one("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  if (o) run('UPDATE users SET owner=1 WHERE id=?', o.id);
}
// Slips are now mandatory: any older pending top-up with no slip is closed (nothing was credited for it).
run("UPDATE topups SET status='rejected', decided=? WHERE status='pending' AND slip IS NULL", now());
// One-time cleanup after the layaway feature was removed: refund everything still held (fees included) and release reserved IDs, so no member loses money and no ID stays locked.
try {
  if (one("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='plans'")) {
    for (const p of q("SELECT id,user_id FROM plans WHERE status='active'")) tx(() => {
      const paid = one('SELECT COALESCE(SUM(amount),0) s FROM installments WHERE plan_id=? AND paid IS NOT NULL', p.id).s;
      run("UPDATE plans SET status='cancelled' WHERE id=?", p.id);
      if (paid > 0) credit(p.user_id, paid, 'installment_refund', 'plan:' + p.id, 'ยกเลิกระบบจองผ่อน คืนเครดิตเต็มจำนวน');
    });
    if (one("SELECT 1 x FROM pragma_table_info('products') WHERE name='reserved'")) run('UPDATE products SET reserved=0 WHERE reserved=1');
  }
} catch (e) { console.error('layaway cleanup', e); }
server.listen(PORT, () => console.log('Nongpoom Shop backend on :' + PORT));

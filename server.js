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
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const REF_BONUS = +process.env.REF_BONUS || 20, REF_BONUS_NEW = +process.env.REF_BONUS_NEW || 0, REF_MIN = +process.env.REF_MIN_TOPUP || 100, REF_MAX = +process.env.REF_MAX_REWARDS || 50;
const REQUIRE_2FA = process.env.ADMIN_2FA_REQUIRED === '1';
const BACKUP_KEEP = +process.env.BACKUP_KEEP || 14, BACKUP_HOURS = +process.env.BACKUP_EVERY_HOURS || 24;
// สมาชิกระดับต่าง ๆ ตามยอดซื้อสะสม (บาท) ส่วนลดคิดจากราคาขายอัตโนมัติ
const SECRET = process.env.APP_SECRET || (console.warn('WARNING: APP_SECRET not set; logins reset on restart'), crypto.randomBytes(32).toString('hex'));
const db = new DatabaseSync(DB_FILE);
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(DB_FILE)), 'backups');
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, phone TEXT, pw TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), created INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>0), descr TEXT, tags TEXT, imgs TEXT, cred TEXT, sold INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coupons(code TEXT PRIMARY KEY, type TEXT NOT NULL, val INTEGER NOT NULL, minspend INTEGER NOT NULL DEFAULT 0, remaining INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, no TEXT UNIQUE, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, price INTEGER NOT NULL, discount INTEGER NOT NULL, total INTEGER NOT NULL, coupon TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS topups(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, method TEXT NOT NULL, amount INTEGER NOT NULL, ref TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, decided INTEGER);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, delta INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, note TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), body TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(user_id,product_id));
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, reply TEXT, created INTEGER NOT NULL);`);

for (const m of ['ALTER TABLE topups ADD COLUMN slip TEXT', 'ALTER TABLE topups ADD COLUMN slip_hash TEXT', 'ALTER TABLE users ADD COLUMN tv INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN owner INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE products ADD COLUMN cost INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE products ADD COLUMN sale_price INTEGER', 'ALTER TABLE products ADD COLUMN sale_end INTEGER',
  'ALTER TABLE orders ADD COLUMN cost INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE orders ADD COLUMN tier_disc INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE orders ADD COLUMN accepted INTEGER',
  'ALTER TABLE users ADD COLUMN ref_code TEXT', 'ALTER TABLE users ADD COLUMN referred_by INTEGER', 'ALTER TABLE users ADD COLUMN ref_paid INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN reg_ip TEXT',
  'ALTER TABLE users ADD COLUMN totp_secret TEXT', 'ALTER TABLE users ADD COLUMN totp_on INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN totp_last INTEGER NOT NULL DEFAULT 0']) try { db.exec(m); } catch {}
db.exec('CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL, admin_name TEXT NOT NULL, action TEXT NOT NULL, target_id INTEGER, target_name TEXT, detail TEXT, created INTEGER NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
db.exec(`CREATE TABLE IF NOT EXISTS favorites(user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(user_id,product_id));
CREATE TABLE IF NOT EXISTS watch(user_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(user_id,tag));
CREATE TABLE IF NOT EXISTS notifs(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, body TEXT NOT NULL, product_id INTEGER, created INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS notifs_u ON notifs(user_id,id);
CREATE TABLE IF NOT EXISTS flags(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT, created INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS users_ref ON users(ref_code);`);
db.exec(`CREATE TABLE IF NOT EXISTS boxes(id INTEGER PRIMARY KEY, name TEXT NOT NULL, descr TEXT, price INTEGER NOT NULL CHECK(price>0), active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS box_items(id INTEGER PRIMARY KEY, box_id INTEGER NOT NULL, kind TEXT NOT NULL, product_id INTEGER, credit_amt INTEGER, weight INTEGER NOT NULL CHECK(weight>0), label TEXT, created INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS box_items_prod ON box_items(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS box_items_box ON box_items(box_id);
CREATE TABLE IF NOT EXISTS box_draws(id INTEGER PRIMARY KEY, box_id INTEGER NOT NULL, user_id INTEGER NOT NULL, item_id INTEGER, kind TEXT NOT NULL, label TEXT, price INTEGER NOT NULL, credit INTEGER, product_id INTEGER, order_no TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS box_draws_u ON box_draws(user_id,id);`);
class HttpErr extends Error { constructor(c, m, x) { super(m); this.c = c; this.x = x; } }
const bad = (c, m, x) => { throw new HttpErr(c, m, x); };
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

const ipOf = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
const ipHash = req => crypto.createHash('sha256').update(ipOf(req) + SECRET).digest('hex').slice(0, 16);
const newRef = () => { for (;;) { const c = 'NP' + Array.from(crypto.randomBytes(5), x => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 32]).join(''); if (!one('SELECT 1 x FROM users WHERE ref_code=?', c)) return c; } };
for (const r of q('SELECT id FROM users WHERE ref_code IS NULL')) run('UPDATE users SET ref_code=? WHERE id=?', newRef(), r.id);

// ---- 2FA (TOTP, RFC 6238 — compatible with Google Authenticator / Authy) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32enc = buf => { let bits = 0, v = 0, o = ''; for (const x of buf) { v = (v << 8) | x; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += B32[(v << (5 - bits)) & 31]; return o; };
const b32dec = s => { let bits = 0, v = 0; const o = []; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; v = (v << 5) | i; bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const hotp = (key, ctr) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(ctr)); const h = crypto.createHmac('sha1', key).update(b).digest(), o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };
// returns the matched time step (so a code can be used only once) or 0
const totpStep = (secret, code, last = 0) => { code = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) return 0; const k = b32dec(secret), c = Math.floor(now() / 30000); for (const d of [-1, 0, 1]) if (c + d > last && crypto.timingSafeEqual(Buffer.from(hotp(k, c + d)), Buffer.from(code))) return c + d; return 0; };

// ---- auth ----
const hashPw = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(k, 'hex')); };
const mac = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const sign = u => { const p = Buffer.from(JSON.stringify({ id: u.id, tv: u.tv || 0, exp: now() + 7 * 864e5 })).toString('base64url'); return p + '.' + mac(p); };
const verify = t => { const [p, m] = String(t || '').split('.'); if (!p || !m) return null; const e = mac(p); if (m.length !== e.length || !crypto.timingSafeEqual(Buffer.from(m), Buffer.from(e))) return null; try { const o = JSON.parse(Buffer.from(p, 'base64url')); return o.exp > now() ? o : null; } catch { return null; } };
const auth = (req, role) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''), t = m && verify(m[1]);
  const u = t && one('SELECT id,username,phone,role,balance,tv,owner,totp_on FROM users WHERE id=?', t.id);
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
const FLAG_TH = { multi_account: 'หลายบัญชีจากเครือข่ายเดียวกัน', rapid_topup: 'ส่งสลิปถี่ผิดปกติ', large_first_topup: 'เติมเงินก้อนใหญ่ครั้งแรก', similar_topup: 'ยอดเติมตรงกับสมาชิกอื่น', many_orders: 'ซื้อถี่ผิดปกติ', self_referral: 'แนะนำเพื่อนจากเครือข่ายเดียวกัน' };
// Flags are advisory only: they never block anyone, they just put the case in front of the admin.
const flag = (uid, kind, detail) => {
  if (one('SELECT 1 x FROM flags WHERE user_id=? AND kind=? AND resolved=0', uid, kind)) return;
  run('INSERT INTO flags(user_id,kind,detail,created) VALUES(?,?,?,?)', uid, kind, detail || null, now());
  if (kind !== 'similar_topup') notify(`⚠️ พฤติกรรมน่าสงสัย: ${FLAG_TH[kind] || kind}\nสมาชิก ${(one('SELECT username FROM users WHERE id=?', uid) || {}).username}\n${detail || ''}`);
};
const addNotif = (uid, body, pid) => run('INSERT INTO notifs(user_id,body,product_id,created) VALUES(?,?,?,?)', uid, body, pid || null, now());
// Referral: paid once, on the referred member's first approved top-up of at least REF_MIN baht.
const refReward = t => {
  const u = one('SELECT * FROM users WHERE id=?', t.user_id);
  if (!u || !u.referred_by || u.ref_paid || t.amount < REF_MIN) return;
  const r = one('SELECT * FROM users WHERE id=?', u.referred_by);
  run('UPDATE users SET ref_paid=1 WHERE id=?', u.id);
  if (!r) return;
  if (r.reg_ip && r.reg_ip === u.reg_ip) return flag(u.id, 'self_referral', `ผู้แนะนำ ${r.username} สมัครจากเครือข่ายเดียวกัน ไม่จ่ายโบนัส`);
  if (one("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND kind='referral'", r.id).n >= REF_MAX) return;
  credit(r.id, REF_BONUS, 'referral', 'from:' + u.username, 'โบนัสแนะนำเพื่อน');
  addNotif(r.id, `🎁 เพื่อนที่คุณแนะนำเติมเงินครั้งแรกแล้ว ได้รับโบนัส ${REF_BONUS} บาท`);
  if (REF_BONUS_NEW) { credit(u.id, REF_BONUS_NEW, 'referral_new', 'ref:' + r.username, 'โบนัสสมาชิกใหม่ที่มีผู้แนะนำ'); addNotif(u.id, `🎁 ได้รับโบนัสสมาชิกใหม่ ${REF_BONUS_NEW} บาท`); }
};
const spent = uid => one('SELECT COALESCE(SUM(total),0) n FROM orders WHERE user_id=?', uid).n;
const salePrice = p => (p.sale_price && p.sale_end > now() && p.sale_price < p.price) ? p.sale_price : null;
const effPrice = p => salePrice(p) ?? p.price;
const decideTopup = (id, approve) => tx(() => {
  const t = one('SELECT * FROM topups WHERE id=?', id);
  if (!t) bad(404, 'ไม่พบรายการ');
  if (t.status !== 'pending') bad(409, 'รายการนี้ดำเนินการแล้ว');
  if (approve && !t.slip) bad(400, 'รายการนี้ไม่มีสลิป อนุมัติไม่ได้');
  run('UPDATE topups SET status=?, decided=? WHERE id=?', approve ? 'approved' : 'rejected', now(), id);
  if (approve) { credit(t.user_id, t.amount, 'topup', t.ref, t.method); refReward(t); }
  return { ...t, status: approve ? 'approved' : 'rejected' };
});
const discount = (c, s) => (!c || c.remaining < 1 || s < c.minspend) ? 0 : Math.min(s, c.type === 'p' ? Math.floor(s * c.val / 100) : c.val);

// List views carry only the first photo (img_count says how many exist); the full set is loaded per product.
const pub = (p, full) => { const all = JSON.parse(p.imgs || '[]'), sp = salePrice(p); return { id: p.id, name: p.name, price: p.price, sale_price: sp, sale_end: sp ? p.sale_end : null, descr: p.descr, tags: JSON.parse(p.tags || '[]'), imgs: full ? all : all.slice(0, 1), img_count: all.length, sold: !!p.sold, views: p.views, created: p.created }; };
const MAX_IMGS = 70;
const prodIn = (b, old) => {
  const price = int(b.price, 1, 1e7, 'ราคาไม่ถูกต้อง');
  let sale_price = null, sale_end = null;
  if (b.sale_price !== undefined && b.sale_price !== null && b.sale_price !== '') {
    sale_price = int(b.sale_price, 1, 1e7, 'ราคาโปรไม่ถูกต้อง');
    if (sale_price >= price) bad(400, 'ราคาโปรต้องต่ำกว่าราคาปกติ');
    sale_end = Number(b.sale_end);
    if (!Number.isFinite(sale_end)) bad(400, 'ระบุเวลาสิ้นสุดโปรโมชัน');
    if (sale_end <= now()) { sale_price = null; sale_end = null; }
  }
  return {
    name: str(b.name, 1, 120, 'ชื่อสินค้าไม่ถูกต้อง'), price, sale_price, sale_end, cost: int(b.cost ?? 0, 0, 1e7, 'ต้นทุนไม่ถูกต้อง'),
    descr: str(b.descr || '', 0, 500, 'รายละเอียดยาวเกินไป'), cred: str(b.cred || '', 0, 2000, 'ข้อมูลไอดียาวเกินไป'),
    tags: JSON.stringify((Array.isArray(b.tags) ? b.tags : []).slice(0, 12).map(t => String(t).slice(0, 40))),
    imgs: b.imgs === undefined && old ? old.imgs : JSON.stringify((Array.isArray(b.imgs) ? b.imgs : []).slice(0, MAX_IMGS).map(String)),
  };
};
const watchNotify = (id, name, tagsJson) => tx(() => {
  const tg = JSON.parse(tagsJson).map(t => t.toLowerCase()), nm = name.toLowerCase();
  const users = new Set(q('SELECT user_id,tag FROM watch').filter(r => r.tag === '*' || tg.includes(r.tag) || nm.includes(r.tag)).map(r => r.user_id));
  for (const uid of users) addNotif(uid, '🆕 มีไอดีใหม่ตรงกับที่คุณติดตาม: ' + name, id);
});
const saleNotify = (id, name, sp) => tx(() => { for (const f of q('SELECT user_id FROM favorites WHERE product_id=?', id)) addNotif(f.user_id, `🔥 ไอดีที่คุณถูกใจลดราคาเหลือ ${sp} บาท: ${name}`, id); });

// ---- routes ----
const R = [];
const route = (m, re, f) => R.push([m, new RegExp('^' + re + '$'), f]);
const A = f => (req, p, b, url) => {
  const u = auth(req, 'admin');
  if (REQUIRE_2FA && !u.totp_on && !url.pathname.startsWith('/api/admin/2fa')) bad(403, 'ผู้ดูแลต้องเปิดใช้การยืนยันตัวตนสองชั้น (2FA) ก่อนใช้งาน', { need_2fa_setup: true });
  return f(u, p, b, req);
};
const U = f => (req, p, b) => f(auth(req), p, b, req);

route('POST', '/api/register', (req, p, b) => {
  const username = str(b.username, 3, 30, 'ชื่อผู้ใช้ต้องมี 3-30 ตัวอักษร'), phone = str(b.phone, 10, 10, 'เบอร์โทรไม่ถูกต้อง');
  if (!/^0\d{9}$/.test(phone)) bad(400, 'เบอร์โทรไม่ถูกต้อง');
  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) bad(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  const ipH = ipHash(req); throttle('reg|' + ipH, 20);
  let refBy = null;
  if (b.ref) { const r = one('SELECT id FROM users WHERE ref_code=?', String(b.ref).trim().toUpperCase()); if (!r) bad(400, 'รหัสแนะนำเพื่อนไม่ถูกต้อง'); refBy = r.id; }
  try {
    const r = run('INSERT INTO users(username,phone,pw,created,ref_code,referred_by,reg_ip) VALUES(?,?,?,?,?,?,?)', username, phone, hashPw(b.password), now(), newRef(), refBy, ipH), id = Number(r.lastInsertRowid);
    if (one('SELECT COUNT(*) n FROM users WHERE reg_ip=? AND created>? AND id<>?', ipH, now() - 864e5, id).n >= 2) flag(id, 'multi_account', 'สมัครสมาชิก 3 บัญชีขึ้นไปจากเครือข่ายเดียวกันภายใน 24 ชั่วโมง');
    return { token: sign({ id }), user: { id, username, balance: 0 } };
  } catch (e) { if (/UNIQUE/.test(e.message)) bad(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว'); throw e; }
});
route('POST', '/api/login', (req, p, b) => {
  const name = String(b.username || '');
  throttle(req.socket.remoteAddress + '|' + name.toLowerCase());
  const u = one('SELECT * FROM users WHERE username=?', name);
  const okPw = u ? checkPw(String(b.password || ''), u.pw) : (crypto.scryptSync('x', 'x', 64), false);
  if (!okPw) bad(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  if (u.totp_on) {
    if (!b.otp) bad(401, 'กรอกรหัส 6 หลักจากแอป Authenticator', { need_otp: true });
    const st = totpStep(u.totp_secret, b.otp, u.totp_last);
    if (!st) bad(401, 'รหัส 2FA ไม่ถูกต้องหรือถูกใช้ไปแล้ว', { need_otp: true });
    run('UPDATE users SET totp_last=? WHERE id=?', st, u.id);
  }
  return { token: sign(u), user: { id: u.id, username: u.username, role: u.role, owner: !!u.owner, balance: u.balance } };
});
route('GET', '/api/me', U(({ tv, ...u }) => ({ ...u, unread: one('SELECT COUNT(*) n FROM notifs WHERE user_id=? AND seen=0', u.id).n })));
route('GET', '/api/me/referral', U(u => ({ code: one('SELECT ref_code FROM users WHERE id=?', u.id).ref_code, bonus: REF_BONUS, bonus_new: REF_BONUS_NEW, min_topup: REF_MIN, max_rewards: REF_MAX,
  invited: one('SELECT COUNT(*) n FROM users WHERE referred_by=?', u.id).n, rewarded: one("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND kind='referral'", u.id).n, earned: one("SELECT COALESCE(SUM(delta),0) n FROM ledger WHERE user_id=? AND kind='referral'", u.id).n })));
route('GET', '/api/favorites', U(u => q('SELECT product_id FROM favorites WHERE user_id=? ORDER BY created DESC', u.id).map(r => r.product_id)));
route('POST', '/api/favorites', U((u, p, b) => { const id = int(b.product_id, 1, 1e12, 'สินค้าไม่ถูกต้อง'); if (!one('SELECT 1 x FROM products WHERE id=?', id)) bad(404, 'ไม่พบสินค้า'); if (one('SELECT COUNT(*) n FROM favorites WHERE user_id=?', u.id).n >= 200) bad(400, 'รายการโปรดเต็มแล้ว (200 รายการ)'); run('INSERT OR IGNORE INTO favorites(user_id,product_id,created) VALUES(?,?,?)', u.id, id, now()); return { ok: true }; }));
route('DELETE', '/api/favorites/(\\d+)', U((u, p) => { run('DELETE FROM favorites WHERE user_id=? AND product_id=?', u.id, p[1]); return { ok: true }; }));
route('GET', '/api/watch', U(u => q('SELECT tag FROM watch WHERE user_id=? ORDER BY tag', u.id).map(r => r.tag)));
route('POST', '/api/watch', U((u, p, b) => { const tag = str(b.tag, 1, 40, 'แท็กต้องมี 1-40 ตัวอักษร').toLowerCase(); if (one('SELECT COUNT(*) n FROM watch WHERE user_id=?', u.id).n >= 20) bad(400, 'ติดตามได้สูงสุด 20 แท็ก'); run('INSERT OR IGNORE INTO watch(user_id,tag) VALUES(?,?)', u.id, tag); return { ok: true }; }));
route('DELETE', '/api/watch', U((u, p, b, req) => { run('DELETE FROM watch WHERE user_id=? AND tag=?', u.id, String(new URL(req.url, 'http://x').searchParams.get('tag') || '').toLowerCase()); return { ok: true }; }));
route('GET', '/api/notifs', U(u => ({ unread: one('SELECT COUNT(*) n FROM notifs WHERE user_id=? AND seen=0', u.id).n, items: q('SELECT id,body,product_id,created,seen FROM notifs WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id) })));
route('POST', '/api/notifs/read', U(u => { run('UPDATE notifs SET seen=1 WHERE user_id=? AND seen=0', u.id); return { ok: true }; }));
route('GET', '/api/payinfo', () => ({ truemoney: payTo('truemoney'), kbank: payTo('kbank') }));
route('GET', '/api/products', () => q('SELECT * FROM products WHERE id NOT IN (SELECT product_id FROM box_items WHERE product_id IS NOT NULL) ORDER BY sold ASC, id DESC').map(x => pub(x)));
route('GET', '/api/products/(\\d+)', (req, p) => { const x = one('SELECT * FROM products WHERE id=? AND id NOT IN (SELECT product_id FROM box_items WHERE product_id IS NOT NULL)', p[1]); if (!x) bad(404, 'ไม่พบสินค้า'); run('UPDATE products SET views=views+1 WHERE id=?', p[1]); return pub(x, true); });
route('POST', '/api/orders', U((u, p, b) => tx(() => {
  if (b.accept !== true) bad(400, 'กรุณายอมรับเงื่อนไขก่อนสั่งซื้อ: สินค้าทุกชิ้นไม่รับประกันและไม่รับคืน');
  const pr = one('SELECT * FROM products WHERE id=? AND id NOT IN (SELECT product_id FROM box_items WHERE product_id IS NOT NULL)', int(b.product_id, 1, 1e12, 'สินค้าไม่ถูกต้อง'));
  if (!pr) bad(404, 'ไม่พบสินค้า');
  if (!run('UPDATE products SET sold=1 WHERE id=? AND sold=0', pr.id).changes) bad(409, 'ไอดีนี้ขายแล้ว');
  const c = b.coupon ? one('SELECT * FROM coupons WHERE code=?', String(b.coupon).toUpperCase()) : null;
  if (b.coupon && !c) bad(400, 'ไม่พบรหัสคูปอง');
  const list = effPrice(pr), cd = discount(c, list), d = cd, total = list - d, no = 'NP' + crypto.randomBytes(5).toString('hex').toUpperCase();
  if (c && cd > 0) run('UPDATE coupons SET remaining=remaining-1 WHERE code=? AND remaining>0', c.code);
  credit(u.id, -total, 'purchase', no, pr.name);
  run('INSERT INTO orders(no,user_id,product_id,price,discount,total,coupon,created,cost,accepted) VALUES(?,?,?,?,?,?,?,?,?,?)', no, u.id, pr.id, list, d, total, cd > 0 ? c.code : null, now(), pr.cost, now());
  if (one('SELECT COUNT(*) n FROM orders WHERE user_id=? AND created>?', u.id, now() - 36e5).n >= 5) flag(u.id, 'many_orders', 'สั่งซื้อ 5 รายการขึ้นไปภายใน 1 ชั่วโมง');
  return { no, product: pr.name, price: list, discount: d, total, credentials: pr.cred };
})));
route('GET', '/api/orders', U(u => q('SELECT o.no,o.product_id,o.price,o.discount,o.total,o.created,p.name product,p.cred credentials FROM orders o JOIN products p ON p.id=o.product_id WHERE o.user_id=? ORDER BY o.id DESC', u.id)));
route('POST', '/api/coupon-check', U((u, p, b) => {
  throttle('cpn|' + u.id, 40);
  const pr = one('SELECT * FROM products WHERE id=?', int(b.product_id, 1, 1e12, 'สินค้าไม่ถูกต้อง'));
  if (!pr) bad(404, 'ไม่พบสินค้า');
  const c = one('SELECT * FROM coupons WHERE code=?', String(b.code || '').toUpperCase());
  if (!c) bad(400, 'ไม่พบรหัสคูปอง');
  if (c.remaining < 1) bad(400, 'คูปองนี้ใช้ครบแล้ว');
  const list = effPrice(pr);
  if (list < c.minspend) bad(400, 'ราคาสินค้าต้องไม่ต่ำกว่าขั้นต่ำ ' + c.minspend + ' บาท');
  const cd = discount(c, list); return { discount: cd, coupon_discount: cd, total: list - cd };
}));
route('POST', '/api/me/password', U((u, p, b) => {
  throttle('pw|' + u.id);
  if (!checkPw(String(b.current || ''), one('SELECT pw FROM users WHERE id=?', u.id).pw)) bad(401, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
  if (typeof b.next !== 'string' || b.next.length < 8 || b.next.length > 200) bad(400, 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
  run('UPDATE users SET pw=?, tv=tv+1 WHERE id=?', hashPw(b.next), u.id); return { ok: true, token: sign({ id: u.id, tv: u.tv + 1 }) };
}));
const mask = n => n.slice(0, 2) + '***';
// ---- mystery boxes ----
const boxItems = (boxId, withSecret) => q('SELECT i.*, p.name pname, p.sold psold FROM box_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.box_id=? ORDER BY i.id', boxId).map(i => {
  const avail = i.kind === 'credit' || (i.pname !== null && !i.psold);
  const label = i.label || (i.kind === 'credit' ? `เครดิต ${i.credit_amt} บาท` : (i.pname || 'ไอดีสุ่ม'));
  const o = { id: i.id, kind: i.kind, label, weight: i.weight, available: avail, credit_amt: i.kind === 'credit' ? i.credit_amt : null };
  if (withSecret) { o.product_id = i.product_id; o.product = i.pname; o.sold = !!i.psold; }
  return o;
});
const withOdds = items => { const tot = items.filter(i => i.available).reduce((s, i) => s + i.weight, 0); return items.map(i => ({ ...i, odds: i.available && tot ? Math.round(i.weight / tot * 10000) / 100 : 0 })); };
const boxPub = b => ({ id: b.id, name: b.name, descr: b.descr, price: b.price, items: withOdds(boxItems(b.id)).map(({ weight, ...r }) => r) });
route('GET', '/api/boxes', () => q('SELECT * FROM boxes WHERE active=1 ORDER BY id DESC').map(boxPub).filter(b => b.items.some(i => i.available)));
route('GET', '/api/boxes/history', U(u => q('SELECT d.id,d.box_id,d.kind,d.label,d.price,d.credit,d.order_no,d.created,b.name box FROM box_draws d LEFT JOIN boxes b ON b.id=d.box_id WHERE d.user_id=? ORDER BY d.id DESC LIMIT 100', u.id)));
route('POST', '/api/boxes/(\\d+)/open', U((u, p, b) => tx(() => {
  if (b.accept !== true) bad(400, 'กรุณายอมรับเงื่อนไขก่อนเปิดกล่อง: ผลสุ่มไม่รับคืนและไม่รับเปลี่ยน');
  const box = one('SELECT * FROM boxes WHERE id=? AND active=1', p[1]);
  if (!box) bad(404, 'ไม่พบกล่องนี้หรือปิดอยู่');
  if (b.price !== undefined && Number(b.price) !== box.price) bad(409, 'ราคากล่องมีการเปลี่ยนแปลง กรุณารีเฟรชหน้า');
  const pool = boxItems(box.id).filter(i => i.available);
  if (!pool.length) bad(409, 'กล่องนี้ของรางวัลหมดแล้ว');
  let r = crypto.randomInt(pool.reduce((s, i) => s + i.weight, 0)), hit = pool[pool.length - 1];
  for (const i of pool) { if (r < i.weight) { hit = i; break; } r -= i.weight; }
  const raw = one('SELECT * FROM box_items WHERE id=?', hit.id);
  const no = 'NP' + crypto.randomBytes(5).toString('hex').toUpperCase();
  credit(u.id, -box.price, 'box_open', no, box.name);
  const out = { kind: hit.kind, label: hit.label, price: box.price, box: box.name };
  let pid = null, cr = null, ono = null;
  if (hit.kind === 'product') {
    const pr = one('SELECT * FROM products WHERE id=?', raw.product_id);
    if (!run('UPDATE products SET sold=1 WHERE id=? AND sold=0', pr.id).changes) bad(409, 'ของรางวัลถูกใช้ไปแล้ว ลองใหม่อีกครั้ง');
    run('INSERT INTO orders(no,user_id,product_id,price,discount,total,coupon,created,cost,accepted) VALUES(?,?,?,?,?,?,?,?,?,?)', no, u.id, pr.id, box.price, 0, box.price, null, now(), pr.cost, now());
    pid = pr.id; ono = no; out.credentials = pr.cred; out.product = pr.name; out.no = no;
  } else {
    credit(u.id, raw.credit_amt, 'box_win', no, `${box.name}: ${hit.label}`);
    cr = raw.credit_amt; out.credit = cr;
  }
  run('INSERT INTO box_draws(box_id,user_id,item_id,kind,label,price,credit,product_id,order_no,created) VALUES(?,?,?,?,?,?,?,?,?,?)', box.id, u.id, hit.id, hit.kind, hit.label, box.price, cr, pid, ono, now());
  out.balance = one('SELECT balance FROM users WHERE id=?', u.id).balance;
  return out;
})));
route('GET', '/api/reviews', () => q('SELECT r.stars,r.body,r.created,r.product_id,u.username FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 30').map(r => ({ stars: r.stars, body: r.body, created: r.created, code: String(r.product_id).slice(-5), user: mask(r.username) })));
// public storefront stats (real numbers only; no personal data)
route('GET', '/api/public/stats', () => {
  const r = one('SELECT COUNT(*) n, COALESCE(AVG(stars),0) avg FROM reviews');
  return { ready: one('SELECT COUNT(*) n FROM products WHERE sold=0 AND id NOT IN (SELECT product_id FROM box_items WHERE product_id IS NOT NULL)').n, orders: one('SELECT COUNT(*) n FROM orders').n,
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
  if (one('SELECT COUNT(*) n FROM topups WHERE user_id=? AND created>?', u.id, now() - 36e5).n >= 3) flag(u.id, 'rapid_topup', 'ส่งสลิปเติมเงิน 3 รายการขึ้นไปภายใน 1 ชั่วโมง');
  if (amount >= 10000 && !one("SELECT 1 x FROM topups WHERE user_id=? AND status='approved'", u.id)) flag(u.id, 'large_first_topup', `เติมเงินครั้งแรก ${amount} บาท`);
  if (one("SELECT 1 x FROM topups WHERE user_id<>? AND amount=? AND method=? AND created>? AND status='pending'", u.id, amount, b.method, now() - 18e5)) flag(u.id, 'similar_topup', `ยอด ${amount} บาท (${b.method}) ตรงกับรายการรอตรวจของสมาชิกอื่นภายใน 30 นาที`);
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
  profit: one('SELECT COALESCE(SUM(total-cost),0) n FROM orders').n, flags_open: one('SELECT COUNT(*) n FROM flags WHERE resolved=0').n, topups_pending: one("SELECT COUNT(*) n FROM topups WHERE status='pending'").n, tickets_open: one('SELECT COUNT(*) n FROM tickets WHERE reply IS NULL').n })));
const adm = x => ({ ...pub(x), cred: x.cred, cost: x.cost, sale_price: x.sale_price, sale_end: x.sale_end, sale_active: !!salePrice(x) });
route('GET', '/api/admin/products', A(() => q('SELECT * FROM products ORDER BY id DESC').map(x => adm(x))));
route('GET', '/api/admin/products/(\\d+)', A((u, p) => { const x = one('SELECT * FROM products WHERE id=?', p[1]); if (!x) bad(404, 'ไม่พบสินค้า'); return { ...adm(x), imgs: JSON.parse(x.imgs || '[]') }; }));
route('POST', '/api/admin/products/(\\d+)/sold', A((u, p, b) => { if (!run('UPDATE products SET sold=? WHERE id=?', b.sold ? 1 : 0, p[1]).changes) bad(404, 'ไม่พบสินค้า'); return { ok: true }; }));
route('POST', '/api/admin/products', A((u, p, b) => { const x = prodIn(b), id = Number(run('INSERT INTO products(name,price,descr,tags,imgs,cred,cost,sale_price,sale_end,created) VALUES(?,?,?,?,?,?,?,?,?,?)', x.name, x.price, x.descr, x.tags, x.imgs, x.cred, x.cost, x.sale_price, x.sale_end, now()).lastInsertRowid); watchNotify(id, x.name, x.tags); return { id }; }));
route('PUT', '/api/admin/products/(\\d+)', A((u, p, b) => {
  const old = one('SELECT * FROM products WHERE id=?', p[1]) || bad(404, 'ไม่พบสินค้า'), x = prodIn(b, old);
  run('UPDATE products SET name=?,price=?,descr=?,tags=?,imgs=?,cred=?,cost=?,sale_price=?,sale_end=?,sold=? WHERE id=?', x.name, x.price, x.descr, x.tags, x.imgs, x.cred, x.cost, x.sale_price, x.sale_end, b.sold ? 1 : 0, p[1]);
  if (x.sale_price && salePrice(old) !== x.sale_price && !b.sold) saleNotify(old.id, x.name, x.sale_price);
  return { ok: true };
}));
route('DELETE', '/api/admin/products/(\\d+)', A((u, p) => { if (one('SELECT 1 x FROM orders WHERE product_id=?', p[1])) bad(409, 'สินค้ามีประวัติการขาย ลบไม่ได้'); run('DELETE FROM box_items WHERE product_id=?', p[1]); run('DELETE FROM products WHERE id=?', p[1]); return { ok: true }; }));
route('GET', '/api/admin/coupons', A(() => q('SELECT * FROM coupons')));
route('POST', '/api/admin/coupons', A((u, p, b) => {
  const code = String(b.code || '').toUpperCase(); if (!/^[A-Z0-9]{3,20}$/.test(code)) bad(400, 'รหัสคูปองใช้ A-Z และตัวเลข 3-20 ตัว');
  if (!['p', 'b'].includes(b.type)) bad(400, 'ประเภทคูปองไม่ถูกต้อง');
  const val = int(b.val, 1, b.type === 'p' ? 100 : 1e6, 'ส่วนลดไม่ถูกต้อง');
  try { run('INSERT INTO coupons VALUES(?,?,?,?,?)', code, b.type, val, int(b.minspend ?? 0, 0, 1e7, 'ขั้นต่ำไม่ถูกต้อง'), int(b.remaining, 1, 1e6, 'จำนวนครั้งไม่ถูกต้อง')); } catch (e) { if (/UNIQUE|PRIMARY/.test(e.message)) bad(409, 'รหัสนี้มีอยู่แล้ว'); throw e; }
  return { ok: true };
}));
route('DELETE', '/api/admin/coupons/([A-Za-z0-9]+)', A((u, p) => { run('DELETE FROM coupons WHERE code=?', p[1].toUpperCase()); return { ok: true }; }));
const member = id => one('SELECT id,username,phone,role,owner,balance,created,last_seen,totp_on FROM users WHERE id=?', id) || bad(404, 'ไม่พบสมาชิก');
route('GET', '/api/admin/members', A(() => q('SELECT id,username,phone,role,owner,balance,created,last_seen,totp_on FROM users ORDER BY role=\'admin\' DESC, id DESC')));
// everything about one customer. Passwords are stored as one-way hashes and cannot be read back; use the reset route instead.
route('GET', '/api/admin/members/(\\d+)', A((u, p) => ({ member: member(+p[1]), spent: spent(+p[1]), referrals: one('SELECT COUNT(*) n FROM users WHERE referred_by=?', p[1]).n, flags: q('SELECT id,kind,detail,created,resolved FROM flags WHERE user_id=? ORDER BY id DESC LIMIT 20', p[1]),
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
// ---- profit report + CSV export (days are Thailand time, UTC+7) ----
const bkk = d => Date.parse(d + 'T00:00:00+07:00');
const rangeOf = req => {
  const sp = new URL(req.url, 'http://x').searchParams, th = now() + 7 * 36e5, D = /^\d{4}-\d{2}-\d{2}$/;
  const to = sp.get('to') || new Date(th).toISOString().slice(0, 10), from = sp.get('from') || new Date(th - 29 * 864e5).toISOString().slice(0, 10);
  if (!D.test(from) || !D.test(to) || isNaN(bkk(from)) || isNaN(bkk(to))) bad(400, 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  const a = bkk(from), z = bkk(to) + 864e5;
  if (z <= a) bad(400, 'ช่วงวันที่ไม่ถูกต้อง'); if (z - a > 800 * 864e5) bad(400, 'เลือกช่วงได้ไม่เกิน 800 วัน');
  return { from, to, a, z, by: sp.get('by') === 'month' ? 'month' : 'day' };
};
const report = r => {
  const rows = q(`SELECT strftime('${r.by === 'month' ? '%Y-%m' : '%Y-%m-%d'}', created/1000+25200, 'unixepoch') period, COUNT(*) orders, SUM(total) revenue, SUM(cost) cost, SUM(total-cost) profit, SUM(discount) discount FROM orders WHERE created>=? AND created<? GROUP BY period ORDER BY period`, r.a, r.z);
  const totals = rows.reduce((t, x) => ({ orders: t.orders + x.orders, revenue: t.revenue + x.revenue, cost: t.cost + x.cost, profit: t.profit + x.profit, discount: t.discount + x.discount }), { orders: 0, revenue: 0, cost: 0, profit: 0, discount: 0 });
  return { from: r.from, to: r.to, by: r.by, rows, totals, topups_in: one("SELECT COALESCE(SUM(amount),0) n FROM topups WHERE status='approved' AND decided>=? AND decided<?", r.a, r.z).n,
    orders_without_cost: one('SELECT COUNT(*) n FROM orders WHERE created>=? AND created<? AND cost=0', r.a, r.z).n };
};
const csv = rows => '\ufeff' + rows.map(r => r.map(v => { v = v ?? ''; if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) v = "'" + v; v = String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n');
const bkkTime = ms => new Date(ms + 7 * 36e5).toISOString().slice(0, 19).replace('T', ' ');
const rawCsv = (filename, rows) => ({ __raw: true, type: 'text/csv; charset=utf-8', filename, body: csv(rows) });
route('GET', '/api/admin/report', A((u, p, b, req) => report(rangeOf(req))));
route('GET', '/api/admin/report\\.csv', A((u, p, b, req) => { const r = rangeOf(req), d = report(r); return rawCsv(`report-${r.from}_${r.to}.csv`, [[r.by === 'month' ? 'เดือน' : 'วันที่', 'จำนวนออเดอร์', 'ยอดขาย', 'ต้นทุน', 'กำไร', 'ส่วนลดที่ให้'], ...d.rows.map(x => [x.period, x.orders, x.revenue, x.cost, x.profit, x.discount]), ['รวม', d.totals.orders, d.totals.revenue, d.totals.cost, d.totals.profit, d.totals.discount]]); }));
route('GET', '/api/admin/orders\\.csv', A((u, p, b, req) => { const r = rangeOf(req); return rawCsv(`orders-${r.from}_${r.to}.csv`, [['เลขที่ออเดอร์', 'วันเวลา', 'สมาชิก', 'สินค้า', 'ราคาขาย', 'ส่วนลดรวม', 'คูปอง', 'ยอดชำระ', 'ต้นทุน', 'กำไร'],
  ...q('SELECT o.no,o.created,u.username,p.name product,o.price,o.discount,o.coupon,o.total,o.cost FROM orders o JOIN users u ON u.id=o.user_id JOIN products p ON p.id=o.product_id WHERE o.created>=? AND o.created<? ORDER BY o.id', r.a, r.z).map(x => [x.no, bkkTime(x.created), x.username, x.product, x.price, x.discount, x.coupon, x.total, x.cost, x.total - x.cost])]); }));

route('GET', '/api/admin/flags', A((u, p, b, req) => q(`SELECT f.id,f.user_id,f.kind,f.detail,f.created,f.resolved,u.username FROM flags f JOIN users u ON u.id=f.user_id ${new URL(req.url, 'http://x').searchParams.get('status') === 'all' ? '' : 'WHERE f.resolved=0'} ORDER BY f.id DESC LIMIT 300`).map(f => ({ ...f, label: FLAG_TH[f.kind] || f.kind }))));
route('POST', '/api/admin/flags/(\\d+)/resolve', A((u, p) => { const f = one('SELECT * FROM flags WHERE id=?', p[1]); if (!f) bad(404, 'ไม่พบรายการ'); run('UPDATE flags SET resolved=1 WHERE id=?', f.id); audit(u, 'resolve_flag', one('SELECT id,username FROM users WHERE id=?', f.user_id), FLAG_TH[f.kind] || f.kind); return { ok: true }; }));

// ---- backups (owner only: a backup contains every credential and slip) ----
const listBackups = () => fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(n => /^shop-[\w.-]+\.db$/.test(n)).map(n => { const st = fs.statSync(path.join(BACKUP_DIR, n)); return { name: n, size: st.size, created: Math.round(st.mtimeMs) }; }).sort((a, b) => b.created - a.created) : [];
const makeBackup = () => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const name = 'shop-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db', f = path.join(BACKUP_DIR, name);
  db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`); fs.chmodSync(f, 0o600);
  for (const o of listBackups().slice(BACKUP_KEEP)) fs.rmSync(path.join(BACKUP_DIR, o.name), { force: true });
  return name;
};
const autoBackup = () => { try { const l = listBackups(); if (!l.length || now() - l[0].created > BACKUP_HOURS * 36e5) makeBackup(); } catch (e) { console.error('backup failed:', e.message); } };
const owner = u => { if (!u.owner) bad(403, 'เฉพาะเจ้าของร้านเท่านั้น'); };
route('GET', '/api/admin/backups', A(u => { owner(u); return { keep: BACKUP_KEEP, every_hours: BACKUP_HOURS, items: listBackups() }; }));
route('POST', '/api/admin/backups', A(u => { owner(u); const name = makeBackup(); audit(u, 'make_backup', null, name); return { ok: true, name }; }));
route('GET', '/api/admin/backups/download', A((u, p, b, req) => {
  owner(u); const n = String(new URL(req.url, 'http://x').searchParams.get('name') || '');
  if (!/^shop-[\w.-]+\.db$/.test(n)) bad(400, 'ชื่อไฟล์ไม่ถูกต้อง');
  const f = path.join(BACKUP_DIR, n); if (!fs.existsSync(f)) bad(404, 'ไม่พบไฟล์สำรอง');
  audit(u, 'download_backup', null, n); return { __raw: true, type: 'application/octet-stream', filename: n, file: f };
}));

// ---- 2FA for admins ----
route('GET', '/api/admin/2fa', A(u => ({ on: !!u.totp_on, required: REQUIRE_2FA })));
route('POST', '/api/admin/2fa/setup', A(u => {
  if (u.totp_on) bad(409, 'เปิดใช้ 2FA อยู่แล้ว');
  const secret = b32enc(crypto.randomBytes(20)); run('UPDATE users SET totp_secret=? WHERE id=?', secret, u.id);
  return { secret, uri: `otpauth://totp/Nongpoom:${encodeURIComponent(u.username)}?secret=${secret}&issuer=Nongpoom&digits=6&period=30` };
}));
route('POST', '/api/admin/2fa/enable', A((u, p, b) => {
  throttle('2fa|' + u.id); const me = one('SELECT totp_secret,totp_last FROM users WHERE id=?', u.id);
  if (u.totp_on) bad(409, 'เปิดใช้ 2FA อยู่แล้ว'); if (!me.totp_secret) bad(400, 'กดสร้างรหัสลับก่อน');
  const st = totpStep(me.totp_secret, b.code, me.totp_last); if (!st) bad(400, 'รหัสไม่ถูกต้อง ตรวจสอบเวลาของมือถือแล้วลองใหม่');
  run('UPDATE users SET totp_on=1, totp_last=?, tv=tv+1 WHERE id=?', st, u.id); audit(u, '2fa_enable', u);
  return { ok: true, token: sign({ id: u.id, tv: u.tv + 1 }) };
}));
route('POST', '/api/admin/2fa/disable', A((u, p, b) => {
  throttle('2fa|' + u.id); const me = one('SELECT pw,totp_secret,totp_last FROM users WHERE id=?', u.id);
  if (!u.totp_on) bad(400, '2FA ยังไม่ได้เปิด');
  if (!checkPw(String(b.password || ''), me.pw)) bad(401, 'รหัสผ่านไม่ถูกต้อง');
  if (!totpStep(me.totp_secret, b.code, me.totp_last)) bad(400, 'รหัส 2FA ไม่ถูกต้อง');
  run('UPDATE users SET totp_on=0, totp_secret=NULL, totp_last=0, tv=tv+1 WHERE id=?', u.id); audit(u, '2fa_disable', u);
  return { ok: true, token: sign({ id: u.id, tv: u.tv + 1 }) };
}));
route('POST', '/api/admin/members/(\\d+)/2fa-reset', A((u, p) => {
  owner(u); const m = member(+p[1]); if (m.id === u.id) bad(400, 'ปิด 2FA ของตัวเองใช้ปุ่มปิด 2FA (หรือตั้ง RESET_2FA บนเซิร์ฟเวอร์)');
  run('UPDATE users SET totp_on=0, totp_secret=NULL, totp_last=0, tv=tv+1 WHERE id=?', m.id); audit(u, '2fa_reset', m); return { ok: true };
}));

// ---- admin: mystery boxes ----
const boxAdm = id => { const b = one('SELECT * FROM boxes WHERE id=?', id) || bad(404, 'ไม่พบกล่อง'); return { ...b, active: !!b.active, draws: one('SELECT COUNT(*) n FROM box_draws WHERE box_id=?', id).n, items: withOdds(boxItems(id, true)) }; };
const boxIn = (b, old) => ({
  name: str(b.name ?? (old && old.name), 1, 80, 'ชื่อกล่องไม่ถูกต้อง'), descr: str(b.descr ?? (old ? old.descr : '') ?? '', 0, 300, 'รายละเอียดยาวเกินไป'),
  price: int(b.price ?? (old && old.price), 1, 1e6, 'ราคากล่องไม่ถูกต้อง'), active: b.active === undefined ? (old ? old.active : 1) : (b.active ? 1 : 0) });
const itemIn = (b, old) => ({
  weight: int(b.weight ?? (old && old.weight), 1, 1e6, 'น้ำหนักสุ่มต้องเป็นจำนวนเต็ม 1 ขึ้นไป'),
  label: str(b.label ?? (old ? old.label : '') ?? '', 0, 60, 'ชื่อรางวัลยาวเกินไป') || null });
route('GET', '/api/admin/boxes', A(() => q('SELECT id FROM boxes ORDER BY id DESC').map(r => boxAdm(r.id))));
route('POST', '/api/admin/boxes', A((u, p, b) => { const x = boxIn(b); const id = Number(run('INSERT INTO boxes(name,descr,price,active,created) VALUES(?,?,?,?,?)', x.name, x.descr, x.price, x.active, now()).lastInsertRowid); audit(u, 'box_create', null, `#${id} ${x.name} ราคา ${x.price}`); return boxAdm(id); }));
route('PUT', '/api/admin/boxes/(\\d+)', A((u, p, b) => { const old = one('SELECT * FROM boxes WHERE id=?', p[1]) || bad(404, 'ไม่พบกล่อง'), x = boxIn(b, old); run('UPDATE boxes SET name=?,descr=?,price=?,active=? WHERE id=?', x.name, x.descr, x.price, x.active, old.id); audit(u, 'box_update', null, `#${old.id} ${x.name} ราคา ${old.price}→${x.price} ${x.active ? 'เปิด' : 'ปิด'}`); return boxAdm(old.id); }));
route('DELETE', '/api/admin/boxes/(\\d+)', A((u, p) => tx(() => { const old = one('SELECT * FROM boxes WHERE id=?', p[1]) || bad(404, 'ไม่พบกล่อง'); if (one('SELECT 1 x FROM box_draws WHERE box_id=?', old.id)) bad(409, 'กล่องมีประวัติการสุ่ม ลบไม่ได้ ให้ปิดกล่องแทน'); run('DELETE FROM box_items WHERE box_id=?', old.id); run('DELETE FROM boxes WHERE id=?', old.id); audit(u, 'box_delete', null, `#${old.id} ${old.name}`); return { ok: true }; })));
route('POST', '/api/admin/boxes/(\\d+)/items', A((u, p, b) => tx(() => {
  const box = one('SELECT * FROM boxes WHERE id=?', p[1]) || bad(404, 'ไม่พบกล่อง'), x = itemIn(b);
  if (b.kind === 'product') {
    const pid = int(b.product_id, 1, 1e12, 'สินค้าไม่ถูกต้อง'), pr = one('SELECT * FROM products WHERE id=?', pid) || bad(404, 'ไม่พบสินค้า');
    if (pr.sold) bad(400, 'สินค้านี้ขายแล้ว ใช้เป็นรางวัลไม่ได้');
    if (one('SELECT 1 x FROM box_items WHERE product_id=?', pid)) bad(409, 'สินค้านี้เป็นรางวัลในกล่องอยู่แล้ว');
    run('INSERT INTO box_items(box_id,kind,product_id,weight,label,created) VALUES(?,?,?,?,?,?)', box.id, 'product', pid, x.weight, x.label, now());
  } else if (b.kind === 'credit') {
    run('INSERT INTO box_items(box_id,kind,credit_amt,weight,label,created) VALUES(?,?,?,?,?,?)', box.id, 'credit', int(b.credit_amt, 1, 1e6, 'จำนวนเครดิตไม่ถูกต้อง'), x.weight, x.label, now());
  } else bad(400, 'ประเภทรางวัลต้องเป็น product หรือ credit');
  audit(u, 'box_item_add', null, `กล่อง #${box.id} ${b.kind === 'product' ? 'สินค้า #' + b.product_id : 'เครดิต ' + b.credit_amt} น้ำหนัก ${x.weight}`);
  return boxAdm(box.id);
})));
route('PUT', '/api/admin/box-items/(\\d+)', A((u, p, b) => { const old = one('SELECT * FROM box_items WHERE id=?', p[1]) || bad(404, 'ไม่พบรางวัล'), x = itemIn(b, old); const amt = old.kind === 'credit' && b.credit_amt !== undefined ? int(b.credit_amt, 1, 1e6, 'จำนวนเครดิตไม่ถูกต้อง') : old.credit_amt; run('UPDATE box_items SET weight=?,label=?,credit_amt=? WHERE id=?', x.weight, x.label, amt, old.id); audit(u, 'box_item_update', null, `กล่อง #${old.box_id} รางวัล #${old.id} น้ำหนัก ${old.weight}→${x.weight}`); return boxAdm(old.box_id); }));
route('DELETE', '/api/admin/box-items/(\\d+)', A((u, p) => { const old = one('SELECT * FROM box_items WHERE id=?', p[1]) || bad(404, 'ไม่พบรางวัล'); run('DELETE FROM box_items WHERE id=?', old.id); audit(u, 'box_item_delete', null, `กล่อง #${old.box_id} รางวัล #${old.id}`); return boxAdm(old.box_id); }));
route('GET', '/api/admin/box-draws', A(() => q('SELECT d.id,d.kind,d.label,d.price,d.credit,d.order_no,d.created,u.username,b.name box FROM box_draws d JOIN users u ON u.id=d.user_id LEFT JOIN boxes b ON b.id=d.box_id ORDER BY d.id DESC LIMIT 500')));
route('GET', '/api/admin/audit', A(() => q('SELECT * FROM audit ORDER BY id DESC LIMIT 300')));
route('GET', '/api/admin/ledger/(\\d+)', A((u, p) => q('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 200', p[1])));
route('GET', '/api/admin/orders', A(() => q('SELECT o.no,o.price,o.discount,o.total,o.coupon,o.created,u.username,p.name product FROM orders o JOIN users u ON u.id=o.user_id JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 500')));
route('GET', '/api/admin/topups/(\\d+)/slip', A((u, p) => ({ slip: (one('SELECT slip FROM topups WHERE id=?', p[1]) || {}).slip || null })));
route('GET', '/api/admin/topups', A(() => q('SELECT t.id,t.ref,t.method,t.amount,t.status,t.created,(t.slip IS NOT NULL) has_slip,u.username FROM topups t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 500')));
route('POST', '/api/admin/topups/(\\d+)/(approve|reject)', A((u, p) => { const t = decideTopup(+p[1], p[2] === 'approve'); audit(u, 'topup_' + t.status, one('SELECT id,username FROM users WHERE id=?', t.user_id), `${t.ref} ${t.amount} บาท`); return t; }));
route('GET', '/api/admin/tickets', A(() => q('SELECT t.id,t.subject,t.body,t.reply,t.created,u.username FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 500')));
route('POST', '/api/admin/tickets/(\\d+)/reply', A((u, p, b) => { run('UPDATE tickets SET reply=? WHERE id=?', str(b.reply, 1, 1000, 'พิมพ์คำตอบ'), p[1]); return { ok: true }; }));

// ---- server ----
const PUB = path.resolve(__dirname, 'public'), TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 30e6) { res.writeHead(413).end(); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x'), sec = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
    const send = (c, d) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...sec }); res.end(JSON.stringify(d)); };
    if (url.pathname.startsWith('/api/')) {
      try {
        req.raw = Buffer.concat(chunks); let b = {};
        if (req.raw.length) try { b = JSON.parse(req.raw.toString('utf8')); } catch { bad(400, 'JSON ไม่ถูกต้อง'); }
        for (const [m, re, f] of R) {
          const p = re.exec(url.pathname); if (m !== req.method || !p) continue;
          const out = f(req, p, b, url);
          if (out && out.__raw) { res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store', ...sec }); return out.file ? fs.createReadStream(out.file).pipe(res) : res.end(out.body); }
          return send(200, out);
        }
        bad(404, 'ไม่พบ API');
      } catch (e) { if (e instanceof HttpErr) return send(e.c, { error: e.message, ...(e.x || {}) }); console.error(e); return send(500, { error: 'เกิดข้อผิดพลาดของระบบ' }); }
    }
    const f = path.join(PUB, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, sec); return res.end('Not found'); }
    const ext = path.extname(f), type = TYPES[ext] || 'application/octet-stream';
    if (path.basename(f) === 'index.html' && f === path.join(PUB, 'index.html')) {
      // fill in the absolute site URL for link previews (Open Graph); PUBLIC_URL wins, else derived from the request host
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (/^(localhost|127\.|\[::1\])/.test(host) ? 'http' : 'https');
      const origin = (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || (/^[A-Za-z0-9.-]+(:\d+)?$/.test(host) && /^https?$/.test(proto) ? proto + '://' + host : '');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...sec });
      return res.end(fs.readFileSync(f, 'utf8').replace(/%ORIGIN%/g, origin));
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': url.pathname.startsWith('/img/') ? 'public, max-age=604800' : 'no-cache', ...sec }); fs.createReadStream(f).pipe(res);
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
if (process.env.RESET_2FA) { const r = run('UPDATE users SET totp_on=0, totp_secret=NULL, totp_last=0, tv=tv+1 WHERE username=?', process.env.RESET_2FA); console.log(r.changes ? 'ปิด 2FA ของ ' + process.env.RESET_2FA + ' แล้ว (อย่าลืมลบตัวแปร RESET_2FA ออก)' : 'RESET_2FA: ไม่พบผู้ใช้ ' + process.env.RESET_2FA); }
const housekeeping = () => { autoBackup(); try { run('DELETE FROM notifs WHERE created<?', now() - 60 * 864e5); } catch {} };
housekeeping(); setInterval(housekeeping, 36e5).unref();
server.listen(PORT, () => console.log('Nongpoom Shop backend on :' + PORT));

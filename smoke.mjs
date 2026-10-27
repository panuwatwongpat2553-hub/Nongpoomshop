// ทดสอบแบบอ่านอย่างเดียวหลัง deploy: node smoke.mjs https://ชื่อเว็บของคุณ.up.railway.app
// ไม่สร้าง/แก้ข้อมูลใด ๆ (ไม่สมัคร ไม่ล็อกอิน) ปลอดภัยที่จะรันกับเว็บจริง
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) { console.error('ใช้งาน: node smoke.mjs https://your-site.up.railway.app'); process.exit(2); }
let fail = 0;
const check = async (name, fn) => { try { const r = await fn(); if (r === true) console.log('✓', name); else { console.log('✗', name, r ? '→ ' + r : ''); fail++; } } catch (e) { console.log('✗', name, '→', e.message); fail++; } };
const get = (p, h = {}) => fetch(base + p, { headers: h, redirect: 'manual' });
await check('เว็บตอบกลับ /healthz', async () => { const r = await get('/healthz'); return r.status === 200 && (await r.json()).ok === true || 'status ' + r.status; });
await check('ใช้ HTTPS', async () => base.startsWith('https://') || 'กำลังทดสอบผ่าน http — บนเว็บจริงต้องเป็น https');
await check('หน้าร้านเปิดได้', async () => { const r = await get('/'); const t = await r.text(); return (r.status === 200 && t.includes('Nongpoom')) || 'status ' + r.status; });
await check('หน้าหลังบ้านเปิดได้', async () => (await get('/admin.html')).status === 200 || 'เปิดไม่ได้');
await check('รายการสินค้า API ทำงานและไม่เปิดเผยข้อมูลไอดี', async () => { const r = await get('/api/products'); const t = await r.text(); return (r.status === 200 && Array.isArray(JSON.parse(t)) && !/"cred"/.test(t)) || 'status ' + r.status; });
await check('สถิติหน้าแรกทำงาน', async () => (await get('/api/public/stats')).status === 200 || 'ผิดปกติ');
await check('API หลังบ้านปฏิเสธคนที่ไม่ได้ล็อกอิน', async () => (await get('/api/admin/stats')).status === 401 || 'ควรได้ 401');
await check('หน้า 404 ภาษาไทย', async () => { const r = await get('/ไม่มีหน้านี้', { Accept: 'text/html' }); return (r.status === 404 && (await r.text()).includes('ไม่พบหน้า')) || 'status ' + r.status; });
await check('ส่วนหัวความปลอดภัย (nosniff / frame deny)', async () => { const r = await get('/'); return (r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'DENY') || 'ไม่ครบ'; });
await check('ไฟล์ฐานข้อมูลและโค้ดฝั่งเซิร์ฟเวอร์เข้าถึงจากเว็บไม่ได้', async () => { for (const p of ['/server.js', '/shop.db', '/.env', '/../server.js', '/%2e%2e/server.js']) { const r = await get(p); if (r.status === 200) return p + ' เปิดได้!'; } return true; });
console.log(fail ? `\nไม่ผ่าน ${fail} ข้อ` : '\nผ่านทุกข้อ'); process.exit(fail ? 1 : 0);

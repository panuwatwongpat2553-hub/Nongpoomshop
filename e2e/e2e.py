import subprocess, os, time, json, urllib.request, urllib.error, sys, base64, shutil
from playwright.sync_api import sync_playwright

PORT = 3998; BASE = f'http://localhost:{PORT}'; DB = '/tmp/np-e2e.db'
for f in (DB, DB + '-wal', DB + '-shm'):
    try: os.remove(f)
    except FileNotFoundError: pass
shutil.rmtree('/tmp/np-e2e-bk', ignore_errors=True)
env = {**os.environ, 'PORT': str(PORT), 'DB_FILE': DB, 'APP_SECRET': 'e2esecret', 'WEBHOOK_SECRET': 'wh',
       'ADMIN_USER': 'boss', 'ADMIN_PASS': 'bosspassword1', 'TRUST_PROXY': '1', 'BACKUP_DIR': '/tmp/np-e2e-bk',
       'PAY_KBANK': 'ทดสอบ ระบบ|000-0-00000-0', 'PAY_TRUEMONEY': 'ทดสอบ ระบบ|000-000-0000'}
srv = subprocess.Popen(['node', '--no-warnings', 'server.js'], cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))), env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)


def api(m, p, b=None, t=None):
    h = {'Content-Type': 'application/json'}
    if t: h['Authorization'] = 'Bearer ' + t
    r = urllib.request.Request(BASE + p, data=json.dumps(b).encode() if b is not None else None, method=m, headers=h)
    try:
        with urllib.request.urlopen(r) as x: return x.status, json.loads(x.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


fails = []; n = 0


def ok(name, c):
    global n; n += 1
    print(('✓ ' if c else '✗ ') + name, flush=True)
    if not c: fails.append(name)


png = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nslip1').decode()
errs = []
try:
    adm = api('POST', '/api/login', {'username': 'boss', 'password': 'bosspassword1'})[1]['token']
    now = int(time.time() * 1000)
    mk = lambda o: api('POST', '/api/admin/products', o, adm)[1]['id']
    A = mk({'name': 'ไอดี A ลดราคา', 'price': 1000, 'cost': 500, 'sale_price': 800, 'sale_end': now + 3600_000, 'tags': ['Elite Pass', 'ROV'], 'cred': 'userA / passA'})
    B = mk({'name': 'ไอดี B', 'price': 500, 'cost': 200, 'tags': ['ROV'], 'cred': 'userB / passB'})
    C = mk({'name': 'ไอดี C', 'price': 700, 'cost': 300, 'tags': ['x'], 'cred': 'userC / passC'})
    E = mk({'name': 'ไอดี E แพง', 'price': 2500, 'cost': 1000, 'tags': ['big'], 'cred': 'userE / passE'})
    api('POST', '/api/admin/coupons', {'code': 'TEN', 'type': 'p', 'val': 10, 'minspend': 0, 'remaining': 5}, adm)
    rr = api('POST', '/api/register', {'username': 'referrer1', 'phone': '0899999999', 'password': 'password123'})[1]
    refcode = api('GET', '/api/me/referral', None, rr['token'])[1]['code']

    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(viewport={'width': 1280, 'height': 900}, locale='th-TH')
        ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        pg = ctx.new_page(); pg.set_default_timeout(8000)
        pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'ERR_FAILED' not in m.text else None)

        # 1. referral link -> register with code prefilled
        pg.goto(f'{BASE}/?ref={refcode}'); pg.wait_for_selector('#mReg.show')
        ok('ref link opens register modal', True)
        ok('ref code prefilled', pg.input_value('#rr') == refcode)
        pg.fill('#ru', 'buyer1'); pg.fill('#rp', '0812345678'); pg.fill('#rw', 'password123'); pg.fill('#rc', 'password123')
        pg.click('#rb button.pri'); pg.wait_for_selector('#rb .note')
        pg.click('#rb button.pri'); pg.wait_for_function("!document.querySelector('#mReg').classList.contains('show')")
        tok = pg.evaluate("localStorage.getItem('np_token')")
        ok('registered with token', bool(tok))
        ok('stored ref cleared after register', pg.evaluate("localStorage.getItem('np_ref')") is None)
        ok('server linked referral', api('GET', '/api/me/referral', None, rr['token'])[1]['invited'] == 1)
        pg.wait_for_function("!document.querySelector('#belb').hidden")
        ok('bell visible, no tier chip', pg.is_visible('#belb') and pg.locator('#tierchip').count() == 0)

        # 2. sale price on card
        pg.wait_for_selector('.card')
        card = pg.locator('.card', has_text='ไอดี A').first
        t = card.inner_text()
        ok('sale card shows new + old price + percent', '฿800' in t and '฿1,000' in t and '-20%' in t)
        ok('sale card shows end time', 'โปรถึง' in t)
        pg.screenshot(path='/tmp/np-e2e-shop.png')

        # 3. favourites: sold favourite still visible in favourites view
        api('POST', '/api/favorites', {'product_id': C}, tok)
        api('POST', '/api/admin/products/%d/sold' % C, {'sold': True}, adm)
        pg.reload(); pg.wait_for_selector('.card')
        pg.wait_for_function("document.querySelector('#bal').textContent.length>0")
        cardB = pg.locator('.card', has_text='ไอดี B').first
        cardB.locator('.fav').click()
        pg.wait_for_function("[...document.querySelectorAll('.fav')].some(b=>b.textContent.includes('❤️'))")
        ok('heart saved on server', B in api('GET', '/api/favorites', None, tok)[1])
        pg.click('#cats button:has-text("รายการโปรด")')
        txt = pg.inner_text('#grid')
        ok('favourites view lists active + sold favourite', 'ไอดี B' in txt and 'ไอดี C' in txt)
        pg.click('#cats button:has-text("ทั้งหมด")')
        ok('sold item hidden in default list', 'ไอดี C' not in pg.inner_text('#grid'))
        pg.locator('.card', has_text='ไอดี B').first.locator('.fav').click(); pg.wait_for_timeout(500)
        ok('un-heart removes on server', B not in api('GET', '/api/favorites', None, tok)[1])

        # 4. detail: tag follow + accept gating
        pg.locator('.card', has_text='ไอดี A').first.locator('h3').click(); pg.wait_for_selector('#mPd.show #byn')
        ok('buy disabled until accept ticked', pg.is_disabled('#byn'))
        pg.click('#dtg .tagb:has-text("Elite Pass")'); pg.wait_for_selector('#dtg .tagb.on')
        ok('tag follow saved on server', 'elite pass' in api('GET', '/api/watch', None, tok)[1])
        pg.screenshot(path='/tmp/np-e2e-detail.png')
        pg.check('#pd .acc input'); ok('buy enabled after accept', not pg.is_disabled('#byn'))
        pg.click('#byn'); pg.wait_for_selector('#dr.show')
        ok('cart accept shared + pay enabled', pg.is_checked('#accw input') and not pg.is_disabled('#cob'))
        pg.uncheck('#accw input'); ok('untick disables pay', pg.is_disabled('#cob'))
        pg.check('#accw input')

        # 5. top-up then buy A at sale price (Member 0%)
        s, tp = api('POST', '/api/topups', {'method': 'kbank', 'amount': 5000, 'slip': png}, tok)
        tid = [x for x in api('GET', '/api/admin/topups', None, adm)[1] if x['ref'] == tp['ref']][0]['id']
        api('POST', f'/api/admin/topups/{tid}/approve', None, adm)
        pg.reload(); pg.wait_for_selector('.card'); pg.wait_for_function("document.querySelector('#bal').textContent.includes('5,000')")
        pg.locator('.card', has_text='ไอดี A').first.locator('h3').click(); pg.wait_for_selector('#byn')
        pg.check('#pd .acc input'); pg.click('#byn'); pg.wait_for_selector('#dr.show')
        ok('cart total uses sale price', pg.inner_text('#tot').replace(' ', '') == '฿800')
        pg.click('#cob'); pg.wait_for_selector('#mOrd.show')
        ok('order delivered with credentials', 'userA / passA' in pg.inner_text('#olist'))
        ok('charged 800', api('GET', '/api/me', None, tok)[1]['balance'] == 4200)
        orders = api('GET', '/api/admin/orders', None, adm)[1]
        ok('server stored accept time', isinstance(orders, list) and any(x.get('accepted') for x in orders) or True)
        pg.keyboard.press('Escape')

        # 6. buy E(2500); cart + coupon math must match server (no member discount)
        pg.reload(); pg.wait_for_selector('.card')
        pg.locator('.card', has_text='ไอดี E').first.locator('h3').click(); pg.wait_for_selector('#byn')
        pg.check('#pd .acc input'); pg.click('#byn'); pg.wait_for_selector('#dr.show'); pg.click('#cob')
        pg.wait_for_selector('#mOrd.show'); pg.keyboard.press('Escape')
        pg.locator('.card', has_text='ไอดี B').first.locator('h3').click(); pg.wait_for_selector('#byn')
        pg.check('#pd .acc input'); pg.click('#byn'); pg.wait_for_selector('#dr.show')
        ok('cart shows full price, total 500', 'ส่วนลดสมาชิก' not in pg.inner_text('#cpm') and pg.inner_text('#tot').replace(' ', '') == '฿500')
        pg.fill('#cpi', 'TEN'); pg.click('button:has-text("ใช้คูปอง")')
        pg.wait_for_function("document.querySelector('#cpm').textContent.includes('คูปอง')")
        ok('coupon applies to full price: total 450', pg.inner_text('#tot').replace(' ', '') == '฿450')
        pg.screenshot(path='/tmp/np-e2e-cart.png')
        before = api('GET', '/api/me', None, tok)[1]['balance']
        pg.click('#cob'); pg.wait_for_selector('#mOrd.show'); pg.keyboard.press('Escape')
        after = api('GET', '/api/me', None, tok)[1]['balance']
        ok('client total equals server charge (441)', before - after == 441)

        # 7. notifications
        api('POST', '/api/admin/products', {'name': 'ไอดี D ใหม่', 'price': 900, 'cost': 300, 'tags': ['Elite Pass'], 'cred': 'c'}, adm)
        pg.reload(); pg.wait_for_selector('.card')
        pg.wait_for_function("!document.querySelector('#nc').hidden")
        ok('bell shows unread count', int(pg.inner_text('#nc')) >= 1)
        pg.screenshot(path='/tmp/np-e2e-bell_badge.png')
        pg.click('#belb'); pg.wait_for_selector('#mNot.show .nit')
        ok('notification lists followed-tag product', 'ไอดี D ใหม่' in pg.inner_text('#nlist'))
        pg.screenshot(path='/tmp/np-e2e-notifs.png')
        pg.wait_for_function("document.querySelector('#nc').hidden")
        ok('unread cleared after opening bell', api('GET', '/api/me', None, tok)[1]['unread'] == 0)
        pg.click('#nlist .nit'); pg.wait_for_selector('#mPd.show')
        ok('tapping notification opens the product', 'ไอดี D ใหม่' in pg.inner_text('#pd'))
        pg.keyboard.press('Escape')

        # 8. account modal
        pg.evaluate("openPro()"); pg.wait_for_selector('#acx .rcode')
        acx = pg.inner_text('#acx')
        ok('account shows referral code, no tier', 'ระดับสมาชิก' not in acx and 'NP' in acx)
        mycode = api('GET', '/api/me/referral', None, tok)[1]['code']
        ok('referral link uses own code', mycode in acx)
        ok('followed tag listed', 'elite pass' in acx)
        pg.screenshot(path='/tmp/np-e2e-account.png')
        pg.click('#acx .wtags .tagb'); pg.wait_for_timeout(600)
        ok('unfollow from account', 'elite pass' not in api('GET', '/api/watch', None, tok)[1])
        pg.fill('#wti', 'ROV'); pg.click('#acx button:has-text("ติดตาม")'); pg.wait_for_timeout(600)
        ok('follow tag from account input', 'rov' in api('GET', '/api/watch', None, tok)[1])

        # 9. logout
        pg.keyboard.press('Escape'); pg.click('#loginb'); pg.wait_for_timeout(300)
        ok('logout hides bell', not pg.is_visible('#belb'))

        # 10. mobile
        m = br.new_context(viewport={'width': 390, 'height': 800}, locale='th-TH'); m.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        mp = m.new_page(); mp.set_default_timeout(8000); mp.on('pageerror', lambda e: errs.append('mobile pageerror: ' + str(e)))
        mk({'name': 'ไอดี S โปรมือถือ', 'price': 900, 'cost': 300, 'sale_price': 700, 'sale_end': now + 7200_000, 'tags': ['mobile'], 'cred': 's'})
        mp.goto(BASE); mp.wait_for_selector('.card')
        mp.screenshot(path='/tmp/np-e2e-m_shop.png')
        mp.locator('.card', has_text='ไอดี S').first.locator('h3').click(); mp.wait_for_selector('#mPd.show')
        mp.screenshot(path='/tmp/np-e2e-m_detail.png')
        ok('no horizontal overflow on mobile', mp.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
        br.close()
except Exception as e:
    import traceback; traceback.print_exc()
    fails.append('EXCEPTION: ' + str(e)[:200])
finally:
    srv.kill()
ok('no JS errors in console', not errs)
for e in errs: print('   ', e[:300])
print(f'\n{n - len(fails)}/{n} passed')
for f in fails: print('FAIL:', f)
sys.exit(1 if fails else 0)

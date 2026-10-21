import subprocess, os, time, json, urllib.request, urllib.error, shutil, base64
from playwright.sync_api import sync_playwright
PORT=3997; BASE=f'http://localhost:{PORT}'; DB='/tmp/np-box.db'
for f in (DB,DB+'-wal',DB+'-shm'):
    try: os.remove(f)
    except FileNotFoundError: pass
shutil.rmtree('/tmp/np-box-bk',ignore_errors=True)
env={**os.environ,'PORT':str(PORT),'DB_FILE':DB,'APP_SECRET':'s','WEBHOOK_SECRET':'wh','ADMIN_USER':'boss','ADMIN_PASS':'bosspassword1','TRUST_PROXY':'1','BACKUP_DIR':'/tmp/np-box-bk'}
srv=subprocess.Popen(['node','--no-warnings','server.js'],cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1.5)
def api(m,p,b=None,t=None):
    h={'Content-Type':'application/json','X-Forwarded-For':'9.9.9.9'}
    if t:h['Authorization']='Bearer '+t
    r=urllib.request.Request(BASE+p,data=json.dumps(b).encode() if b is not None else None,method=m,headers=h)
    try:
        with urllib.request.urlopen(r) as x:return x.status,json.loads(x.read() or b'{}')
    except urllib.error.HTTPError as e:return e.code,json.loads(e.read() or b'{}')
res=[]
def ok(n,c): res.append((n,bool(c))); print('✓' if c else '✗',n)
try:
    _,d=api('POST','/api/login',{'username':'boss','password':'bosspassword1'}); adm=d['token']
    _,d=api('POST','/api/register',{'username':'cust1','phone':'0811111111','password':'password123'}); ut=d['token']; uid=d['user']['id']
    png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    _,pr=api('POST','/api/admin/products',{'name':'ไอดีรางวัล','price':500,'cost':40,'cred':'user:abc pass:xyz'},adm)
    _,b=api('POST','/api/admin/boxes',{'name':'กล่องทดสอบ','price':50,'descr':'ลุ้นรับ'},adm)
    api('POST',f'/api/admin/boxes/{b["id"]}/items',{'kind':'product','product_id':pr['id'],'weight':1},adm)
    api('POST',f'/api/admin/boxes/{b["id"]}/items',{'kind':'credit','credit_amt':20,'weight':1},adm)
    # give credit directly via admin adjust
    api('POST',f'/api/admin/members/{uid}/adjust',{'delta':500,'reason':'test'},adm)
    with sync_playwright() as p:
        br=p.chromium.launch(); errs=[]
        pg=br.new_page(viewport={'width':390,'height':800}); pg.on('pageerror',lambda e:errs.append(str(e)))
        pg.add_init_script(f"localStorage.setItem('np_token','{ut}')")
        pg.goto(BASE+'/'); pg.wait_for_timeout(1200)
        ok('strip shown when boxes exist', pg.locator('#bxstrip').is_visible())
        pg.click('.bxban'); pg.wait_for_timeout(300)
        ok('modal lists the box', pg.locator('#mBox.show .bxc').count()==1)
        pg.click('.bxc'); pg.wait_for_timeout(200)
        ok('odds are shown 50% each', pg.locator('#bxb .it b').all_inner_texts()==['50%','50%'])
        pg.click('#bxgo'); pg.wait_for_timeout(200)
        ok('must tick terms first', pg.locator('#bxb .it').count()==2 and pg.locator('#bxan').count()==0)
        pg.check('#bxb input[type=checkbox]'); pg.click('#bxgo'); pg.wait_for_timeout(1800)
        txt=pg.locator('#bxb').inner_text()
        ok('result shown', 'ได้รับ' in txt and 'เครดิตคงเหลือ' in txt)
        _,me=api('GET','/api/me',None,ut)
        ok('balance matches server and header', f"{me['balance']:,}" in pg.locator('#bal').inner_text())
        pg.screenshot(path='/tmp/box_result.png')
        pg.click('text=กล่องอื่น'); pg.wait_for_timeout(1500)
        pg.click('text=ประวัติการเปิดกล่อง'); pg.wait_for_timeout(500)
        ok('history lists 1 draw', pg.locator('#bxb .it').count()==1)
        pg.keyboard.press('Escape')
        pg.click('#menub'); pg.wait_for_timeout(400)
        ok('menu has box entry', pg.locator('#mn .mi', has_text='กล่องสุ่ม').count()==1)
        ok('no JS errors on storefront', not errs)
        # admin
        ap=br.new_page(viewport={'width':1200,'height':900}); aerr=[]; ap.on('pageerror',lambda e:aerr.append(str(e)))
        ap.add_init_script(f"localStorage.setItem('np_token','{adm}')")
        ap.goto(BASE+'/admin.html'); ap.wait_for_timeout(1000)
        ap.click('button.nav:has-text("กล่องสุ่ม")'); ap.wait_for_timeout(800)
        ok('admin box tab lists box + draw history', 'กล่องทดสอบ' in ap.locator('#view').inner_text() and 'ประวัติการสุ่มล่าสุด' in ap.locator('#view').inner_text())
        ap.fill('#bxn','กล่องใหม่'); ap.fill('#bxp','25'); ap.click('button:has-text("สร้างกล่อง")'); ap.wait_for_timeout(800)
        print('TOAST:',ap.locator('#toast').inner_text());ok('admin creates box from UI', api('GET','/api/admin/boxes',None,adm)[1].__len__()==2 and 'กล่องใหม่' in ap.locator('#view .card b').all_inner_texts())
        ap.screenshot(path='/tmp/box_admin.png',full_page=True)
        ok('no JS errors on admin', not aerr)
        br.close()
finally:
    srv.kill()
bad=[n for n,c in res if not c]; print('FAILED:',bad) if bad else print('ALL OK',len(res))

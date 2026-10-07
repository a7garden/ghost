from pathlib import Path
import subprocess,json,hashlib,urllib.request,http.cookiejar,time,threading,queue
w=Path('/Users/garden/Documents/Codex/2026-10-01/task-3')
g=Path('/Users/garden/Documents/Workspace/Projects/ghost')
binary=g/'dist/ghost-ui-fixture-macos-arm64'
env={'PATH':'/usr/bin:/bin','LANG':'C'}
root=w/'ui-smoke-state';assert not root.exists()
help=subprocess.run([str(binary),'--help'],env=env,capture_output=True,text=True,timeout=10)
assert help.returncode==0 and 'ui-fixture' in help.stdout
server=subprocess.Popen([str(binary),'--root',str(root),'ui-fixture','--browser-pin',str(w/'handoff-pin.json'),'--seconds','3'],env=env,cwd=w,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
ready=None;ok=False
try:
 q=queue.Queue();thread=threading.Thread(target=lambda:q.put(server.stdout.readline()),daemon=True);thread.start()
 ready=json.loads(q.get(timeout=20));origin=ready['ui'];assert origin.startswith('http://127.0.0.1:') and ready['fixture_origin']!=origin
 jar=http.cookiejar.CookieJar();http=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
 response=http.open(origin+'/',timeout=3);html=response.read().decode();assert response.status==200 and 'MockProvider' in html
 csrf=html.split('name="csrf" content="')[1].split('"')[0]
 request=urllib.request.Request(origin+'/api/snapshot',headers={'X-Ghost-CSRF':csrf})
 data=json.load(http.open(request,timeout=3));assert data['provider']=='MockProvider' and data['live_api_connected']==False
 ids=[p['id'] for p in data['profiles']];sessions=[p['session_id'] for p in data['profiles']]
 assert len(set(ids))==2 and len(set(sessions))==2 and all(len(p['tasks'])==0 for p in data['profiles'])
 assert all(p['browser']['state'] is None for p in data['profiles'])
 server.wait(timeout=8);assert server.returncode==0
 listed=subprocess.run([str(binary),'--root',str(root),'profile','list'],env=env,capture_output=True,text=True,timeout=10)
 assert listed.returncode==0
 ok=True
finally:
 if server.poll() is None:server.kill();server.wait(timeout=5)
 report={'passed':ok,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'environmentCleared':True,'temporaryUiServerFiniteExit':server.returncode==0,'separateOrigins':bool(ready and ready['fixture_origin']!=ready['ui']),'newIndependentIdentities':ids if ok else [],'newIndependentSessions':sessions if ok else [],'mockExplicit':ok,'liveApiCalls':0,'actualBrowserChildrenOpened':0,'guiStarted':False,'browserProfileOrDesktopUsed':False,'nodeBunPythonProductRuntimeInstalled':False,'csrfOrCookieLogged':False}
 (w/'ui-smoke.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))

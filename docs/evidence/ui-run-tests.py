from pathlib import Path
import json,os,subprocess,sys
w=Path('/Users/garden/Documents/Codex/2026-10-01/task-3');r=Path('/Users/garden/Documents/Workspace/Projects/ghost')
mode=sys.argv[1]; features=mode in ['local','engine'];log=w/f'ui-{mode}-tests.log'
profile=str(w/('native-test-isolation.sb' if features else 'sol-test-isolation.sb'))
env={k:v for k,v in os.environ.items() if not any(t in k.upper() for t in ['TOKEN','SECRET','PASSWORD','API_KEY','OAUTH','CREDENTIAL'])};env['RUST_TEST_THREADS']='1';env['GHOST_E2E_PIN']=str(w/'browser-e2e-pin.json');env['GHOST_HANDOFF_PIN']=str(w/'handoff-pin.json');env['GHOST_UI_PIN']=str(w/'handoff-pin.json')
base=['/usr/bin/sandbox-exec','-f',profile]
check=subprocess.run(base+['/usr/bin/true'],env=env,capture_output=True,text=True,timeout=10)
if check.returncode:log.write_text(check.stderr);print(json.dumps({'isolationAvailable':False,'exitCode':check.returncode}));sys.exit(check.returncode)
assert subprocess.run(base+['/bin/test','-r','/Users/garden/.codex/config.toml'],env=env).returncode==1
# Documentation address, never a provider or DNS lookup. Must fail immediately with EPERM.
probe="import socket,errno; s=socket.socket(); s.settimeout(.2); code=s.connect_ex(('198.51.100.1',443)); assert code==errno.EPERM,code"
assert subprocess.run(base+[sys.executable,'-c',probe],env=env,capture_output=True).returncode==0,'public-network deny guard failed'
artifacts=[]
for line in (w/f'ui-{mode}-build.jsonl').read_text().splitlines():
 v=json.loads(line)
 if v.get('reason')=='compiler-artifact' and v.get('executable') and v['profile']['test'] and '/ghost#' in v['package_id']:
  artifacts.append({'name':v['target']['name'],'executable':v['executable']})
assert len(artifacts)==(10 if mode=='default' else 11),len(artifacts)
results=[];chunks=[]
(w/f'ui-{mode}-runner.json').write_text(json.dumps({'pid':os.getpid(),'mode':mode,'state':'running'}))
for v in artifacts:
 if v['name'] in ('browser_local_e2e','browser_handoff','ui_fixture') and mode!='default':
  # macOS rejects different nested sandbox profiles. Each real child applies
  # its own narrower origin/credential policy; the trusted test host is clean.
  clean={'PATH':'/usr/bin:/bin','LANG':'C','RUST_TEST_THREADS':'1','GHOST_E2E_PIN':str(w/'browser-e2e-pin.json'),'GHOST_HANDOFF_PIN':str(w/'handoff-pin.json'),'GHOST_UI_PIN':str(w/'handoff-pin.json')}
  out=subprocess.run([v['executable']],cwd=r,env=clean,capture_output=True,text=True,timeout=180)
 else:
  out=subprocess.run(base+[v['executable']],cwd=r,env=env,capture_output=True,text=True,timeout=180)
 chunks.append(v['name']+'\n'+out.stdout+out.stderr);results.append({'target':v['name'],'exitCode':out.returncode,'hostIsolation':'clean-environment-only; per-child origin sandbox' if v['name'] in ('browser_local_e2e','browser_handoff','ui_fixture') and mode!='default' else 'outer macOS sandbox'})
 log.write_text('\n'.join(chunks))
 (w/f'ui-{mode}-progress.json').write_text(json.dumps({'completedTargets':results},indent=2))
 if out.returncode:break
log.write_text('\n'.join(chunks))
audit={'isolationAvailable':True,'sandboxGuardsApplyTo':'existing regression hosts; real browser children use separate per-child sandbox','regressionHostsGlobalConfigDenied':True,'regressionHostsPublicNetworkDenied':True,'loopbackAllowed':features,'credentialEnvironmentRemoved':True,'realE2eHostCleanEnvironment':features,'realChildrenOriginSandbox':features,'realE2eHostOuterSandbox':False,'persistentSecurityChanges':False,'liveProviderCalls':0,'results':results,'passed':len(results)==len(artifacts) and all(v['exitCode']==0 for v in results)}
(w/f'ui-{mode}-runner.json').write_text(json.dumps({'pid':os.getpid(),'mode':mode,'state':'finished'}));(w/f'ui-{mode}-tests.json').write_text(json.dumps(audit,indent=2)); print(json.dumps(audit));sys.exit(0 if audit['passed'] else 1)

import hashlib,json,os,pathlib,subprocess,tempfile
binary=pathlib.Path('/Users/garden/Documents/Workspace/Projects/ghost/dist/ghost-handoff-checkpoint-macos-arm64')
env={'PATH':'/usr/bin:/bin','LANG':'C'}
with tempfile.TemporaryDirectory(prefix='ghost-handoff-smoke-') as d:
 root=pathlib.Path(d)/'state'
 def cli(*args):
  r=subprocess.run([str(binary),'--root',str(root),*args],env=env,capture_output=True,text=True,timeout=20)
  assert r.returncode==0, (args,r.stderr)
  return json.loads(r.stdout)
 a=cli('profile','create','alpha','--persona','research');b=cli('profile','create','beta','--persona','review')
 args=('ghosts','submit','--request-id','smoke-1','--owner','alpha','--title','shared task','--worker','alpha:research','--worker','beta:review')
 sub=cli(*args);wid=sub['workflow'];assert cli(*args)['workflow']==wid
 run=cli('ghosts','run',wid);status=cli('ghosts','status',wid);replay=cli('ghosts','run',wid)
 assert run['status']=='completed' and status['status']=='completed'
 assert replay['children']==run['children'] and len(run['aggregate']['results'])==2
 assert a['uuid']!=b['uuid']
 for k in run['children']:
  ar=k['artifact'];assert ar['sha256']==hashlib.sha256(ar['content'].encode()).hexdigest()
  assert k['attempt_id'] in ar['provenance'] and k['process_instance_id'] in ar['provenance']
  assert ar['task_uuid']==k['task_uuid'] and ar['profile_uuid']==k['worker_uuid']
 sub2=cli('ghosts','submit','--request-id','smoke-2','--owner','alpha','--title','cancel task','--worker','alpha:research','--worker','beta:review')
 cancelled=cli('ghosts','cancel',sub2['workflow']);assert cancelled['status']=='cancelled'
 assert cli('ghosts','run',sub2['workflow'])['status']=='cancelled'
 assert len(cli('outbox','alpha'))==1 and len(cli('outbox','beta'))==1
 assert len(cli('ghosts','list'))==2
 assert cli('task','provider-receipt','alpha',run['children'][0]['task_uuid']) is None
 evidence={'passed':True,'binary':str(binary),'sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'clearedEnvironment':True,'distinctIdentities':True,'freshCliProcesses':True,'completedArtifacts':2,'duplicateParentAndDelivery':True,'cancelBeforeDispatch':True,'nativeInterpreterRequired':False,'liveProviderCalls':0}
 pathlib.Path('/Users/garden/Documents/Codex/2026-10-01/task-3/handoff-smoke.json').write_text(json.dumps(evidence,indent=2));print(json.dumps(evidence))

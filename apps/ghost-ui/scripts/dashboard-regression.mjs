// Built-UI regression with synthetic Host responses. Never discovers an operating Host.
// PLAYWRIGHT_MODULE may name an existing installation; no downloads or account access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve(process.env.GHOST_DASHBOARD_EVIDENCE || '.orch/ghost-dashboard-20261104/browser');
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const origin = await new Promise((resolveOrigin, reject) => {
  const timer = setTimeout(() => reject(new Error('UI fixture server did not start')), 10000);
  server.stdout.on('data', bytes => { const match = bytes.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolveOrigin(match[0]); } });
  server.once('error', reject);
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const primary = '11111111-1111-4111-8111-111111111111', scout = '22222222-2222-4222-8222-222222222222', chat = '33333333-3333-4333-8333-333333333333';
const scoutChat = '44444444-4444-4444-8444-444444444444';
const writer = '77777777-7777-4777-8777-777777777777', createdGhost = '88888888-8888-4888-8888-888888888888';
const registry = [
  { ghost_id: primary, conversation_id: chat, kind: 'primary', mode: 'active', roles: [] },
  { ghost_id: scout, conversation_id: scoutChat, kind: 'specialist', mode: 'active', roles: ['research'] },
];
let currentRegistry = [...registry];
const workspace = {
  workspace_id: '55555555-5555-4555-8555-555555555555', default_model: 'mock', lifetime_authority: { authority_epoch: 1, dispatch_enabled: true },
  profiles: [
    { id: primary, name: 'Ghost', persona: '일을 나누고 결과를 살펴봅니다.', conversations: [], policy: {} },
    { id: scout, name: 'Scout', persona: '필요한 자료를 조사하고 정리합니다.', conversations: [], policy: {} },
    { id: writer, name: 'Writer', persona: '기존 기록을 정리합니다.', conversations: ['legacy-writer-chat'], policy: {} },
  ],
  avatars: [], reviews: [], goals: [], schedules: [], spaces: [], delegations: [], todos: [], calendar_events: [], integration_approvals: [],
  integrations: [{ id: 'notes', name: 'Research tools', transport: {kind:'http',url:'https://example.invalid/mcp',bearer_env:null}, profiles:[scout], enabled:true, version:1, approved_tools:['search'], tools:[{name:'search',description:'공개 자료 검색',inputSchema:{type:'object'}}], checked_ms:1793761200000,error:null }],
  capabilities: {documents:true,memory:true,integration_approvals:true}, connectors: {},
  model_settings: {version:1,providers:[],roles:{llm:null,stt:null,tts:null},catalog_updated_ms:null},
};
const goal = (id, prompt, ghostID=primary, conversationID=chat) => ({id,revision:2,requirement_digest:'a'.repeat(64),prompt,accountable_ghost:ghostID,reply_conversation:conversationID,privacy:'public',state:'open',acceptance_spec:{}});
const work = (id, state, owner) => ({id,goal_id:id,goal_revision:2,owner,owner_revision:1,state,execution_id:`run-${id}`,cancellation:'none',blocker:null});
const artifactBytes = Buffer.from(`<meta http-equiv="refresh" content="0;url=https://artifact.invalid/refresh"><script>globalThis.__artifactExecuted=true</script><img src="https://artifact.invalid/remote">\n`);
const resultArtifact = {digest:createHash('sha256').update(artifactBytes).digest('hex'),locator:'immutable/result.html',privacy:'local_only',producing_attempt:'run-b'};
const lifetime = {protocol_version:'ghost-lifetime/1',contract_revision:1,mode:'live',goals:[goal('a','다음 여행을 위한 자료 정리'),goal('b','주간 업무 요약 검토',scout,scoutChat),goal('old','이전 판본의 작업')],work:[work('a','running',scout),work('b','completed',scout),{...work('old','running',scout),goal_revision:1}],bindings:[],artifacts:[resultArtifact],acceptances:[]};
const inference = {ok:true,settings:{version:1,default:{provider:'local',model:'Local model',effort:'off'},conversations:{[`${scout}/${scoutChat}`]:{provider:'codex',model:'gpt-6-luna',effort:'high'}},external_grants:{},credentials:{minimax:true},image_provider:'codex'},providers:[
  {id:'codex',name:'Codex · ChatGPT OAuth',auth:'codex_oauth',models:['gpt-6-luna'],efforts:['high'],default_model:'gpt-6-luna',default_effort:'high',image:true},
  {id:'zai-coding',name:'Z.AI Coding Plan',auth:'api_key',models:['glm-5.3'],efforts:['high'],default_model:'glm-5.3',default_effort:'high',image:false},
  {id:'minimax',name:'MiniMax',auth:'api_key',models:['MiniMax-M3.1-Flash-Preview'],efforts:['high'],default_model:'MiniMax-M3.1-Flash-Preview',default_effort:'high',image:true},
  {id:'local',name:'로컬 모델',auth:'none',models:['Local model'],efforts:['off'],default_model:'Local model',default_effort:'off',image:true},
]};
const reply = data => ({status:'success',summary:'',object_refs:[],artifacts:[],next_actions:[],error_code:null,retry_class:'same_id',data});
const checks=[], pageErrors=[], writes=[], pairingWrites=[], artifactReads=[], ensureWrites=[], profileCreates=[];
let artifactTampered=false, artifactNetworkRequests=0;
let snapshotFailure=false, workFailure=false, inferenceFailure=false, acceptPairWrite=false, pairingInvitation;
async function fixtureContext(theme='light') {
  const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:theme,reducedMotion:'reduce'});
  await context.addInitScript(theme=>localStorage.setItem('ghost-ui:preferences',JSON.stringify({theme,animate:false,companion:false})),theme);
  await context.route('https://artifact.invalid/**',route=>{artifactNetworkRequests++; return route.abort();});
  await context.route('**/ghost-packages/**',route=>route.fulfill({json:{[scout]:{id:'research',name:'Research desk',version:'1.0.0',digest:'b'.repeat(64),ui:{views:[{id:'library',label:'자료실',route:'/library'}]}}}}));
  await context.route('**/ghost-api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(path.endsWith('/bootstrap')) return route.fulfill({json:{mode:'live',csrf:'fixture-only'}});
    if(path.endsWith('/snapshot')) return route.fulfill(snapshotFailure?{status:502,json:{error:'fixture offline'}}:{json:workspace});
    if(path.endsWith('/mobile/targets')) {
      return route.fulfill({json:{targets:currentRegistry.map(({mode, ...target}) => target)}});
    }
    if(path.endsWith('/mobile/invitations')) {
      if(route.request().method()==='GET') return route.fulfill({json:{invitations:[]}});
      const body=route.request().postDataJSON();
      pairingWrites.push(body);
      if(pairingWrites.length===1) return route.fulfill({status:502,json:{error:'fixture invitation receipt lost'}});
      pairingInvitation={
        invitation_id:body.request_id, origin:'https://ghost.example.invalid', status:'open',
        expires_at:new Date(Date.now()+300000).toISOString(),
        scope:{kind:'lifetime',targets:body.targets,ghost_ids:body.targets.map(pair=>pair.ghost_id),
          conversation_ids:body.targets.map(pair=>pair.conversation_id),capabilities:['lifetime.read','lifetime.write']},
      };
      return route.fulfill({json:pairingInvitation});
    }
    if(path.includes('/mobile/invitations/') && pairingInvitation) {
      if(path.endsWith('/approve')) {
        pairingWrites.push(route.request().postDataJSON());
        pairingInvitation.status='approved';
        return route.fulfill({json:{ok:true}});
      }
      return route.fulfill({json:pairingInvitation});
    }
    if(path.endsWith('/inference/settings')) {
      if(route.request().method()==='POST') {
        const body=route.request().postDataJSON();
        writes.push(body);
        if(acceptPairWrite && body.operation==='select') {
          const key=`${body.ghost_id}/${body.conversation_id}`;
          inference.settings.version+=1;
          inference.settings.conversations[key]=body.selection;
          if(body.allow_external) inference.settings.external_grants[key]=[body.selection.provider];
          return route.fulfill({json:inference});
        }
        return route.fulfill({status:409,json:{ok:false,error:'설정이 변경되었습니다. 다시 확인해 주세요.'}});
      }
      return route.fulfill(inferenceFailure?{status:502,json:{ok:false,error:'fixture unavailable'}}:{json:inference});
    }
    if(path.endsWith('/action')) {
      const command=route.request().postDataJSON().command;
      if(command.type==='workspace' && command.action?.type==='memory_source_list') {
        return route.fulfill({json:{ok:true,result:reply({sources:[],truncated:false})}});
      }
      if(command.type==='lifetime') {
        const {method, ghost_id, conversation_id}=command.envelope.body;
        if(method==='snapshot') return route.fulfill(workFailure?{status:502,json:{ok:false,error:'fixture work unavailable'}}:{json:{ok:true,result:reply(lifetime)}});
        if(method==='work.artifact') {
          artifactReads.push(command.envelope.body);
          const bytes=Buffer.from(artifactBytes);
          if(artifactTampered) bytes[0]^=1;
          return route.fulfill({json:{ok:true,result:{
            ...reply({work_id:'b',goal_id:'b',goal_revision:2,execution_id:'run-b',digest:resultArtifact.digest,
              privacy:resultArtifact.privacy,encoding:'base64',byte_length:bytes.length,data:bytes.toString('base64')}),
            object_refs:['b'],artifacts:[resultArtifact],
          }}});
        }
        if(method==='registry.inspect') return route.fulfill({json:{ok:true,result:reply({registry:currentRegistry})}});
        if(method==='registry.ensure') {
          const body=command.envelope.body;
          ensureWrites.push(body);
          const target={ghost_id:body.ghost_id,conversation_id:body.conversation_id,kind:body.kind,mode:'active',roles:body.roles};
          currentRegistry.push(target);
          return route.fulfill({json:{ok:true,result:reply({registry:target})}});
        }
        if(method==='conversation.inspect') return route.fulfill({json:{ok:true,result:reply({ghost_id,conversation_id,privacy:'public',turns:[],turn_runs:[],has_older:false,oldest_sequence:null})}});
        if(method.endsWith('.inspect')) return route.fulfill({json:{ok:true,result:reply({})}});
      }
      if(command.type==='create_profile') {
        profileCreates.push(command);
        workspace.profiles.push({id:createdGhost,name:command.name,persona:command.persona,conversations:[],policy:{}});
        return route.fulfill({json:{ok:true,result:{profile_id:createdGhost}}});
      }
      writes.push(command);
      return route.fulfill({status:409,json:{ok:false,error:'Fixture rejects mutations'}});
    }
    return route.fulfill({status:404,json:{error:'fixture route absent'}});
  });
  return context;
}
try {
  for(const theme of ['light','dark']) {
    const context=await fixtureContext(theme),page=await context.newPage();
    page.on('pageerror',error=>pageErrors.push(error.message));
    for(const width of [320,375,414,768,1440]) {
      await page.setViewportSize({width,height:1000});
      for(const [path,heading,selector] of [['/','대시보드','.dashboard-task'],['/host','호스트','.host-summary'],['/providers','프로바이더','.connection-provider'],['/integrations','확장','.connection-mcp']]) {
        await page.goto(`${origin}/#${path}`);
        await page.getByRole('heading',{name:heading,exact:true,level:1}).waitFor();
        await page.locator(selector).first().waitFor();
        const overflow=await page.evaluate(()=>[...document.querySelectorAll('main button, main input, main select, main section, main h1, .ghost-shell-toolbar')].filter(el=>{
          const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&(r.left< -1||r.right>innerWidth+1);
        }).map(el=>({tag:el.tagName,class:el.className,width:el.getBoundingClientRect().width})));
        assert.deepEqual(overflow,[],`${theme} ${width} ${path} overflows`);
        if(path==='/') {
          assert.equal(await page.locator('.dashboard-task').count(),2);
          const roster=page.getByRole('region',{name:'나의 Ghost',exact:true});
          await roster.getByRole('button',{name:/^Ghost 기본/}).waitFor();
          assert.equal(await page.locator('.dashboard-metrics button').first().locator('strong').textContent(),'1');
          assert.equal(await page.getByText('이전 판본의 작업',{exact:true}).count(),0);
        }
        if(path==='/providers') assert.equal(await page.locator('input[type=password]').count(),0);
        if(width===375||width===1440) {
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.screenshot({path:`${output}/${theme}-${width}-${path==='/'?'dashboard':path.slice(1)}.png`,fullPage:true});
        }
        checks.push(`${theme}/${width}${path}`);
      }
    }
    await page.setViewportSize({width:375,height:900});
    await page.goto(origin);
    await page.getByRole('heading',{name:'대시보드',exact:true,level:1}).waitFor();
    await page.getByRole('button',{name:'전체 메뉴',exact:true}).click();
    const menu=page.getByRole('dialog',{name:'Ghost',exact:true});
    await menu.getByRole('button',{name:'프로바이더',exact:true}).click();
    assert.equal(await menu.count(),0);
    await page.getByRole('heading',{name:'프로바이더',exact:true,level:1}).waitFor();
    await page.getByRole('button',{name:'Z.AI Coding Plan API 키 등록',exact:true}).click();
    assert.equal(await page.getByLabel('Z.AI Coding Plan API 키',{exact:true}).count(),1);
    await page.getByRole('button',{name:'Z.AI Coding Plan API 키 닫기',exact:true}).click();
    assert.equal(await page.locator('input[type=password]').count(),0);
    await page.getByRole('button',{name:'전체 메뉴',exact:true}).click();
    await menu.locator('.sidebar-host-status').click();
    await menu.waitFor({state:'detached'});
    await page.getByRole('heading',{name:'호스트',exact:true,level:1}).waitFor();
    await page.getByRole('button',{name:'전체 메뉴',exact:true}).click();
    await menu.getByRole('button',{name:'프로바이더',exact:true}).click();
    await page.getByRole('button',{name:'명령 검색',exact:true}).click();
    await page.getByRole('combobox',{name:'작업실 검색'}).fill('호스트');
    await page.keyboard.press('Enter');
    await page.getByRole('heading',{name:'호스트',exact:true,level:1}).waitFor();
    checks.push(`${theme}/mobile-menu,key-disclosure,host-status-closes-menu,keyboard-search`);
    await context.close();
  }
  const context=await fixtureContext(),page=await context.newPage();
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(origin);await page.locator('.dashboard-task').first().waitFor();
  assert.equal(await page.locator('.app-shell').evaluate(el=>getComputedStyle(el).display),'grid','shared application styles are loaded');
  assert.equal(writes.length,0,'navigation and reads never mutate');
  workFailure=true;
  await page.getByText('최신 작업 상태를 확인하지 못했습니다.',{exact:false}).waitFor({timeout:15000});
  assert.equal(await page.locator('.dashboard-task').count(),2,'stale work retained');
  checks.push('work-read-failure-keeps-marked-snapshot');
  await page.goto(`${origin}/#/providers`);await page.locator('.connection-provider').first().waitFor();
  await page.getByRole('button',{name:'기본 모델 저장',exact:true}).click();
  await page.getByText('설정이 변경되었습니다. 다시 확인해 주세요.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'기본 모델 저장',exact:true}).isDisabled(),true);
  assert.equal(writes.length,1,'one explicit save, no automatic retry');
  await page.getByRole('button',{name:'다시 확인',exact:true}).click();
  await page.locator('.connection-provider').first().waitFor();
  checks.push('provider-CAS-error-reload-no-replay');
  await page.getByRole('button',{name:'Z.AI Coding Plan API 키 등록',exact:true}).click();
  const keyInput=page.getByLabel('Z.AI Coding Plan API 키',{exact:true});
  await keyInput.fill('synthetic-key-that-must-clear');
  snapshotFailure=true;
  await page.getByText('호스트에 연결하면 설정을 변경할 수 있습니다.',{exact:true}).first().waitFor({timeout:12000});
  await keyInput.waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'기본 모델 저장',exact:true}).isDisabled(),true);
  checks.push('host-disconnect-locks-settings');
  snapshotFailure=false;workFailure=false;
  await page.getByRole('button',{name:'다시 연결',exact:true}).click();
  await page.locator('.connection-provider').first().waitFor();
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(el=>el.textContent==='기본 모델 저장')?.disabled);
  await page.getByRole('button',{name:'Z.AI Coding Plan API 키 등록',exact:true}).click();
  assert.equal(await keyInput.inputValue(),'');
  await page.getByRole('button',{name:'Z.AI Coding Plan API 키 닫기',exact:true}).click();
  checks.push('host-reconnect-recovers-settings-without-retaining-key');

  await page.getByText('음성 및 호환 서버',{exact:true}).click();
  await page.getByRole('button',{name:'서버 추가',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'제공자 등록',exact:true});
  const editorName=editor.getByLabel('이름',{exact:true});
  const editorSave=editor.getByRole('button',{name:'설정 저장',exact:true});
  await editorName.fill('Unsubmitted compatibility server');
  snapshotFailure=true;
  await editor.getByText('호스트에 연결하면 저장할 수 있습니다.',{exact:true}).waitFor({timeout:12000});
  assert.equal(await editorName.inputValue(),'Unsubmitted compatibility server');
  assert.equal(await editorSave.isDisabled(),true);
  assert.equal(await editor.getByRole('button',{name:'취소',exact:true}).isEnabled(),true);
  snapshotFailure=false;
  await editor.getByText('호스트에 연결하면 저장할 수 있습니다.',{exact:true}).waitFor({state:'detached',timeout:12000});
  assert.equal(await editorName.inputValue(),'Unsubmitted compatibility server');
  assert.equal(await editorSave.isEnabled(),true);
  await editor.getByRole('button',{name:'취소',exact:true}).click();
  checks.push('compatibility-editor-preserves-draft-through-disconnect');

  await page.goto(`${origin}/#/lifetime?panel=ghosts`);
  const pair=page.getByRole('region',{name:'이 대화의 모델',exact:true});
  const toggle=pair.getByRole('button', {name:/Local model|gpt-6-luna|MiniMax-M3.1-Flash-Preview/});
  const modelDialog=page.getByRole('dialog',{name:'대화 모델',exact:true});
  const provider=modelDialog.getByLabel('대화 제공자',{exact:true});
  const consent=modelDialog.getByRole('checkbox',{name:/기존 기록과 새 메시지/});
  const apply=modelDialog.getByRole('button',{name:'이 대화에 적용',exact:true});
  await toggle.filter({hasText:'Local model'}).click();
  await provider.selectOption('minimax');
  await consent.check();
  await provider.selectOption('codex');
  assert.equal(await consent.isChecked(),false);
  assert.equal(await apply.isDisabled(),true);
  checks.push('provider-change-clears-external-consent');

  await provider.selectOption('minimax');
  await consent.check();
  await modelDialog.getByRole('button',{name:'닫기',exact:true}).click();
  await toggle.click();
  assert.equal(await provider.inputValue(),'minimax');
  assert.equal(await consent.isChecked(),false);
  await modelDialog.getByRole('button',{name:'닫기',exact:true}).click();
  checks.push('closing-model-settings-preserves-selection-and-clears-consent');
  await page.getByRole('button',{name:/^Scout/}).click();
  await page.waitForFunction(({id,conversation})=>{
    const params=new URLSearchParams(location.hash.split('?')[1]??'');
    return params.get('ghost')===id && params.get('conversation')===conversation;
  },{id:scout,conversation:scoutChat});
  await page.getByRole('button',{name:'Ghost 관리',exact:true}).click();
  await toggle.filter({hasText:'gpt-6-luna'}).click();
  assert.equal(await provider.inputValue(),'codex');
  assert.equal(await consent.isChecked(),false);
  assert.equal(await apply.isDisabled(),true);
  checks.push('pair-change-loads-saved-model-and-clears-consent');

  await consent.check();
  snapshotFailure=true;
  await modelDialog.getByText('호스트에 연결하면 설정을 변경할 수 있습니다.',{exact:true}).waitFor({timeout:12000});
  assert.equal(await consent.isDisabled(),true);
  assert.equal(await consent.isChecked(),false);
  assert.equal(await apply.isDisabled(),true);
  snapshotFailure=false;
  await page.waitForFunction(() => document.querySelector('dialog[open] select[aria-label="대화 제공자"]')?.disabled === false, null, {timeout:12000});
  await consent.waitFor();
  assert.equal(await consent.isChecked(),false);
  assert.equal(await apply.isDisabled(),true);
  checks.push('pair-disconnect-and-reconnect-require-new-consent');

  await consent.check();
  const beforePairWrite=writes.length;
  await apply.click();
  await modelDialog.getByText('설정이 변경되었습니다. 다시 확인해 주세요.',{exact:true}).waitFor();
  assert.equal(await consent.isDisabled(),true);
  assert.equal(await apply.isDisabled(),true);
  assert.equal(await modelDialog.getByLabel('이미지 생성 제공자',{exact:true}).isDisabled(),true);
  assert.equal(writes.length,beforePairWrite+1);
  assert.deepEqual(writes.at(-1),{version:1,operation:'select',ghost_id:scout,conversation_id:scoutChat,selection:{provider:'codex',model:'gpt-6-luna',effort:'high'},allow_external:true});
  await modelDialog.getByRole('button',{name:'다시 확인',exact:true}).click();
  await consent.waitFor();
  assert.equal(await consent.isChecked(),false);
  assert.equal(await apply.isDisabled(),true);
  assert.equal(writes.length,beforePairWrite+1);
  checks.push('pair-save-failure-locks-and-reload-requires-new-consent-without-replay');

  acceptPairWrite=true;
  await provider.selectOption('minimax');
  await consent.check();
  await apply.click();
  await modelDialog.getByText('이 대화의 모델을 저장했습니다.',{exact:true}).waitFor();
  await modelDialog.getByText('이 대화의 MiniMax 외부 처리가 허용돼 있습니다.',{exact:true}).waitFor();
  assert.equal(await consent.count(),0);
  assert.match(await toggle.textContent(),/MiniMax-M3.1-Flash-Preview/);
  assert.deepEqual(writes.at(-1),{version:1,operation:'select',ghost_id:scout,conversation_id:scoutChat,selection:{provider:'minimax',model:'MiniMax-M3.1-Flash-Preview',effort:'high'},allow_external:true});
  await modelDialog.getByRole('button',{name:'닫기',exact:true}).click();
  checks.push('pair-saves-exact-target-and-renders-host-grant');

  await page.goto(`${origin}/#/providers`);
  inferenceFailure=true;
  await page.reload();await page.getByText('fixture unavailable',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'기본 모델 저장',exact:true}).count(),0);
  checks.push('provider-first-load-failure-no-stale-form');

  await page.setViewportSize({width:320,height:900});
  await page.goto(`${origin}/#/lifetime?panel=work&scope=all&ghost=${primary}&conversation=${chat}`);
  await page.locator('[data-lifetime-goal="a"]').waitFor();
  await page.locator('[data-lifetime-goal="b"]').waitFor();
  assert.equal(await page.locator('[data-lifetime-goal="a"]').count(),1);
  assert.equal(await page.locator('[data-lifetime-goal="b"]').count(),1,'global work includes a goal assigned to another Ghost');
  const mobileTabs=page.locator('.mobile-primary-tabs');
  assert.equal(await mobileTabs.isVisible(),true);
  assert.equal(await mobileTabs.getByRole('button',{name:'작업',exact:true}).getAttribute('aria-current'),'page');
  await mobileTabs.getByRole('button',{name:'홈',exact:true}).click();
  await page.getByRole('heading',{name:'대시보드',exact:true,level:1}).waitFor();
  assert.equal(await mobileTabs.getByRole('button',{name:'홈',exact:true}).getAttribute('aria-current'),'page');
  await mobileTabs.getByRole('button',{name:'작업',exact:true}).click();
  await page.locator('[data-lifetime-goal="b"]').waitFor();
  assert.match(new URL(page.url()).hash,/scope=all/,'mobile Work keeps global scope');
  checks.push('global-work-cross-ghost-and-mobile-tabs-320');

  await page.goto(`${origin}/#/lifetime?panel=work&scope=all&ghost=${primary}&conversation=${chat}&goal=b&work=b`);
  const goalDialog=page.getByRole('dialog',{name:'목표 상세',exact:true});
  await goalDialog.waitFor();
  assert.equal(await goalDialog.locator('.lifetime-goal-detail textarea').inputValue(),'주간 업무 요약 검토');
  await goalDialog.locator('[data-lifetime-work="b"]').waitFor();
  assert.equal(await goalDialog.locator('[data-lifetime-work]').count(),1,'deep link opens only the exact goal work item');
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-lifetime-work')==='b');
  checks.push('global-deep-link-opens-exact-cross-ghost-work');

  await page.goto(`${origin}/#/lifetime?ghost=${primary}&conversation=${chat}`);
  const composer=page.locator('#lifetime-message');
  await composer.waitFor();
  assert.equal(await mobileTabs.isVisible(),true);
  assert.equal(await mobileTabs.getByRole('button',{name:'대화',exact:true}).getAttribute('aria-current'),'page');
  const composeOptions=page.locator('.lifetime-compose-options');
  const optionsTrigger=composeOptions.getByRole('button',{name:/^전송 옵션/});
  const optionsDialog=page.getByRole('dialog',{name:'전송 옵션',exact:true});
  await optionsTrigger.focus();
  await optionsTrigger.press('Enter');
  await optionsDialog.waitFor();
  await page.screenshot({path:`${output}/light-320-compose-options.png`});
  const privacySelect=optionsDialog.getByLabel('자료 범위',{exact:true});
  await privacySelect.selectOption('public');
  const targetSelect=optionsDialog.getByLabel('대화 대상',{exact:true});
  const scoutValue=await targetSelect.locator('option').filter({hasText:'Scout'}).first().getAttribute('value');
  assert.ok(scoutValue);
  await targetSelect.selectOption(scoutValue);
  await page.waitForFunction(id=>new URLSearchParams(location.hash.split('?')[1]??'').get('ghost')===id,scout);
  if (!await optionsDialog.isVisible()) await optionsTrigger.click();
  assert.equal(await privacySelect.inputValue(),'local_only','changing Ghosts resets the compose privacy scope');
  await page.keyboard.press('Escape');
  await optionsDialog.waitFor({state:'hidden'});
  assert.equal(await page.locator('details, summary').count(),0);
  assert.equal(await optionsTrigger.evaluate(element=>element === document.activeElement),true);
  checks.push('pair-switch-resets-compose-privacy-320', 'compose-options-keyboard-dialog-restores-focus');
  await composer.focus();
  assert.equal(await mobileTabs.isVisible(),false,'mobile tabs yield to the focused composer at 320px');
  checks.push('mobile-composer-focus-hides-tabs-320');

  await page.goto(`${origin}/#/ghosts`);
  await page.waitForURL(`${origin}/#/`);
  const roster=page.getByRole('region',{name:'나의 Ghost',exact:true});
  const writerRow=roster.getByRole('button',{name:/^Writer/});
  await writerRow.waitFor();
  await roster.getByRole('button',{name:/^Ghost 기본/}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Ghosts',exact:true}).count(),0);
  assert.equal(ensureWrites.length,0,'the redirected dashboard roster is read-only');
  await page.goto(`${origin}/#/lifetime?ghost=${writer}&register=${crypto.randomUUID()}`);
  await page.waitForTimeout(500);
  assert.equal(ensureWrites.length,0,'a register URL parameter alone never creates a Host binding');
  await page.goto(`${origin}/#/`);
  await writerRow.click();
  await page.getByRole('button',{name:'새 대화 연결',exact:true}).waitFor();
  assert.equal(ensureWrites.length,0,'opening an unregistered Ghost is read-only until the explicit action');
  await page.getByRole('button',{name:'새 대화 연결',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.ghost-switcher-trigger')?.getAttribute('aria-label')==='Ghost 전환 · Writer');
  assert.equal(ensureWrites.length,1,'one explicit click makes exactly one registration request');
  const writerEnsure=ensureWrites[0];
  assert.deepEqual(writerEnsure,{method:'registry.ensure',ghost_id:writer,kind:'specialist',conversation_id:writerEnsure.conversation_id,roles:[]});
  assert.match(writerEnsure.conversation_id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  await page.waitForTimeout(250);
  assert.equal(ensureWrites.length,1,'registration is not replayed after the refreshed pair opens');
  assert.match(new URL(page.url()).hash,new RegExp(`ghost=${writer}.*conversation=${writerEnsure.conversation_id}`));
  await page.goto(`${origin}/#/`);
  await writerRow.click();
  await page.locator('#lifetime-message').waitFor();
  assert.equal(await page.getByRole('heading',{name:'Writer',exact:true}).first().isVisible(),true);
  assert.equal(ensureWrites.length,1,'the roster opens the current conversation without registering again');
  checks.push('dashboard-roster-redirect-explicit-registration-and-open-current');

  await page.goto(`${origin}/#/`);
  await roster.getByRole('button',{name:'Ghost 만들기',exact:true}).click();
  const createDialog=page.getByRole('dialog',{name:'Ghost 만들기',exact:true});
  await createDialog.getByLabel('Ghost 이름').fill('CreatedGhost');
  await createDialog.getByLabel('역할 메모').fill('새 담당 Ghost의 역할을 표시합니다.');
  await createDialog.getByRole('button',{name:'Ghost 만들기',exact:true}).click();
  await page.waitForFunction(id=>{
    const params=new URLSearchParams(location.hash.split('?')[1]??'');
    return params.get('ghost')===id && params.has('conversation') && !params.has('register');
  },createdGhost,{timeout:15000});
  assert.equal(profileCreates.length,1,'the synthetic profile receipt is applied once');
  assert.deepEqual(ensureWrites.map(({ghost_id,kind,roles})=>({ghost_id,kind,roles})),[
    {ghost_id:writer,kind:'specialist',roles:[]},
    {ghost_id:createdGhost,kind:'specialist',roles:[]},
  ]);
  assert.equal(ensureWrites[1].conversation_id,new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('conversation'),
    'the created Ghost opens the exact conversation bound after its create receipt');
  assert.equal(profileCreates[0].name,'CreatedGhost');
  checks.push('create-receipt-registers-same-ghost-and-opens-bound-conversation');

  const beforeCollaborationRequest=writes.length;
  await page.goto(`${origin}/#/together`);
  await page.getByRole('heading',{name:'협업',exact:true,level:1}).waitFor();
  await page.getByRole('button',{name:'협업 요청',exact:true}).click();
  await page.locator('#lifetime-message').waitFor();
  assert.equal(new URL(page.url()).hash,'#/lifetime','the retired collaboration form routes to the durable Ghost conversation');
  assert.equal(writes.length,beforeCollaborationRequest,'opening a collaboration request creates no unsupported legacy work');
  checks.push('collaboration-cta-opens-canonical-chat-without-write');

  currentRegistry=[...registry];

  await page.setViewportSize({width:320,height:900});
  await page.goto(`${origin}/#/lifetime?panel=work&scope=all&ghost=${primary}&conversation=${chat}`);
  await page.getByRole('button',{name:/주간 업무 요약 검토/}).click();
  const openResult=page.getByRole('button',{name:'결과 열기',exact:true});
  const reader=page.getByRole('dialog',{name:'결과 문서',exact:true});
  await openResult.click();
  await reader.locator('.garden-document-source-readonly code').waitFor();
  assert.equal(await reader.locator('.garden-document-source-readonly code').textContent(),artifactBytes.toString());
  assert.equal(await reader.locator('iframe, script, img, a').count(),0,'artifact markup is inert');
  assert.equal(await page.evaluate(()=>globalThis.__artifactExecuted),undefined);
  assert.equal(artifactNetworkRequests,0);
  assert.deepEqual(artifactReads[0],{method:'work.artifact',work_id:'b',execution_id:'run-b',
    digest:resultArtifact.digest,locator:resultArtifact.locator});
  await reader.getByRole('button',{name:'닫기',exact:true}).click();
  artifactTampered=true;
  await openResult.click();
  await reader.getByText('결과물의 작업 정보와 원문을 확인하지 못했습니다.',{exact:true}).waitFor();
  assert.equal(await reader.locator('.garden-document-source-readonly').count(),0);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(key=>key.endsWith(':outbox')
    && (localStorage.getItem(key)??'').includes('work.artifact'))),false);
  assert.equal(artifactReads.length,2);
  assert.deepEqual(artifactReads[1],artifactReads[0]);
  assert.equal(artifactNetworkRequests,0);
  await reader.getByRole('button',{name:'닫기',exact:true}).click();
  checks.push('artifact-exact-bound-read-inert-source-tamper-rejected-no-outbox');

  await page.setViewportSize({width:320,height:900});
  await page.goto(`${origin}/#/integrations`);
  await page.getByRole('button',{name:'MCP 설정 예시',exact:true}).click();
  const examples=page.getByRole('dialog',{name:'MCP 설정 예시',exact:true});
  await examples.getByRole('button',{name:'설정 사용',exact:true}).first().click();
  const preset=page.getByRole('dialog').filter({has:page.getByRole('button',{name:'설정 저장',exact:true})});
  await preset.waitFor();
  await page.keyboard.press('Escape');
  await preset.waitFor({state:'hidden'});
  await examples.waitFor();
  await examples.getByRole('button',{name:'닫기',exact:true}).click();
  checks.push('integration-preset-escape-returns-to-parent-dialog');
  const pairing=page.getByRole('region',{name:'휴대폰 연결',exact:true});
  const primaryPair=pairing.getByRole('checkbox',{name:'Ghost',exact:true});
  const specialistPair=pairing.getByRole('checkbox',{name:'Scout',exact:true});
  await primaryPair.waitFor();
  assert.ok((await primaryPair.boundingBox())?.width <= 24,'pairing checkbox leaves space for the Ghost name');
  assert.equal(await primaryPair.isChecked(),true);
  assert.equal(await specialistPair.isChecked(),false);
  await specialistPair.check();
  await pairing.getByRole('button',{name:'QR·연결 코드 만들기',exact:true}).click();
  await pairing.getByText('fixture invitation receipt lost',{exact:true}).waitFor();
  assert.equal(await specialistPair.isDisabled(),true);
  await pairing.getByRole('button',{name:'같은 연결 요청 확인',exact:true}).click();
  await pairing.getByLabel('Ghost 휴대폰 연결 QR',{exact:true}).waitFor();
  assert.deepEqual(pairingWrites[0],pairingWrites[1],'retry preserves nonce, digests and exact Ghost pairs');
  assert.deepEqual(pairingWrites[0].targets,registry.map(({ghost_id,conversation_id})=>({ghost_id,conversation_id})));

  pairingInvitation.status='pending';
  pairingInvitation.claim={claim_id:'66666666-6666-4666-8666-666666666666',device_name:'Fixture iPhone',
    verification_code:'314159',device_fingerprint:'fixture-fingerprint',status:'pending'};
  await pairing.getByText('Fixture iPhone',{exact:true}).waitFor();
  const scope=pairing.getByRole('list',{name:'휴대폰에 허용할 Ghost',exact:true});
  assert.deepEqual(await scope.getByRole('listitem').allTextContents(),['Ghost','Scout']);
  assert.equal(await pairing.getByText(scout,{exact:false}).count(),0);
  const bounds=await pairing.boundingBox();
  assert.ok(bounds && bounds.x>=0 && bounds.x+bounds.width<=321,'320px pairing stays within viewport');
  await pairing.getByRole('button',{name:'숫자가 같아요 · 이 기기 연결 승인',exact:true}).click();
  await pairing.getByText('기기 접근을 승인했습니다. 휴대폰에서 연결 상태를 확인하세요.',{exact:true}).waitFor();
  assert.deepEqual(Object.keys(pairingWrites[2]).sort(),['claim_id','request_id','verification_code']);
  assert.equal(pairingWrites[2].claim_id,pairingInvitation.claim.claim_id);
  assert.equal(pairingWrites[2].verification_code,'314159');
  checks.push('pairing-default-explicit-pairs-lost-receipt-review-approval-320');
  await context.close();
  assert.deepEqual(writes.map(body=>body.operation),['set_default','select','select']);
  assert.deepEqual(pageErrors,[]);
  await writeFile(`${output}/result.json`,JSON.stringify({status:'passed',checks,explicitWrites:writes.length,pageErrors,fixtureOnly:true},null,2));
  console.log(JSON.stringify({status:'passed',checks:checks.length,explicitWrites:writes.length,pageErrors,output}));
} finally {
  await browser.close();server.kill('SIGTERM');await once(server,'exit');
}

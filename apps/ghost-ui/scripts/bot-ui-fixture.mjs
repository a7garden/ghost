// Isolated browser acceptance fixture. No Host discovery, model, credentials,
// network adapter, or production store. All receipts live in browser storage.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '/src/App.tsx';
import { initialWorkspace } from '/src/fixtures/workspace.ts';
import '@garden/ui/styles.css';
import '/src/app.css';
import '/src/pets/pets.css';
const primary='11111111-1111-4111-8111-111111111111', chat='22222222-2222-4222-8222-222222222222', ghost='33333333-3333-4333-8333-333333333333', conversation='44444444-4444-4444-8444-444444444444';
const key='ghost-bot-ui-fixture-state';
const initial={mode:'active',revision:0,failed:false,operations:1,cloneLost:false,receipts:{},turns:{}};
const read=()=>{try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(initial));}catch{return initial;}};
const write=value=>{localStorage.setItem(key,JSON.stringify(value));const count=document.getElementById('fixture-count');if(count)count.textContent='기록된 제작 작업 '+value.operations;};
const reply=(data,status='success',error_code=null)=>({status,summary:status==='error'?'현재 판본을 다시 확인해 주세요.':'접수했습니다.',object_refs:[],artifacts:[],next_actions:[],error_code,retry_class:status==='error'?'new_revision':'same_id',data});
const pointer={ghost_id:ghost,revision:1,digest:'a'.repeat(64)};
// mode는 lifetime 계약(guards.ts)이 허용하는 'live'여야 한다. 'enabled' 등 다른 값은
// 스냅샷 파싱이 매번 거절해 fixture 시나리오 전체가 실행되지 않는다.
const snapshot={protocol_version:'ghost-lifetime/1',contract_revision:1,mode:'live',goals:[],work:[],bindings:[],artifacts:[],acceptances:[]};
const registry=[{ghost_id:primary,conversation_id:chat,kind:'primary',mode:'active',roles:['주 Ghost']},{ghost_id:ghost,conversation_id:conversation,kind:'specialist',mode:'active',roles:['제품 비교']}];
const workspace=initialWorkspace();
workspace.workspace_id='55555555-5555-4555-8555-555555555555';workspace.lifetime_authority={authority_epoch:1,dispatch_enabled:true};workspace.reviews=[];workspace.goals=[];workspace.delegations=[];workspace.schedules=[];workspace.spaces=[];
workspace.profiles=[{id:primary,name:'주 Ghost',persona:'작업을 조율합니다.',policy:{},conversations:[]},{id:ghost,name:'비교 담당',persona:'제품을 비교합니다.',policy:{},conversations:[]}];
const client={mode:'live',snapshot:async()=>structuredClone(workspace),async action(outer){
 if(outer.command.type!=='lifetime') return {};
 const e=outer.command.envelope,b=e.body,s=read();let result;
 if(b.method==='command.inspect'){const old=s.receipts[b.command_id];if(old) return reply({command_id:b.command_id,found:true,authority_epoch:1,payload_digest:old.digest,response:old.response});return {status:'warning',summary:'접수 기록을 찾을 수 없습니다.',object_refs:[],artifacts:[],next_actions:[],error_code:'not_found',retry_class:'reconcile_first',data:{command_id:b.command_id,found:false}};}
 if(s.receipts[e.command_id]) return s.receipts[e.command_id].response;
 if(b.method==='snapshot') result=reply(snapshot);
 else if(b.method==='registry.inspect') result=reply({registry});
 else if(b.method==='conversation.inspect') {const turns=s.turns[b.conversation_id]||[];result=reply({ghost_id:b.ghost_id,conversation_id:b.conversation_id,privacy:'private',turns,turn_runs:[],has_older:false,oldest_sequence:turns[0]?.sequence??null});}
 else if(b.method==='bot.surface.inspect') {
 const own=(b.ghost_id===primary&&b.conversation_id===chat)||(b.ghost_id===ghost&&b.conversation_id===conversation);
 // 대상 자신에 대한 표면만 응답한다. 전문 Ghost 정보를 하드코딩하면 primary
 // 로스터 검증이 실패하거나 잘못된 bot이 렌더된다.
 const requested=own?registry.find(row=>row.ghost_id===b.ghost_id&&row.conversation_id===b.conversation_id):null;
 const surface=requested?{ghost_id:b.ghost_id,conversation_id:b.conversation_id,display_name:requested.kind==='primary'?'주 Ghost':'비교 담당',purpose:requested.kind==='primary'?'작업을 조율합니다.':'두 제품을 근거로 비교합니다.',definition_ref:pointer,mode:s.mode,lifecycle_revision:s.revision,lifecycle_expected_revision:s.revision||null}:null;
 result=reply({target:{ghost_id:b.ghost_id,conversation_id:b.conversation_id},truncated:false,bots:own&&!s.failed&&surface?[{...surface,managed:true,admission_allowed:s.mode==='active',required_capabilities:['read'],input_contract:{products:'두 제품'},output_contract:{comparison:'근거가 있는 비교'}}]:[],operations:own&&surface?[{...surface,action:'create',candidate_id:'candidate-one',candidate_digest:'b'.repeat(64),state:s.failed?'failed':'ready',blocker:s.failed?'independent_evaluation_failed':null,source_turn_id:'owner-create',operation_id:'operation-one'}]:[]});
 } else if(b.method==='bot.lifecycle.set') {if(e.expected_revision!==(s.revision||null)) result=reply({host_effect_class:'no_effect'},'error','conflict');else{s.mode=b.mode;registry.forEach(row=>{row.mode=b.mode;});s.revision++;result=reply({mode:s.mode,revision:s.revision});}}
 else if(['bot.update.prepare','bot.clone.prepare'].includes(b.method)){s.operations++;result=reply({candidate_id:'candidate-'+s.operations,operation_id:'operation-'+s.operations,ghost_id:b.method==='bot.clone.prepare'?'new-ghost-'+s.operations:ghost});}
 else if(b.method==='conversation.input'){const turns=s.turns[b.conversation_id]||=[];const id='turn-'+crypto.randomUUID();turns.push({id,sequence:turns.length+1,sender_kind:'owner',sender_ref:'owner',text:b.text,privacy:'private',kind:'user',source_turn_id:null,attachments:[],created_at_ms:Date.now()});result=reply({turn_id:id});}
 else result=reply({host_effect_class:'no_effect'},'error','invalid_request');
 s.receipts[e.command_id]={digest:e.payload_digest,response:result};
 if(b.method==='bot.clone.prepare'&&!s.cloneLost){s.cloneLost=true;write(s);throw new Error('fixture lost ACK');}
 write(s);return result;
}};
const controls=document.getElementById('fixture-controls');
for(const [label,change] of [['평가 실패로 전환',s=>{s.failed=true;}],['준비 완료로 전환',s=>{s.failed=false;}],['Host 판본 변경',s=>{s.revision++;}],['fixture 초기화',()=>{localStorage.clear();location.reload();}]]){const button=document.createElement('button');button.textContent=label;button.onclick=()=>{const state=read();change(state);write(state);};controls.append(button);}
write(read());
createRoot(document.getElementById('root')).render(React.createElement(App,{connectClient:async()=>client}));
`;
const server = await createServer({ root, define: { 'import.meta.env.VITE_GHOST_LIFETIME': JSON.stringify('true') }, server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'isolated-bot-ui-fixture',
  resolveId(id) { if (id === '/__bot_fixture_entry.js') return '\0bot-fixture.js'; },
  load(id) { if (id === '\0bot-fixture.js') return entry; },
  configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url?.split('?')[0] !== '/__bot_fixture') return next();
    void server.transformIndexHtml('/__bot_fixture', '<!doctype html><html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Ghost bot UI fixture</title></head><body><div id="fixture-controls" style="position:fixed;right:8px;bottom:8px;z-index:100;font:11px system-ui;opacity:.6">격리된 UI fixture · <span id="fixture-count"></span></div><div id="root"></div><script type="module" src="/__bot_fixture_entry.js"></script></body></html>').then(html => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  }); },
}] });
await server.listen();
console.log(`Isolated bot UI fixture: http://127.0.0.1:${server.httpServer.address().port}/__bot_fixture`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });

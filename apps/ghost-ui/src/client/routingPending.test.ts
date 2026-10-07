import {describe,expect,it} from 'vitest';
import {HostRoutingTransport,createHostRoutingAdapter} from './hostRouting';
import {CommandQueue} from './api';
import {RoutingClient} from './routingClient';
import {RoutingPending,RoutingTerminal} from './errors';
import {fixtureView,firstText,entry} from '../../verification/fixture';
import type {Client,Envelope,Snapshot} from './types';
const flags={schema:'ghost-routing-host/1',admission:true,clarification_resolution:true,runtime_dispatch:false,effect_fence:false,verified_completion_report:false,model_router:true,model_tool_registration:true,entry_view:true};
const store=()=>{const values=new Map<string,string>();return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};};
const journal=(storage:ReturnType<typeof store>)=>JSON.parse(storage.getItem('pending')!) as Record<string,Envelope>;
const snapshotWith=(taskId:string,phase:()=>string,messages:Snapshot['profiles'][number]['conversations'][number]['messages']=[]) =>
 async()=>({profiles:[{id:entry.entry_profile_id,conversations:[{id:entry.conversation_id,messages,tasks:[{id:taskId,phase:phase()}]}]}]} as unknown as Snapshot);

// Scripted host: canonical receipt only while visible(), an exact ACK for the
// natural submission, and capture of the normal owner cancel command.
function pendingHost(controls:{visible:()=>boolean;snapshot:()=>Promise<Snapshot>;onCancel?:(e:Envelope)=>Promise<unknown>}) {
 const calls:Envelope[]=[];let requestId:string|null=null;
 const host=new HostRoutingTransport(async e=>{
  calls.push(e);const a=(e.command.action ?? {}) as Record<string,unknown>;
  if(a.type==='routing_capability')return flags;
  if(a.type==='routing_receipt'){
   if(!controls.visible()||!requestId||a.message_id!==requestId)return null;
   const view=structuredClone(fixtureView(1).admissions[0]);
   view.admission.input.text=clarifiedTurn.text;
   view.admission.input.origin.message_id=requestId;
   view.admission.input.resolves=[{...ref,answer_segment_id:'answer'}];
   return view;
  }
  if(a.type==='routing_natural'){requestId=e.request_id;return {routing_pending:true,submission:{request_id:e.request_id,conversation_id:entry.conversation_id,task_id:'router-task'}};}
  if(e.command.type==='cancel'&&controls.onCancel)return controls.onCancel(e);
  throw Error('unexpected '+a.type);
 },controls.snapshot);
 return {host,calls,natural:()=>calls.filter(c=>(c.command.action as Record<string,unknown>).type==='routing_natural'),cancels:()=>calls.filter(c=>c.command.type==='cancel')};
}
const prepared=(host:HostRoutingTransport)=>createHostRoutingAdapter(host,{canPrepareInput:true,prepare:(turn,id)=>host.prepare(turn,id,{timeoutMs:3,pollMs:1})});

const source=fixtureView(3).admissions[2].admission;
const ref={source_admission_id:source.id,source_segment_id:'s1',expected_input_hash:source.input_hash};
const target=(source.items[0].operation as {candidates:{work_id:string;expected_work_revision:number;expected_decision_revision:number}[]}).candidates[0];
const clarifiedTurn={entry,text:'블로그 초안 쪽이에요.',kind:'follow_up' as const,resolves:[ref],clarification_target:target};

describe('routing pending contract',()=>{
 it('keeps the ACK as pending identity across reload and admits only by pure requery',async()=>{
  let visible=false;
  const {host,calls,natural}=pendingHost({visible:()=>visible,snapshot:snapshotWith('router-task',()=>'model_running')});
  const storage=store(),client=new RoutingClient(prepared(host),new CommandQueue(storage,'pending'));
  const error=await client.submit(clarifiedTurn).catch((e:unknown)=>e);
  expect(error).toBeInstanceOf(RoutingPending);
  const pendingError=error as RoutingPending;
  expect(pendingError.state).toBe('pending');expect(pendingError.task_id).toBe('router-task');
  const saved=Object.values(journal(storage))[0] as Envelope;
  expect(pendingError.request_id).toBe(saved.request_id);
  expect(saved.command.turn).toEqual(clarifiedTurn);
  expect(saved.routing_pending).toEqual({state:'pending',task_id:'router-task'});
  expect('routing_pending' in saved.command).toBe(false);
  // Reload: a fresh queue and client list the same request without dispatching anything.
  const reloaded=new RoutingClient(prepared(host),new CommandQueue(storage,'pending'));
  const listed=await reloaded.pending(entry);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({request_id:saved.request_id,task_id:'router-task',state:'pending'});
  expect(listed[0].turn).toEqual(clarifiedTurn);
  expect(natural()).toHaveLength(1);
  // The real model admits at ~50s, far past the 25s bound: a pure poll finds the
  // canonical admission without a second natural submission or any routing_admit.
  visible=true;
  const observation=await reloaded.pollPending(listed[0]);
  expect(observation.state).toBe('admitted');
  expect(observation.admission!.admission.input.origin.message_id).toBe(saved.request_id);
  expect(journal(storage)).toEqual({});
  expect(natural()).toHaveLength(1);
  expect(calls.some(c=>(c.command.action as Record<string,unknown>).type==='routing_admit')).toBe(false);
  expect(natural()[0].command.action).toMatchObject({type:'routing_natural',kind:'follow_up',resolves:[{...ref,answer_segment_id:'answer'}],clarification_target:target});
 });
 it('lists a lost natural reply as unknown and recovers the exact UUID',async()=>{
  let admitted:ReturnType<typeof fixtureView>['admissions'][number]|null=null,drop=true;
  const calls:Envelope[]=[];
  const host=new HostRoutingTransport(async e=>{calls.push(e);const a=e.command.action as Record<string,unknown>;
   if(a.type==='routing_capability')return flags;
   if(a.type==='routing_receipt')return admitted;
   if(a.type==='routing_natural'){admitted=structuredClone(fixtureView(1).admissions[0]);admitted.admission.input.origin.message_id=e.request_id;
    if(drop){drop=false;throw Error('lost natural reply');}
    return {routing_pending:true,submission:{request_id:e.request_id,conversation_id:entry.conversation_id,task_id:'router-task'}};}
   throw Error('unexpected');});
  const adapter=createHostRoutingAdapter(host,{canPrepareInput:true,prepare:(turn,id)=>host.prepare(turn,id,{timeoutMs:3,pollMs:1})}),storage=store();
  await expect(new RoutingClient(adapter,new CommandQueue(storage,'pending')).submit({entry,text:firstText,kind:'prompt' as const,resolves:[]})).rejects.toMatchObject({name:'RoutingPending',state:'unknown',entry});
  const listed=await new RoutingClient(adapter,new CommandQueue(storage,'pending')).pending(entry);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({state:'unknown',task_id:null});
  expect(listed[0].turn).toEqual({entry,text:firstText,kind:'prompt',resolves:[]});
  const restored=await new RoutingClient(adapter,new CommandQueue(storage,'pending')).submit({...listed[0].turn,kind:'follow_up' as const});
  expect(restored.admission.input.origin.message_id).toBe(listed[0].request_id);
  expect(journal(storage)).toEqual({});
  expect(calls.filter(c=>(c.command.action as Record<string,unknown>).type==='routing_natural')).toHaveLength(1);
 });
 it('cancels with a stable persisted UUID and closes only on the actual SDK terminal',async()=>{
  let phase='model_running';let cancelFails=true;const cancelIds:string[]=[];
  const {host}=pendingHost({visible:()=>false,snapshot:snapshotWith('router-task',()=>phase),
   onCancel:async e=>{cancelIds.push(e.request_id);if(cancelFails){cancelFails=false;throw Error('cancel reply lost');}return {};}});
  const storage=store(),client=new RoutingClient(prepared(host),new CommandQueue(storage,'pending'));
  await client.submit(clarifiedTurn).catch(()=>{});
  const first=(await client.pending(entry))[0];
  await expect(client.cancelPending(first)).rejects.toThrow('cancel reply lost');
  // The intent and its cancellation UUID persisted through the lost reply.
  const requested=(await client.pending(entry))[0];
  expect(requested.state).toBe('cancel_requested');
  expect(cancelIds).toEqual([requested.cancel_request_id!]);
  // A stale caller object without the reserved UUID must reuse it, never overwrite.
  const again=await client.cancelPending(first);
  expect(again.state).toBe('cancel_requested');
  expect(cancelIds).toEqual([requested.cancel_request_id!,requested.cancel_request_id!]);
  expect((await client.pending(entry))[0].cancel_request_id).toBe(requested.cancel_request_id);
  expect(Object.keys(journal(storage))).toHaveLength(1);
  // Still running: not prematurely closed; neither the current nor a stale
  // terminal-looking object may dismiss it.
  const current=(await client.pending(entry))[0];
  expect((await client.pollPending(current)).state).toBe('cancel_requested');
  await expect(client.dismissPending(current)).rejects.toThrow('지울 수 없습니다');
  await expect(client.dismissPending({...current,state:'cancelled' as const})).rejects.toThrow('지울 수 없습니다');
  expect(Object.keys(journal(storage))).toHaveLength(1);
  // Actual SDK terminal cancelled, with a final receipt recheck; persists until dismissal.
  phase='cancelled';
  const observation=await client.pollPending((await client.pending(entry))[0]);
  expect(observation.state).toBe('cancelled');
  expect((await client.pending(entry))[0].state).toBe('cancelled');
  await client.dismissPending((await client.pending(entry))[0]);
  expect(journal(storage)).toEqual({});
 });
 it('chooses the actual admission over a cancel request or a terminal snapshot',async()=>{
  let visible=false,phase='model_running';
  const {host,cancels}=pendingHost({visible:()=>visible,snapshot:snapshotWith('router-task',()=>phase),onCancel:async()=>({})});
  const storage=store(),client=new RoutingClient(prepared(host),new CommandQueue(storage,'pending'));
  await client.submit(clarifiedTurn).catch(()=>{});
  const first=(await client.pending(entry))[0];
  expect((await client.cancelPending(first)).state).toBe('cancel_requested');
  expect(cancels()).toHaveLength(1);
  // The admission commits while the cancel is pending and the SDK task ends: the receipt wins.
  visible=true;phase='cancelled';
  const observation=await client.pollPending((await client.pending(entry))[0]);
  expect(observation.state).toBe('admitted');
  expect(journal(storage)).toEqual({});
  // Cancelling an already admitted request reports the admission and never claims undo.
  const stale=await client.cancelPending({...first,cancel_request_id:crypto.randomUUID()});
  expect(stale.state).toBe('admitted');
  expect(cancels()).toHaveLength(1);
 });
 it('retains a terminal journal record when the SDK task ends while prepare is still awaiting',async()=>{
  let phase='model_running';
  // The very first prepare poll observes the cancellation of the exact SDK task.
  const {host}=pendingHost({visible:()=>false,snapshot:async()=>{phase='cancelled';return snapshotWith('router-task',()=>phase)();}});
  const storage=store(),client=new RoutingClient(prepared(host),new CommandQueue(storage,'pending'));
  const error=await client.submit(clarifiedTurn).catch((e:unknown)=>e);
  expect(error).toBeInstanceOf(RoutingTerminal);
  const terminal=error as RoutingTerminal;
  expect(terminal.state).toBe('cancelled');expect(terminal.task_id).toBe('router-task');
  const saved=Object.values(journal(storage))[0] as Envelope;
  expect(terminal.request_id).toBe(saved.request_id);
  expect(saved.routing_pending).toEqual({state:'cancelled',task_id:'router-task'});
  expect(Object.keys(journal(storage))).toHaveLength(1);
  // The retained record re-polls as the same terminal outcome and clears only on dismissal.
  const reloaded=new RoutingClient(prepared(host),new CommandQueue(storage,'pending'));
  expect((await reloaded.pollPending((await reloaded.pending(entry))[0])).state).toBe('cancelled');
  await reloaded.dismissPending((await reloaded.pending(entry))[0]);
  expect(journal(storage)).toEqual({});
 });
 it('keeps a confirmed terminal failure distinct from pending until dismissed',async()=>{
  let phase='model_running';
  const {host}=pendingHost({visible:()=>false,snapshot:snapshotWith('router-task',()=>phase)});
  const storage=store(),client=new RoutingClient(prepared(host),new CommandQueue(storage,'pending'));
  await client.submit(clarifiedTurn).catch(()=>{});
  const request=(await client.pending(entry))[0];
  expect((await client.pollPending(request)).state).toBe('pending');
  phase='failed';
  const observation=await client.pollPending(request);
  expect(observation.state).toBe('failed');
  expect(observation.message).toContain('실패');
  // A failed outcome persists as its own confirmed state and never becomes a new submission.
  expect((await client.pending(entry))[0].state).toBe('failed');
  expect(Object.keys(journal(storage))).toHaveLength(1);
  await client.dismissPending((await client.pending(entry))[0]);
  expect(journal(storage)).toEqual({});
 });
 it('preserves unrelated pending commands across pending patches and clears',async()=>{
  let visible=false;
  const otherCommand={type:'workspace',action:{type:'submit',profile_id:'p1',conversation_id:'c1',prompt:'안녕'}};
  const storage=store();
  storage.setItem('pending',JSON.stringify({[JSON.stringify(otherCommand)]:{request_id:'other-uuid',command:otherCommand}}));
  const {host}=pendingHost({visible:()=>visible,snapshot:snapshotWith('router-task',()=>'model_running')});
  const client=new RoutingClient(prepared(host),new CommandQueue(storage,'pending'));
  await client.submit(clarifiedTurn).catch(()=>{});
  expect(Object.keys(journal(storage))).toHaveLength(2);
  expect(journal(storage)[JSON.stringify(otherCommand)].request_id).toBe('other-uuid');
  visible=true;
  await client.pollPending((await client.pending(entry))[0]);
  const remaining=journal(storage);
  expect(Object.keys(remaining)).toEqual([JSON.stringify(otherCommand)]);
  expect(remaining[JSON.stringify(otherCommand)].request_id).toBe('other-uuid');
 });
 it('matches a legacy pending turn by request id only and never guesses an ambiguous task',async()=>{
  const id=crypto.randomUUID();
  const command={type:'routing_turn',turn:{entry,text:firstText,kind:'prompt' as const,resolves:[]}};
  const storage=store();
  storage.setItem('pending',JSON.stringify({[JSON.stringify(command)]:{request_id:id,command}}));
  let messages:Snapshot['profiles'][number]['conversations'][number]['messages']=[
   {role:'user',text:'화면에는 전혀 다른 문장이 보입니다',request_id:id,task_id:'legacy-task'},
   {role:'assistant',text:'응답',request_id:id,task_id:'other-task'},
  ];
  const snapshot=async()=>({profiles:[{id:entry.entry_profile_id,conversations:[{id:entry.conversation_id,messages,tasks:[{id:'legacy-task',phase:'model_running'},{id:'other-task',phase:'model_running'}]}]}]} as unknown as Snapshot);
  const cancelIds:string[]=[];
  const {host}=pendingHost({visible:()=>false,snapshot,onCancel:async e=>{cancelIds.push(e.request_id);return {};}});
  const client=new RoutingClient(prepared(host),new CommandQueue(storage,'pending'));
  const request=(await client.pending(entry))[0];
  expect(request).toMatchObject({request_id:id,state:'unknown',task_id:null});
  expect(request.turn).toEqual({entry,text:firstText,kind:'prompt',resolves:[]});
  // Two different task ids for one UUID are ambiguous: the reply asks for
  // requery, no cancel is sent, and the requested intent stays recorded.
  const refused=await client.cancelPending(request);
  expect(refused.state).toBe('unknown');expect(refused.message).toContain('특정');
  expect(cancelIds).toEqual([]);
  const recorded=(await client.pending(entry))[0];
  expect(recorded.state).toBe('cancel_requested');expect(recorded.cancel_request_id).toBeTruthy();
  // A unique message match identifies the SDK task without any text comparison
  // and persists it on the journal record, making the request cancellable.
  messages=messages.slice(0,1);
  const observed=await client.pollPending(request);
  expect(observed).toMatchObject({state:'cancel_requested',task_id:'legacy-task'});
  expect((await client.pending(entry))[0].task_id).toBe('legacy-task');
  const cancelRequested=await client.cancelPending((await client.pending(entry))[0]);
  expect(cancelRequested.state).toBe('cancel_requested');
  expect(cancelRequested.task_id).toBe('legacy-task');
  expect(cancelIds).toHaveLength(1);
  expect(cancelIds[0]).toBe(recorded.cancel_request_id);
 });
 it('serializes journal updates with an in-flight dispatch and preserves unrelated envelopes',async()=>{
  const storage=store();
  const routingCommand={type:'routing_turn',turn:{entry,text:firstText,kind:'prompt' as const,resolves:[]}};
  const otherCommand={type:'workspace',action:{type:'submit',profile_id:'p',conversation_id:'c',prompt:'x'}};
  const writes:string[]=[];
  const tracked={getItem:(k:string)=>storage.getItem(k),setItem:(k:string,v:string)=>{writes.push(v);storage.setItem(k,v);}};
  storage.setItem('pending',JSON.stringify({
   [JSON.stringify(routingCommand)]:{request_id:'routing-uuid',command:routingCommand},
   [JSON.stringify(otherCommand)]:{request_id:'other-uuid',command:otherCommand},
  }));
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const client={mode:'live',snapshot:async()=>{throw Error('unused');},action:async()=>{await gate;return {};}} as unknown as Client;
  const queue=new CommandQueue(tracked,'pending');
  const sending=queue.send(client,otherCommand);
  const patching=queue.patchPendingRouting('routing-uuid',{state:'pending',task_id:'t1'});
  await new Promise(resolve=>setTimeout(resolve,0));
  // The patch waits for the in-flight dispatch instead of interleaving a write.
  expect(writes).toHaveLength(1);
  release();await sending;await patching;
  const final=JSON.parse(storage.getItem('pending')!) as Record<string,Envelope>;
  expect(Object.keys(final)).toEqual([JSON.stringify(routingCommand)]);
  expect(final[JSON.stringify(routingCommand)].routing_pending).toEqual({state:'pending',task_id:'t1'});
  // The last journal write already contains both effects: nothing was clobbered.
  expect(JSON.parse(writes[writes.length-1]!)).toEqual(final);
 });
});

import {expect,it} from 'vitest';
import {HostRoutingTransport,createHostRoutingAdapter} from './hostRouting';
import {CommandQueue} from './api';
import {RoutingClient} from './routingClient';
import {RoutingPending} from './errors';
import {fixtureView,firstText,entry} from '../../verification/fixture';
import type {Envelope,Snapshot} from './types';
const flags={schema:'ghost-routing-host/1',admission:true,clarification_resolution:true,runtime_dispatch:false,effect_fence:false,verified_completion_report:false,model_router:true,model_tool_registration:true,entry_view:true};
const store=()=>{const values=new Map<string,string>();return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};};
it('submits exact natural input once and recovers canonical admission without a routing_admit command',async()=>{
 const calls:Envelope[]=[];let admitted:ReturnType<typeof fixtureView>['admissions'][number]|null=null,drop=true;
 const host=new HostRoutingTransport(async e=>{calls.push(e);const a=e.command.action as Record<string,unknown>;
  if(a.type==='routing_capability')return flags;
  if(a.type==='routing_receipt')return admitted;
  if(a.type==='routing_natural'){
   admitted=structuredClone(fixtureView(1).admissions[0]);admitted.admission.input.origin.message_id=e.request_id;
   if(drop){drop=false;throw Error('lost natural reply after canonical admission');}
   return {routing_pending:true,submission:{request_id:e.request_id,conversation_id:entry.conversation_id,task_id:'router-task'}};
  }throw Error('unexpected '+a.type);
 });
 const adapter=createHostRoutingAdapter(host,{canPrepareInput:true,prepare:(turn,id)=>host.prepare(turn,id)}),storage=store(),turn={entry,text:firstText,kind:'prompt' as const,resolves:[]};
 await expect(new RoutingClient(adapter,new CommandQueue(storage,'pending')).submit(turn)).rejects.toMatchObject({name:'RoutingPending',state:'unknown'});
 const pending=JSON.parse(storage.getItem('pending')!),saved=Object.values(pending)[0] as Envelope;
 const restored=await new RoutingClient(adapter,new CommandQueue(storage,'pending')).submit({...turn,kind:'follow_up'});
 expect(restored.admission.input.origin.message_id).toBe(saved.request_id);expect(storage.getItem('pending')).toBe('{}');
 const commands=calls.filter(c=>(c.command.action as Record<string,unknown>).type==='routing_natural');expect(commands).toHaveLength(1);
 expect(commands[0].command.action).toEqual({type:'routing_natural',entry:{profile_id:entry.entry_profile_id,conversation_id:entry.conversation_id},text:firstText,kind:'prompt',resolves:[],clarification_target:null});
 expect(calls.some(c=>(c.command.action as Record<string,unknown>).type==='routing_admit')).toBe(false);
});
it('does not turn SDK submission acceptance into admission and keeps timeout identity pending',async()=>{
 const calls:Envelope[]=[];const host=new HostRoutingTransport(async e=>{calls.push(e);const a=e.command.action as Record<string,unknown>;if(a.type==='routing_capability')return flags;if(a.type==='routing_receipt')return null;if(a.type==='routing_natural')return {routing_pending:true,submission:{request_id:e.request_id,conversation_id:entry.conversation_id,task_id:'router-task'}};throw Error('unexpected');});
 const storage=store(),adapter=createHostRoutingAdapter(host,{canPrepareInput:true,prepare:(turn,id)=>host.prepare(turn,id,{timeoutMs:3,pollMs:1})});
 const error=await new RoutingClient(adapter,new CommandQueue(storage,'pending')).submit({entry,text:firstText,resolves:[]}).catch((e:unknown)=>e);
 expect(error).toBeInstanceOf(RoutingPending);
 const pending=error as RoutingPending;
 expect(pending.state).toBe('pending');expect(pending.task_id).toBe('router-task');
 const saved=Object.values(JSON.parse(storage.getItem('pending')!))[0] as Envelope;
 expect(pending.request_id).toBe(saved.request_id);
 expect(saved.routing_pending).toEqual({state:'pending',task_id:'router-task'});
 expect('routing_pending' in saved.command).toBe(false);
 expect(Object.keys(JSON.parse(storage.getItem('pending')!))).toHaveLength(1);
 expect(calls.some(c=>(c.command.action as Record<string,unknown>).type==='routing_admit')).toBe(false);
});
it('preserves the held clarification reference and selected target on the natural wire',async()=>{
 const source=fixtureView(3).admissions[2].admission,target=(source.items[0].operation as {candidates:any[]}).candidates[0],ref={source_admission_id:source.id,source_segment_id:'s1',expected_input_hash:source.input_hash};let natural:Envelope|undefined;
 const receipt=structuredClone(fixtureView(1).admissions[0]);const id=crypto.randomUUID(),text='블로그 초안 쪽이에요.';receipt.admission.input={...receipt.admission.input,text,origin:{...receipt.admission.input.origin,message_id:id},resolves:[{...ref,answer_segment_id:'answer'}]};
 const host=new HostRoutingTransport(async e=>{const a=e.command.action as Record<string,unknown>;if(a.type==='routing_capability')return flags;if(a.type==='routing_receipt')return receipt;if(a.type==='routing_natural'){natural=e;return {routing_pending:true,submission:{request_id:id,conversation_id:entry.conversation_id,task_id:'router-task'}};}throw Error('unexpected');});
 await host.prepare({entry,text,kind:'follow_up',resolves:[ref],clarification_target:target},id);
 expect(natural?.request_id).toBe(id);expect(natural?.command.action).toMatchObject({type:'routing_natural',kind:'follow_up',text,resolves:[{...ref,answer_segment_id:'answer'}],clarification_target:target});
});
it('requires the actual model flags and checks terminal SDK failure before admitting anything',async()=>{
 let naturalCalls=0;
 const host=new HostRoutingTransport(async()=>({...flags,model_router:false}));await expect(host.prepare({entry,text:firstText,resolves:[]},'id')).rejects.toThrow('준비되지');
 const failed=new HostRoutingTransport(async e=>{const a=e.command.action as Record<string,unknown>;if(a.type==='routing_capability')return flags;if(a.type==='routing_receipt')return null;if(a.type==='routing_natural'){naturalCalls++;return {routing_pending:true,submission:{request_id:e.request_id,conversation_id:entry.conversation_id,task_id:'router-task'}};}throw Error('unexpected');},async()=>({profiles:[{id:entry.entry_profile_id,conversations:[{id:entry.conversation_id,tasks:[{id:'router-task',phase:'failed'}]}]}]} as Snapshot));
 await expect(failed.prepare({entry,text:firstText,resolves:[]},'id')).rejects.toThrow('끝났지만');expect(naturalCalls).toBe(1);
});

it('keeps the original wire kind and UUID when snapshot history changes before admission is available',async()=>{
 const storage=store(),calls:Envelope[]=[];let admission:any=null,attempt=0;
 const host=new HostRoutingTransport(async e=>{const a=e.command.action as Record<string,unknown>;
  if(a.type==='routing_capability')return flags;if(a.type==='routing_receipt')return admission;
  if(a.type==='routing_natural'){calls.push(e);if(++attempt===1)throw Error('reply lost before receipt');
   admission=structuredClone(fixtureView(1).admissions[0]);admission.admission.input.origin.message_id=e.request_id;
   return {routing_pending:true,submission:{request_id:e.request_id,conversation_id:entry.conversation_id,task_id:'task'}};
  }throw Error('unexpected');
 });
 const adapter=createHostRoutingAdapter(host,{canPrepareInput:true,prepare:(turn,id)=>host.prepare(turn,id)});
 await expect(new RoutingClient(adapter,new CommandQueue(storage,'pending')).submit({entry,text:firstText,kind:'prompt',resolves:[]})).rejects.toMatchObject({name:'RoutingPending',state:'unknown'});
 await new RoutingClient(adapter,new CommandQueue(storage,'pending')).submit({entry,text:firstText,kind:'follow_up',resolves:[]});
 expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(storage.getItem('pending')).toBe('{}');
});
it('recovers a legacy pending turn with its original UUID',async()=>{
 const storage=store(),original={type:'routing_turn',turn:{entry,text:firstText,kind:'prompt',resolves:[]}},id=crypto.randomUUID();
 const receipt=structuredClone(fixtureView(1).admissions[0]);receipt.admission.input.origin.message_id=id;
 storage.setItem('pending',JSON.stringify({[JSON.stringify(original)]:{request_id:id,command:original}}));
 const host=new HostRoutingTransport(async e=>{const a=e.command.action as Record<string,unknown>;if(a.type==='routing_capability')return flags;if(a.type==='routing_receipt')return a.message_id===id?receipt:null;throw Error('recovery must not dispatch');});
 const adapter=createHostRoutingAdapter(host,{canPrepareInput:true,prepare:(turn,id)=>host.prepare(turn,id)});
 const result=await new RoutingClient(adapter,new CommandQueue(storage,'pending')).submit({entry,text:firstText,kind:'follow_up',resolves:[]});
 expect(result.admission.input.origin.message_id).toBe(id);expect(storage.getItem('pending')).toBe('{}');
});

import { expect, it } from 'vitest';
import { HostRoutingTransport } from './hostRouting';
import { normalizeRoutingFailure } from './routingClient';
import { CommandQueue } from './api';
import type { Client, Envelope } from './types';

it('keeps actual capability fields and refuses an unknown Host schema', async () => {
 const flags = {schema:'ghost-routing-host/1',admission:true,clarification_resolution:true,runtime_dispatch:false,effect_fence:false,verified_completion_report:false,model_router:false,model_tool_registration:false};
 expect(await new HostRoutingTransport(async()=>flags).capability()).toEqual(flags);
 await expect(new HostRoutingTransport(async()=>({...flags,schema:'other/2'})).capability()).rejects.toThrow('작업 접수 형식');
 expect(normalizeRoutingFailure({error_code:'authority_changed',error:'unrelated text'})).toMatchObject({code:'authority_changed'});
 expect(normalizeRoutingFailure({error:'authority_changed'})).toBeNull();
});
it('uses the fixed control entry and server candidate bound', async () => {
 let envelope: Envelope | undefined;
 const host = new HostRoutingTransport(async e=>{envelope=e;return [];});
 await host.candidates({entry_profile_id:'profile',conversation_id:'conversation'});
 expect(envelope?.command).toEqual({type:'routing',action:{type:'routing_candidates',entry:{profile_id:'profile',conversation_id:'conversation'},query:'',limit:50}});
});
it('deduplicates concurrent identical intents and serializes pending writes', async () => {
 const values=new Map<string,string>(), ids:string[]=[];
 let finish: (()=>void) | undefined;
 const blocked=new Promise<void>(resolve=>{finish=resolve;});
 const client={action:async(e:Envelope)=>{ids.push(e.request_id);await blocked;return e.request_id;}} as Client;
 const queue=new CommandQueue({getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v);}},'pending');
 const a=queue.send(client,{type:'submit',prompt:'first'}),duplicate=queue.send(client,{type:'submit',prompt:'first'}),b=queue.send(client,{type:'submit',prompt:'second'});
 await new Promise(resolve=>setTimeout(resolve,0));expect(ids).toHaveLength(1);
 finish!();const results=await Promise.all([a,duplicate,b]);expect(results[0]).toBe(results[1]);expect(ids).toHaveLength(2);expect(results[2]).not.toBe(results[0]);expect(values.get('pending')).toBe('{}');
});

it('gates server projection and rejects a cyclic receipt cursor without a local cache', async () => {
 const flags={schema:'ghost-routing-host/1',admission:true,clarification_resolution:true,runtime_dispatch:false,effect_fence:false,verified_completion_report:false,entry_view:true};
 const sent: Envelope[]=[];
 const host=new HostRoutingTransport(async e=>{sent.push(e);return (e.command.action as {type?:string})?.type==='routing_capability'?flags:{schema:'ghost-routing-view/1',works:[],decisions:[],admissions:[],next_before_admission_id:'same-cursor'};});
 await expect(host.view({entry_profile_id:'profile',conversation_id:'conversation'})).rejects.toThrow('페이지');
 expect(sent).toHaveLength(3);
 const legacySent: Envelope[]=[];
 await expect(new HostRoutingTransport(async e=>{legacySent.push(e);return {...flags,entry_view:false};}).view({entry_profile_id:'p',conversation_id:'c'})).rejects.toThrow('제공하지');
 expect(legacySent).toHaveLength(1);
});

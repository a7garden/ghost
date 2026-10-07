import {expect,it} from 'vitest';
import {canRefreshPlanner,normalizeConnectedPlanner,normalizePlannerItems,normalizePlannerStatus,plannerOperationLabel} from './connectedPlanner';
const plain={kind:'VTODO',title:'납부 자료',notes:'',due:'2026-10-05',completed:false,start_ms:null,end_ms:null};
const status={collection_id:'tasks',binding:'approved-binding',connection_state:'anonymous_configured',collection_enabled:true,running:false,last_attempt_ms:100,last_success_ms:90,last_error:null,queued:1,uncertain:0,conflict:0,blocked:0,operations:[]};
it('keeps due-only remote tasks distinct and rejects a foreign collection',()=>{
 const item={origin:'connected',collection_id:'tasks',uid:'uid',version:1,remote:plain,view:plain,read_only:true,diagnostic:['unsupported recurrence'],sync_state:'synced',remote_applied:true,pending_operation:null};
 const result=normalizePlannerItems({collection_id:'tasks',query_only:true,items:[item]},'tasks');
 expect(result[0].view).toMatchObject({kind:'VTODO',due:'2026-10-05',start_ms:null,end_ms:null});expect(result[0].read_only).toBe(true);
 expect(()=>normalizePlannerItems({collection_id:'other',query_only:true,items:[item]},'tasks')).toThrow('컬렉션');
});
it('uses only live synced plus remote_applied for remote save confirmation',()=>{
 expect(plannerOperationLabel({phase:'queued',remote_applied:false})).toBe('동기화 대기');
 for(const phase of ['uncertain','in_flight','conflict','blocked','unknown'])expect(plannerOperationLabel({phase,remote_applied:true})).not.toBe('원격 저장 확인');
 expect(plannerOperationLabel({phase:'synced',remote_applied:false})).toBe('원격 결과 확인 필요');
 expect(plannerOperationLabel({phase:'synced',remote_applied:true})).toBe('원격 저장 확인');
});
it('does not infer a sync endpoint from legacy transport presence or credentials',()=>{
 const collection={id:'tasks',binding:'approved-binding',kind:'VTODO',enabled:true,generation:1};
 const legacy=normalizeConnectedPlanner({transport_available:true,collections:[collection],operations:[]})!;
 const current=normalizeConnectedPlanner({...legacy,sync_status:[status]})!;const live=normalizePlannerStatus(status);
 expect(canRefreshPlanner(legacy,current.collections[0],live)).toBe(false);expect(canRefreshPlanner(current,current.collections[0],live)).toBe(true);
 for(const connection_state of ['credential_required','unconnected','anonymous_ready','unknown'])expect(canRefreshPlanner(current,current.collections[0],{...live,connection_state})).toBe(false);
 expect(canRefreshPlanner(current,current.collections[0],{...live,running:true})).toBe(false);
});
it('keeps a failed refresh and its earlier successful time separate, sanitizing diagnostics',()=>{
 const live=normalizePlannerStatus({...status,last_attempt_ms:200,last_success_ms:90,last_error:'fixed network diagnostic'});
 expect(live).toMatchObject({last_attempt_ms:200,last_success_ms:90,last_error:true});
 expect(JSON.stringify(live)).not.toContain('fixed network diagnostic');
});
it('preserves calendar instants before the Unix epoch without making due-only tasks events',()=>{
 const beforeEpoch={...plain,kind:'VEVENT',due:null,start_ms:-3600000,end_ms:0};
 const item={origin:'connected',collection_id:'tasks',uid:'historic',version:1,remote:beforeEpoch,view:beforeEpoch,read_only:true,diagnostic:[],sync_state:'synced',remote_applied:true,pending_operation:null};
 expect(normalizePlannerItems({collection_id:'tasks',query_only:true,items:[item]},'tasks')[0].view).toMatchObject({start_ms:-3600000,end_ms:0});
});
it('retries a confirmed failed read-only sync with a new identity while preserving unknown outcomes',async()=>{
 const {CommandQueue,ConfirmedFailure}=await import('./api');const values=new Map<string,string>(),ids:string[]=[];
 const queue=new CommandQueue({getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v);}},'planner-sync');
 let confirmed=true;const client={mode:'live',snapshot:async()=>{throw Error('unused');},action:async(e:import('./types').Envelope)=>{ids.push(e.request_id);throw confirmed?new ConfirmedFailure('confirmed sync error'):new Error('lost reply');}} as import('./types').Client;
 const command={type:'workspace',action:{type:'planner_sync_once',collection_id:'tasks',write:false}};
 await expect(queue.send(client,command)).rejects.toThrow('confirmed');expect(values.get('planner-sync')).toBe('{}');
 confirmed=false;await expect(queue.send(client,command)).rejects.toThrow('lost reply');await expect(queue.send(client,command)).rejects.toThrow('lost reply');
 expect(ids[0]).not.toBe(ids[1]);expect(ids[1]).toBe(ids[2]);
});

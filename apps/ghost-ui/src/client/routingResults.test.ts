import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RoutingResultContent} from '../features/RoutingResults';
import {normalizeRoutingCapability} from './routingNormalize';
import {expect,it} from 'vitest';
import {normalizeRoutingResult,normalizeRoutingResults,normalizeRoutingShares,resultMatchesWork,routingResultLabel,bindingMatchesWork,routingBindingLabel} from './routingResults';
import {normalizeSnapshot} from './normalize';
import {fixtureSnapshot,fixtureView,capability} from '../../verification/fixture';
import type {RoutingExecutionResult} from './routingResults';
const work=fixtureView(1).works[0];
const result:RoutingExecutionResult={schema:1,id:'intent',work_id:work.id,work_revision:work.work_revision,decision_revision:work.decision_revision,intent_id:'intent',profile_id:work.responsible_profile_id,conversation_id:'stable-work-conversation',task_id:'actual-task',status:'finished_verified',current:true,verified:true,summary:'fixture verified record',model_output:'요청한 기록을 저장했습니다.',receipts:[{effect_key:'effect',task_id:'actual-task',tool:'save_todo',phase:'complete',verified:true}],artifacts:[],source_admission_id:'turn-1',source_fragments:[{segment_id:'s1',start_byte:0,end_byte:3,text:'원본'}],updated_ms:100};
it('requires matching current Work revisions and verified-report capability for promotion',()=>{
 expect(resultMatchesWork(result,work)).toBe(true);expect(resultMatchesWork(result,{...work,decision_revision:2})).toBe(false);expect(resultMatchesWork({...result,current:false},work)).toBe(false);
 expect(routingResultLabel(result,capability)).toBe('결과 확인 필요');expect(routingResultLabel(result,{...capability,verified_completion_report:true})).toBe('저장 근거 확인됨');
 for(const status of ['finished_unverified','uncertain','failed','blocked','cancelled','running','unknown'])expect(routingResultLabel({...result,status},{...capability,verified_completion_report:true})).not.toBe('저장 근거 확인됨');
 expect(routingResultLabel({...result,current:false},{...capability,verified_completion_report:true})).toBe('이전 요청의 결과');
});
it('keeps persistent completion results after the entry closes without retaining tool output internals',()=>{
 const input={...result,receipts:[{...result.receipts[0],output:{content:{internal:'not rendered'}},verification:{kind:'durable_object'}}]};
 const snapshot=fixtureSnapshot();snapshot.profiles[0].conversations=[];
 const parsed=normalizeSnapshot({...snapshot,routing_results:{results:[input],completion_outbox:[input],bindings:[]},routing_shares:[]});
 expect(parsed.routing_results?.completion_outbox[0].id).toBe(result.id);expect(parsed.profiles[0].conversations).toEqual([]);
 expect(JSON.stringify(parsed.routing_results)).not.toContain('not rendered');
 expect(normalizeRoutingResults(undefined)).toBeUndefined();
});
it('preserves only the explicit current share permissions and rejects unsupported result schemas',()=>{
 const shares=normalizeRoutingShares([{schema:1,id:'share',version:2,source:{profile_id:'a',conversation_id:'entry'},recipient:{profile_id:'b',conversation_id:'other'},permissions:{read_work:true,change_work:false,read_content:false,resolve_clarification:false},enabled:false,delegation_id:null}])!;
 expect(shares[0]).toMatchObject({version:2,enabled:false,permissions:{read_work:true,change_work:false,read_content:false,resolve_clarification:false}});
 expect(()=>normalizeRoutingResult({...result,schema:2})).toThrow('지원하지');
});
it('keeps stable execution bindings across revisions without exposing internal prompts or claiming completion',()=>{
 const binding={schema:1,id:'binding-new',work_id:work.id,work_revision:2,decision_revision:2,profile_id:work.responsible_profile_id,conversation_id:'stable-work-conversation',task_id:'new-task',state:'submitted',created_ms:101,prompt:'internal dispatch prompt',owner_id:'internal owner',request_id:'internal request'};
 const parsed=normalizeRoutingResults({results:[],completion_outbox:[],bindings:[{...binding,id:'binding-old',work_revision:1,decision_revision:1,state:'superseded'},binding]})!;
 expect(parsed.bindings!.map(b=>b.conversation_id)).toEqual(['stable-work-conversation','stable-work-conversation']);
 expect(bindingMatchesWork(parsed.bindings![0],{...work,work_revision:2,decision_revision:2})).toBe(false);expect(bindingMatchesWork(parsed.bindings![1],{...work,work_revision:2,decision_revision:2})).toBe(true);
 expect(routingBindingLabel(parsed.bindings![1])).toBe('실행 요청 전달됨');expect(JSON.stringify(parsed)).not.toContain('internal');
});
it('retains append-only observation identity while dropping raw effect arguments and keeping current promotion separate',()=>{
 const evidence={schema:1,id:'previous-observation',observed_ms:1,observation:{...result,current:true,verified:true}};
 const effect={schema:1,id:'actual-effect-observation',observed_ms:2,observation:{work_id:work.id,work_revision:1,decision_revision:1,intent_id:'old-intent',profile_id:work.responsible_profile_id,call:{name:'save_todo',arguments:{private:'internal arguments'}},output:{status:'success',content:{private:'internal result'}}}};
 const parsed=normalizeRoutingResults({results:[{...result,current:false,status:'superseded',verified:false}],completion_outbox:[],evidence:[evidence],effect_evidence:[effect]})!;
 expect(parsed.evidence![0]).toMatchObject({id:'previous-observation',verified:true,observed_ms:1});expect(parsed.effect_evidence![0]).toMatchObject({id:'actual-effect-observation',tool:'save_todo',effect_status:'success'});
 expect(JSON.stringify(parsed)).not.toContain('internal');expect(resultMatchesWork(parsed.results[0],work)).toBe(false);expect(parsed.completion_outbox).toEqual([]);
});

it('explains a restricted remote tool failure without promoting the model success prose',()=>{
 const c=normalizeRoutingCapability({...capability,external_mutation_dispatch:false,unsupported_bound_mutation_tools:['planner_mutation','unknown_private_category']});
 expect(c.unsupported_bound_mutation_tools).toEqual(['planner_mutation']);
 const r={...result,status:'failed',verified:false,model_output:'모델이 완료했다고 주장했습니다.',receipts:[{...result.receipts[0],tool:'planner_mutation',verified:false}]};
 const html=renderToStaticMarkup(createElement(RoutingResultContent,{result:r,capability:c}));
 expect(html).toContain('실패');expect(html).toContain('원격 일정이나 외부 서비스의 변경을 지원하지 않습니다');expect(html).not.toContain('저장 근거 확인됨');
 const ordinary=renderToStaticMarkup(createElement(RoutingResultContent,{result:r,capability:{...c,external_mutation_dispatch:true}}));expect(ordinary).not.toContain('routing-execution-limitation');
});

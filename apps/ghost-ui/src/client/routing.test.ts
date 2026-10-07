import { describe, expect, it } from 'vitest';
import { CommandQueue } from './api';
import { RoutingClient, RoutingFailure, normalizeRoutingFailure } from './routingClient';
import { normalizeAdmissionView, normalizeRoutingCapability, normalizeRoutingView } from './routingNormalize';
import { admissionSummary } from '../features/RoutingConversation';
import { capability, entry, firstText, FixtureAdapter, fixtureView } from '../../verification/fixture';
const store = () => { const m=new Map<string,string>(); return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v);}}; };
const turn = { entry, text:firstText, resolves:[] };
describe('candidate A/B read contract',()=>{
 it('preserves 3→4 IDs, untouched meeting Decision and append-only history',()=>{
  const one=normalizeRoutingView(fixtureView(1)), two=normalizeRoutingView(fixtureView(2));
  expect(one.works).toHaveLength(3);expect(two.works).toHaveLength(4);
  expect(two.works.slice(0,3).map(w=>w.id)).toEqual(one.works.map(w=>w.id));
  expect(two.works.find(w=>w.id==='w-meeting')).toEqual(one.works.find(w=>w.id==='w-meeting'));
  expect(two.decisions.filter(d=>d.work_id==='w-meeting')).toEqual(one.decisions.filter(d=>d.work_id==='w-meeting'));
  expect(two.decisions.slice(0,3)).toEqual(one.decisions);
  expect(admissionSummary(two.admissions[1])).toMatchObject({created:1,amended:2});
 });
 it('counts unique Work IDs without assuming one mutation per segment',()=>{
  const v=structuredClone(fixtureView(2).admissions[1]);v.admission.items.push({...v.admission.items[0],segment_id:'nonadjacent-blog'});
  expect(admissionSummary(v).amended).toBe(2);
 });
 it('keeps only the ambiguous segment waiting while another request is admitted',()=>{
  const v=normalizeRoutingView(fixtureView(3)), last=v.admissions[2];
  expect(admissionSummary(last).unresolved).toHaveLength(1);
  expect(last.admission.items[1].work_id).toBe('w-compare');expect(v.works).toHaveLength(4);
  expect(v.works.find(w=>w.id==='w-compare')?.decision_revision).toBe(2);
 });
 it('preserves immutable source admission when a resolution is added',()=>{
  const v=fixtureView(3).admissions[2], original=JSON.stringify(v.admission);
  const input={...v,resolutions:[{schema:2,id:'r1',source_admission_id:v.admission.id,source_segment_id:'s1',answer_admission_id:'answer-1',answer_segment_id:'answer-segment',created_ms:3000}]};
  const parsed=normalizeAdmissionView(input);expect(admissionSummary(parsed).unresolved).toHaveLength(0);
  expect(JSON.stringify(v.admission)).toBe(original);expect(parsed.resolutions[0].answer_admission_id).toBe('answer-1');
 });
 it('preserves noncontiguous source fragments with one Decision and intent per group',()=>{
  const view=normalizeRoutingView(fixtureView(4)), a=view.admissions[3].admission;
  expect(a.items[0].group_anchor_segment_id).toBe(a.items[2].group_anchor_segment_id);
  expect(a.items[0].intent_id).toBe(a.items[2].intent_id);
  const ds=view.decisions.filter(d=>d.source_admission_id===a.id);expect(ds).toHaveLength(2);
  const blog=ds.find(d=>d.work_id==='w-blog')!;expect(blog.source_fragments.map(f=>f.segment_id)).toEqual(['s1','s3']);
  expect(blog.requested_text).not.toContain('유입표');expect(admissionSummary(view.admissions[3]).amended).toBe(2);
 });
 it('rejects malformed contract data instead of manufacturing runtime success',()=>{
  expect(()=>normalizeRoutingCapability({admission:true})).toThrow('응답 형식');
  expect(()=>normalizeRoutingView({...fixtureView(),works:[{...fixtureView().works[0],status:'complete'}]})).toThrow('응답 형식');
  expect(normalizeRoutingCapability(capability).runtime_dispatch).toBe(false);
 });
 it('uses structured error codes and never parses a message for authority',()=>{
  expect(normalizeRoutingFailure({code:'authority_changed'})?.code).toBe('authority_changed');
  expect(normalizeRoutingFailure({error:'authority_changed'})).toBeNull();
 });
});
describe('uninstalled candidate submission seam (not composer)',()=>{
 it('recovers an ACK-lost immutable receipt after reload before reproposal',async()=>{
  const storage=store(),a=new FixtureAdapter();a.loseResponse=true;
  await expect(new RoutingClient(a,new CommandQueue(storage,'pending')).submit(turn)).rejects.toThrow('ACK');
  const pending=JSON.parse(storage.getItem('pending')!);const e=Object.values(pending)[0] as {request_id:string;command:{prepared:unknown}};
  expect(e.command.prepared).toBeTruthy();
  const result=await new RoutingClient(a,new CommandQueue(storage,'pending')).submit(turn);
  expect(result.admission.input.origin.message_id).toBe(e.request_id);expect(a.preparations).toBe(1);
  expect(a.calls.filter(c=>c.startsWith('admit:'))).toHaveLength(1);expect(storage.getItem('pending')).toBe('{}');
 });
 it('retains exact prepared payload for retry if no receipt was committed',async()=>{
  const storage=store(),a=new FixtureAdapter();let fail=true;
  const real=a.admit.bind(a);a.admit=async(...args)=>{if(fail){fail=false;throw new Error('connection lost before admission');}return real(...args);};
  await expect(new RoutingClient(a,new CommandQueue(storage,'pending')).submit(turn)).rejects.toThrow('connection');
  const encoded=storage.getItem('pending');await new RoutingClient(a,new CommandQueue(storage,'pending')).submit(turn);
  expect(a.preparations).toBe(1);expect(encoded).toContain('ghost-routing-proposal/2');
 });
 it('does not silently fallback or relink on permission/revision rejection',async()=>{
  for(const code of ['authority_changed','revision_conflict'] as const){
   const storage=store(),a=new FixtureAdapter();a.revoked=code==='authority_changed';a.stale=code==='revision_conflict';
   await expect(new RoutingClient(a,new CommandQueue(storage,'pending')).submit(turn)).rejects.toMatchObject({code});
   expect(storage.getItem('pending')).toBe('{}');expect(a.receipts.size).toBe(0);
  }
 });
 it('blocks any send when capability is false',async()=>{
  const a=new FixtureAdapter();a.capability=async()=>({...capability,admission:false});
  await expect(new RoutingClient(a,new CommandQueue(store(),'pending')).submit(turn)).rejects.toThrow('지원하지');expect(a.calls).toEqual([]);
 });
 it('does not rewrite a colliding input under its old identity',async()=>{
  const a=new FixtureAdapter();a.prepare=async()=>{throw new RoutingFailure('input_collision');};
  await expect(new RoutingClient(a,new CommandQueue(store(),'pending')).submit(turn)).rejects.toMatchObject({code:'input_collision'});expect(a.receipts.size).toBe(0);
 });
});

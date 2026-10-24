import { describe, expect, it } from 'vitest';
import { graphLayers, normalizeGraphs, normalizeGraphRuns, validateGraph } from './orchestration';
import type { GraphInput } from './orchestration';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333';
const plan=():GraphInput=>({title:'조사와 검토',nodes:[a,b,c].map((id,index)=>({id,profile_id:`p${index}`,title:`작업 ${index}`,prompt:'근거를 확인해 주세요.'})),edges:[{from:a,to:c,condition:'success'},{from:b,to:c,condition:'success'}]});
describe('task graph validation',()=>{
  it('places independent tasks in parallel and joins only after both predecessors',()=>{
    expect(graphLayers(plan())).toEqual([[a,b],[c]]); expect(validateGraph(plan(),['p0','p1','p2'])).toBeNull();
  });
  it('rejects cycles across success and failure branches, missing targets and duplicates',()=>{
    const cyclic=plan();cyclic.edges.push({from:c,to:a,condition:'failure'});expect(validateGraph(cyclic,['p0','p1','p2'])).toContain('순환');
    const missing=plan();missing.edges[0].to='unknown';expect(validateGraph(missing,['p0','p1','p2'])).not.toBeNull();
    const duplicate=plan();duplicate.edges.push(duplicate.edges[0]);expect(validateGraph(duplicate,['p0','p1','p2'])).not.toBeNull();
  });
  it('rejects removed Ghosts and requests exceeding the host byte limit',()=>{
    expect(validateGraph(plan(),['p0'])).toContain('담당'); const long=plan();long.nodes[0].prompt='한'.repeat(1400);expect(validateGraph(long,['p0','p1','p2'])).not.toBeNull();
  });
  it('preserves frozen run plans and fails closed for missing or unknown work states',()=>{
    const saved={...plan(),id:'plan',version:1,updated_ms:1};
    const run={id:'run',plan:saved,state:'running',created_ms:1,jobs:saved.nodes.map(node=>({node_id:node.id,state:'pending',conversation_id:node.id,task_id:null,output:''}))};
    expect(normalizeGraphRuns([run])[0].plan.version).toBe(1);
    expect(()=>normalizeGraphRuns([{...run,jobs:run.jobs.slice(1)}])).toThrow();
    expect(()=>normalizeGraphRuns([{...run,jobs:run.jobs.map(job=>({...job,state:'invented'}))}])).toThrow();
    expect(()=>normalizeGraphs([{...saved,edges:[{from:a,to:c,condition:'unknown'}]}])).toThrow();
  });
});

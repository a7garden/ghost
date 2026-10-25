// Request-only references to provably redundant completed file actions. This
// never writes an SDK entry, changes a tool argument, or grants new authority.
import { createHash } from 'node:crypto';
import { payloadDigest } from './contract.js';
import { directWorkObservation } from './direct-work-observation.js';

const sha = value => createHash('sha256').update(value,'utf8').digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value,'utf8') <= 400;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (value,keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key=>keys.includes(key));
const only = (value,keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key=>keys.includes(key));
const MAX_ENTRIES=2048, MAX_PAIRS=8, MAX_NOTE_BYTES=1024;

// Matches the existing Host execution identity domain; an unknown future
// format simply leaves history unprojected, never changes Host authority.
export function fileExecutionId({ghostId,workId,goalRevision,assignmentId}) {
  return sha(JSON.stringify(['ghost-pi/1',ghostId,workId,goalRevision,assignmentId]));
}
export function assignmentFileIdentity(assignment) {
  return {assignment_id:assignment.id,source_command_id:assignment.source_command_id,ghost_id:assignment.ghost_id,
    conversation_id:assignment.conversation_id,goal_id:assignment.goal_id,goal_revision:assignment.goal_revision,
    work_id:assignment.work_id,prompt:assignment.prompt,origin_kind:assignment.origin_kind,
    parent_work_id:assignment.parent_work_id,root_goal_id:assignment.root_goal_id};
}
function validScope(scope) {
  return scope?.originKind==='goal_assignment' && /^wc-[a-f0-9]{64}$/u.test(scope.contextRef)
    && [scope.ghostId,scope.conversationId,scope.assignmentId,scope.workId].every(text)
    && id(scope.generationTaskId) && id(scope.sdkConversationId) && id(scope.goalRevision)
    && (scope.boundary===null || Number.isSafeInteger(scope.boundary)&&scope.boundary>=0)
    && digest(scope.executionId) && scope.executionId===fileExecutionId(scope)
    && exact(scope.assignmentIdentity,['assignment_id','source_command_id','ghost_id','conversation_id','goal_id','goal_revision','work_id','prompt','origin_kind','parent_work_id','root_goal_id'])
    && scope.assignmentIdentity.assignment_id===scope.assignmentId && scope.assignmentIdentity.work_id===scope.workId
    && scope.assignmentIdentity.ghost_id===scope.ghostId && scope.assignmentIdentity.conversation_id===scope.conversationId
    && scope.assignmentIdentity.goal_revision===scope.goalRevision;
}
function plainAssistant(message) {
  return only(message,['role','content','api','provider','model','usage','stopReason','timestamp','responseId','rawStopReason','durationMs'])
    && message.role==='assistant' && message.api==='openai-completions' && message.stopReason==='toolUse'
    && Number.isFinite(message.timestamp) && Array.isArray(message.content)
    && (message.responseId===undefined || text(message.responseId))
    && (message.rawStopReason===undefined || message.rawStopReason===null || typeof message.rawStopReason==='string')
    && message.content.every(block=>block?.type==='text' && exact(block,['type','text']) && typeof block.text==='string'
      || block?.type==='toolCall' && exact(block,['type','id','name','arguments']));
}
function realTask(tasks,assistant,result,call,receipt,scope) {
  const task=tasks.get(result.byTaskId), owner=tasks.get(assistant.byTaskId);
  return id(result.byTaskId) && id(assistant.byTaskId) && task?.kind==='pi.tool' && task.id===receipt.task_id
    && task.conversationId===scope.sdkConversationId && task.owner===assistant.byTaskId
    && exact(task.input,['assistant','callId']) && task.input.assistant===assistant.id && task.input.callId===call.id
    && task.state?.status==='terminal' && task.state.outcome?.status==='completed'
    && task.state.outcome.result?.entryId===result.id && task.abortRequested===false
    && owner?.kind==='pi.generation' && owner.id===assistant.byTaskId && owner.conversationId===scope.sdkConversationId
    && owner.state?.status==='terminal' && owner.state.outcome?.status==='completed'
    && owner.state.outcome.result?.entryId===assistant.id;
}
function candidate(rows,index,tasks,scope,ambiguous) {
  const row=rows[index],next=rows[index+1];
  if(!row||!next||row.entry.id<=scope.boundary||next.entry.id<=scope.boundary
    || row.entry.kind!=='pi.assistant'||next.entry.kind!=='pi.tool-result'
    || row.entry.conversationId!==scope.sdkConversationId||next.entry.conversationId!==scope.sdkConversationId
    || !same(row.messages,row.entry.model)||!same(next.messages,next.entry.model)
    || row.messages?.length!==1||next.messages?.length!==1) return null;
  const assistant=row.messages[0],result=next.messages[0];
  if(!plainAssistant(assistant)) return null;
  const calls=assistant.content.filter(block=>block.type==='toolCall');
  if(calls.length!==1) return null;
  const call=calls[0],args=call.arguments;
  if(!['read','write'].includes(call.name)||!text(call.id)||ambiguous.has(call.id)
    || !only(result,['role','toolCallId','toolName','content','details','isError','durationMs','timestamp'])
    || result.role!=='toolResult'||result.toolCallId!==call.id||result.toolName!==call.name||result.isError!==false
    || !exact(next.entry.data,['diagnostics'])||!Array.isArray(next.entry.data.diagnostics)||next.entry.data.diagnostics.length!==0) return null;
  const response=result.details,receipt=response?.data?.receipt,output=response?.data?.output;
  if(!exact(response,['status','summary','object_refs','artifacts','next_actions','retry_class','error_code','data'])
    ||response.status!=='success'||response.summary!=='Pi tool effect observed'||response.error_code!==null||response.retry_class!=='same_id'
    ||!same(response.object_refs,[scope.executionId])||!same(response.artifacts,[])||!same(response.next_actions,[])
    ||!exact(response.data,['receipt','output'])||!exact(receipt,['assignment_id','work_id','generation_task_id','task_id','call_id','input_digest','execution_id','state'])
    ||receipt.assignment_id!==scope.assignmentId||receipt.work_id!==scope.workId||receipt.generation_task_id!==scope.generationTaskId
    ||receipt.execution_id!==scope.executionId||receipt.call_id!==call.id||receipt.state!=='complete'
    ||receipt.input_digest!==payloadDigest({operation:call.name,arguments:args})
    ||!realTask(tasks,row.entry,next.entry,call,receipt,scope)) return null;
  if(!same(result.content,directWorkObservation(call.name,args,response))) return null;
  if(call.name==='write') {
    if(!exact(args,['path','content'])||typeof args.content!=='string'||Buffer.byteLength(args.content,'utf8')>65536||!exact(output,['path','sha256'])
      ||typeof args.path!=='string'||args.path!==output.path||!digest(output.sha256)||sha(args.content)!==output.sha256) return null;
  } else {
    if(!only(args,['path','offset','limit'])||typeof args.path!=='string'||!Object.hasOwn(args,'path')
      ||!exact(output,['content','sha256'])||typeof output.content!=='string'||Buffer.byteLength(output.content,'utf8')>65536||!digest(output.sha256)) return null;
    if(!Number.isSafeInteger(args.offset??1)||(args.offset??1)<1||!Number.isSafeInteger(args.limit??2000)||(args.limit??2000)<1||(args.limit??2000)>2000) return null;
  }
  return {index,assistantEntry:row.entry,resultEntry:next.entry,assistant,result,call,args,receipt,output};
}
function portableWire(message) {
  if(message.role==='assistant') {
    const value={role:'assistant',content:message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')||null};
    const calls=message.content.filter(block=>block.type==='toolCall');
    if(calls.length)value.tool_calls=calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}));
    return value;
  }
  if(message.role==='toolResult')return {role:'tool',tool_call_id:message.toolCallId,content:message.content.map(block=>block.text).join('\n')};
  return {role:message.role,content:message.content};
}
function replacement(older,newer,scope,now) {
  const relation=older.call.name==='write'?'superseded_full_write':'exact_duplicate_read';
  const note={kind:'ghost.completed-file-observation/1',id:`cfo-${payloadDigest([scope.contextRef,scope.executionId,scope.generationTaskId,relation,older.assistantEntry.id,older.resultEntry.id,newer.assistantEntry.id,newer.resultEntry.id,older.receipt.input_digest,newer.receipt.input_digest])}`,
    untrusted:true,diagnostic_only:true,relation,scope:{work_id:scope.workId,generation_task_id:scope.generationTaskId},
    source:{assistant_entry_id:older.assistantEntry.id,result_entry_id:older.resultEntry.id,call_id:older.call.id,input_digest:older.receipt.input_digest},
    retained:{assistant_entry_id:newer.assistantEntry.id,result_entry_id:newer.resultEntry.id},
    file:{path:older.args.path,observed_sha256:older.output.sha256,retained_sha256:newer.output.sha256},
    durable_records:'unchanged',filesystem_state:'historical_not_current',authority:'none',retained_content:'full_in_request'};
  if(older.call.name==='read') {delete note.file.retained_sha256;note.file.selected_text_sha256=sha(older.output.content);}
  const content=JSON.stringify(note);
  if(Buffer.byteLength(content,'utf8')>MAX_NOTE_BYTES)return null;
  const remaining=structuredClone(older.assistant);
  remaining.content=remaining.content.filter(block=>block.type!=='toolCall');
  const assistant=remaining.content.length?[remaining]:[];
  const observation={role:'user',content,timestamp:now};
  const before=Buffer.byteLength(JSON.stringify([portableWire(older.assistant),portableWire(older.result)]),'utf8');
  const after=Buffer.byteLength(JSON.stringify([...assistant.map(portableWire),portableWire(observation)]),'utf8');
  if(before-after<512||after*4>before*3)return null;
  return {assistant,observation,note,before,after};
}

/** All inputs are read-only; caller must already have validated current source,
 * memory/publication/disclosure authority, and validate again before sending. */
export function projectCompletedFilePairs({entries,contributions,tasks,scope,observedAtMs,admissionEntries=entries}) {
  const original=()=>({messages:Array.isArray(contributions)?contributions.flatMap(value=>Array.isArray(value)?value:[]):[],observations:[],savedWireBytes:0});
  if(!validScope(scope)||!Array.isArray(entries)||!Array.isArray(contributions)||entries.length!==contributions.length
    ||entries.length>MAX_ENTRIES||!Array.isArray(admissionEntries)||admissionEntries.length>MAX_ENTRIES||contributions.some(value=>!Array.isArray(value))||!Number.isFinite(observedAtMs)||!Array.isArray(tasks))return original();
  const ids=new Set(),taskMap=new Map();let previousId=0;
  for(const entry of entries){if(!id(entry?.id)||ids.has(entry.id)||entry.id<=previousId)return original();ids.add(entry.id);previousId=entry.id;}
  for(const task of tasks){if(!id(task?.id)||taskMap.has(task.id))return original();taskMap.set(task.id,task);}
  const admissions=admissionEntries.filter(entry=>entry?.kind==='ghost.work-context-admission/1');
  if(admissions.length!==1||admissions[0].conversationId!==scope.sdkConversationId
    ||!exact(admissions[0].data,['context_ref','assignment_id','identity_digest'])
    ||admissions[0].data.context_ref!==scope.contextRef||admissions[0].data.assignment_id!==scope.assignmentId
    ||!digest(admissions[0].data.identity_digest)||admissions[0].data.identity_digest!==payloadDigest(scope.assignmentIdentity))return original();
  const rows=entries.map((entry,index)=>({entry,messages:contributions[index]}));
  const counts=new Map(),resultCounts=new Map();
  for(const {entry} of rows)for(const message of Array.isArray(entry.model)?entry.model:[]) {
    if(message.role==='assistant'&&Array.isArray(message.content))for(const call of message.content)if(call.type==='toolCall')counts.set(call.id,(counts.get(call.id)??0)+1);
    if(message.role==='toolResult')resultCounts.set(message.toolCallId,(resultCounts.get(message.toolCallId)??0)+1);
  }
  const ambiguous=new Set([...counts].filter(([call,count])=>count!==1||resultCounts.get(call)!==1).map(([call])=>call));
  const pairs=[];
  for(let i=0;i<rows.length-1;i++){const pair=candidate(rows,i,taskMap,scope,ambiguous);if(pair)pairs.push(pair);}
  const replacements=new Map(),observations=[];let savedWireBytes=0;
  for(const older of pairs) {
    const later=pairs.filter(newer=>newer.index>older.index&&newer.call.name===older.call.name&&newer.args.path===older.args.path
      && (older.call.name==='write'||same(older.args,newer.args)&&older.output.sha256===newer.output.sha256&&older.output.content===newer.output.content));
    const newest=later.at(-1);if(!newest)continue;
    const projected=replacement(older,newest,scope,observedAtMs);if(!projected||observations.length>=MAX_PAIRS)continue;
    replacements.set(older.index,projected.assistant);replacements.set(older.index+1,[projected.observation]);
    observations.push(projected.note);savedWireBytes+=projected.before-projected.after;
  }
  if(!observations.length)return original();
  return {messages:rows.flatMap((row,index)=>replacements.get(index)??row.messages),observations,savedWireBytes};
}

import type {AdmissionView,RoutingEntry,RoutingView} from './routingTypes';
import type {Message,Task} from './types';

export type RoutingConversationRow =
 | {kind:'message';message:Message;index:number}
 | {kind:'admission';receipt:AdmissionView};

const routingTools=new Set(['routing_input','routing_candidates','routing_work','routing_decisions','routing_receipt','route_work']);

// Match only Host-projected request identity. Identical text is never identity.
export function routingTimeline(messages:Message[],tasks:Task[],view:RoutingView|null,entry:RoutingEntry):RoutingConversationRow[] {
 const admissions=(view?.admissions??[]).filter(r=>r.admission.input.origin.entry_profile_id===entry.entry_profile_id&&r.admission.input.origin.conversation_id===entry.conversation_id);
 const requests=new Map<string,AdmissionView>(),ambiguous=new Set<string>();
 for(const receipt of admissions){const id=receipt.admission.input.origin.message_id;if(requests.has(id))ambiguous.add(id);else requests.set(id,receipt);}
 for(const id of ambiguous)requests.delete(id);
 const routingTasks=new Set(messages.filter(m=>['user','queued'].includes(m.role)&&m.request_id&&requests.has(m.request_id)&&m.task_id).map(m=>m.task_id!));
 let changed=true;
 while(changed){changed=false;for(const task of tasks)if(task.parent_id&&routingTasks.has(task.parent_id)&&!routingTasks.has(task.id)){routingTasks.add(task.id);changed=true;}}
 const rows:RoutingConversationRow[]=[],placed=new Set<string>();
 messages.forEach((message,index)=>{
  const receipt=['user','queued'].includes(message.role)&&message.request_id?requests.get(message.request_id):undefined;
  if(receipt){if(!placed.has(receipt.admission.id)){rows.push({kind:'admission',receipt});placed.add(receipt.admission.id);}return;}
  // Routing traces are represented by the canonical receipt only for the exact
  // admitted SDK task family. Ordinary tools and pending/failed turns stay visible.
  if(message.role==='tool'&&message.task_id&&routingTasks.has(message.task_id)&&routingTools.has(message.tool?.name??''))return;
  if(message.role==='assistant'&&!message.text.trim())return;
  rows.push({kind:'message',message,index});
 });
 for(const receipt of admissions)if(!placed.has(receipt.admission.id))rows.push({kind:'admission',receipt});
 return rows;
}

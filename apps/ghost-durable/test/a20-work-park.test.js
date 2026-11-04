import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedA20WorkPark } from '../scripts/a20-work-park.mjs';
const fixture=()=>{
  const command={command_id:'assignment-root',authority_epoch:3,body:{method:'conversation.assignment',ghost_id:'root',conversation_id:'conversation',work_id:'work',goal_revision:2}};
  const request={ghost_id:'root',conversation_id:'conversation',envelope:{authority_epoch:3,body:{method:'work.wait.inspect',assignment_id:'assignment-root',work_id:'work',generation_task_id:8,wait_command_id:'original-wait',wait_payload_digest:'a'.repeat(64),wait_for:['child']}}};
  const receipt={kind:'pi-work-wait/1',assignment_id:'assignment-root',work_id:'work',generation_task_id:8,goal_revision:2,owner_revision:1,authority_epoch:3,wait_command_id:'original-wait',wait_payload_digest:'a'.repeat(64),wait_for:['child'],execution_id:null};
  return {command,request,frame:{ok:true,result:{status:'success',data:{phase:'waiting',wait_receipt:receipt}}}};
};
test('A20 park ACK requires the exact current Host waiting receipt for this assignment and original generation',()=>{
  const {command,request,frame}=fixture();
  assert.deepEqual(verifiedA20WorkPark(command,request,frame),frame.result.data.wait_receipt);
  for(const mutate of [
    x=>{x.frame.ok=false;},x=>{x.frame.result.status='error';},x=>{x.frame.result.data.phase='resolved';},
    x=>{x.command.body.method='conversation.open';},x=>{x.request.ghost_id='other';},x=>{x.request.conversation_id='other';},
    x=>{x.request.envelope.body.method='work.wait';},x=>{x.frame.result.data.wait_receipt.assignment_id='other';},
    x=>{x.frame.result.data.wait_receipt.work_id='other';},x=>{x.frame.result.data.wait_receipt.goal_revision=1;},
    x=>{x.frame.result.data.wait_receipt.generation_task_id=9;},x=>{x.frame.result.data.wait_receipt.authority_epoch=4;},
    x=>{x.frame.result.data.wait_receipt.wait_command_id='new-identity';},x=>{x.frame.result.data.wait_receipt.wait_payload_digest='b'.repeat(64);},
    x=>{x.frame.result.data.wait_receipt.wait_for=['other'];},x=>{x.frame.result.data.wait_receipt.wait_for=[];x.request.envelope.body.wait_for=[];},
    x=>{x.frame.result.data.wait_receipt.owner_revision=0;},x=>{x.frame.result.data.wait_receipt.execution_id={};},
    x=>{delete x.frame.result.data.wait_receipt.wait_payload_digest;delete x.request.envelope.body.wait_payload_digest;},
  ]) {
    const value=fixture();mutate(value);assert.equal(verifiedA20WorkPark(value.command,value.request,value.frame),null);
  }
});

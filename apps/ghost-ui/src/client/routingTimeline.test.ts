import {expect,it} from 'vitest';
import {routingTimeline} from './routingTimeline';
import {entry,fixtureView,firstText} from '../../verification/fixture';

it('places one canonical receipt at the exact SDK input position and retains later replies',()=>{
 const view=fixtureView(1),messages=[{role:'user',text:firstText,request_id:'turn-1',task_id:'router'},{role:'assistant',text:'접수했습니다.',task_id:'router'},{role:'queued',text:firstText,request_id:'turn-1',task_id:'router'}];
 const rows=routingTimeline(messages,[],view,entry);
 expect(rows.map(r=>r.kind)).toEqual(['admission','message']);expect(rows[0].kind==='admission'&&rows[0].receipt.admission.id).toBe('turn-1');
});
it('never deduplicates equal text with a different UUID or absent legacy identity',()=>{
 const messages=[{role:'user',text:firstText,request_id:'different-turn'},{role:'user',text:firstText,request_id:null},{role:'user',text:firstText}];
 expect(routingTimeline(messages,[],fixtureView(1),entry).map(r=>r.kind)).toEqual(['message','message','message','admission']);
 expect(routingTimeline([{role:'user',text:firstText,request_id:'turn-1'}],[],fixtureView(1),{...entry,conversation_id:'other'}).map(r=>r.kind)).toEqual(['message']);
});
it('removes internal routing traces only from the proven admitted task family',()=>{
 const messages=[{role:'user',text:firstText,request_id:'turn-1',task_id:'root'},{role:'tool',text:'routing detail',task_id:'child',tool:{name:'routing_input'}},{role:'tool',text:'ordinary result',task_id:'child',tool:{name:'read_file'}},{role:'tool',text:'other request routing detail',task_id:'other',tool:{name:'route_work'}}];
 const rows=routingTimeline(messages,[{id:'child',parent_id:'root',phase:'complete',name:'routing_input',partial:'',output:''}],fixtureView(1),entry);
 expect(rows.filter(r=>r.kind==='message').map(r=>r.kind==='message'&&r.message.text)).toEqual(['ordinary result','other request routing detail']);
 expect(routingTimeline(messages,[],null,entry)).toHaveLength(4);
});

import { DetailDialog } from '../components/DetailDialog';
import { useEffect, useRef, useState } from 'react';
import { CalendarDays, CircleAlert, RefreshCw } from 'lucide-react';
import type { Command } from '../client/types';
import { canRefreshPlanner, normalizePlannerItems, normalizePlannerStatus, plannerOperationLabel } from '../client/connectedPlanner';
import type { ConnectedPlanner as PlannerSnapshot, PlannerCollection, PlannerItem, PlannerPlain, PlannerSyncStatus } from '../client/connectedPlanner';
import './connected-planner.css';
type Request = (command: Command) => Promise<Record<string, any>>;
const timestamp=(ms:number|null)=>ms===null?'아직 없음':new Date(ms).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const connectionLabel=(state:string)=>({anonymous_configured:'연결 설정됨',credential_required:'인증 연결 필요',unconnected:'연결 필요'} as Record<string,string>)[state]??'연결 상태 확인 필요';
function PlainView({value}:{value:PlannerPlain|null}) {if(!value)return <span className="muted">내용 없음</span>;return <div className="connected-plain"><strong>{value.title||'제목 없음'}</strong>{value.notes&&<p>{value.notes}</p>}{value.kind==='VTODO'&&value.due&&<small>마감일 {value.due}</small>}{value.kind==='VEVENT'&&value.start_ms!==null&&<small>{timestamp(value.start_ms)}{value.end_ms!==null&&` – ${timestamp(value.end_ms)}`}</small>}</div>;}
function CollectionView({planner,collection,query,action,busy,connected}:{planner:PlannerSnapshot;collection:PlannerCollection;query:Request;action:Request;busy:boolean;connected:boolean}) {
 const advertised=planner.sync_status.find(s=>s.collection_id===collection.id);
 const [state,setState]=useState<{items:PlannerItem[];status:PlannerSyncStatus|undefined;read_ms:number|null;error:string}>({items:[],status:undefined,read_ms:null,error:''});
 const [attempt,setAttempt]=useState(0),[refreshing,setRefreshing]=useState(false);const refreshFence=useRef(false);
 const readKey=JSON.stringify({generation:collection.generation,enabled:collection.enabled,status:advertised,coordinator:planner.sync_status_available});
 useEffect(()=>{
  let active=true;
  if(!connected){setState({items:[],status:undefined,read_ms:null,error:'연결되면 원격 상태를 다시 확인합니다.'});return;}
  const load=async()=>{
   try {
    const status=planner.sync_status_available?normalizePlannerStatus(await query({type:'workspace',action:{type:'planner_sync_status',collection_id:collection.id}})):undefined;
    if(status&&status.collection_id!==collection.id)throw new Error('조회한 컬렉션의 상태가 일치하지 않습니다.');
    const items=normalizePlannerItems(await query({type:'workspace',action:{type:'list_connected_planner',collection_id:collection.id,from_ms:null,to_ms:null}}),collection.id);
    if(active)setState({items,status,read_ms:Date.now(),error:''});
   }catch{if(active)setState({items:[],status:undefined,read_ms:null,error:'원격 목록과 현재 상태를 확인하지 못했습니다. 다시 조회해 주세요.'});}
  };void load();return()=>{active=false;};
 },[query,collection.id,readKey,attempt,connected]);
 const current=state.status??advertised;
 const refresh=async()=>{
  if(refreshFence.current||busy||!connected||!canRefreshPlanner(planner,collection,current))return;
  refreshFence.current=true;setRefreshing(true);
  try{await action({type:'workspace',action:{type:'planner_sync_once',collection_id:collection.id,write:false}});}
  catch{setState(old=>({...old,error:'원격 조회 결과를 아직 확인하지 못했습니다. 현재 상태를 다시 읽습니다.'}));}
  finally{refreshFence.current=false;setRefreshing(false);setAttempt(n=>n+1);}
 };
 return <section className="connected-collection" data-planner-collection={collection.id}>
  <div className="section-heading"><div><h3>{collection.kind==='VTODO'?'연결된 할 일':'연결된 일정'}</h3><p className="planner-caption">{collection.binding}</p></div><button className="button secondary" disabled={busy||refreshing||!connected||!canRefreshPlanner(planner,collection,current)} onClick={()=>void refresh()}><RefreshCw size={14} className={refreshing?'spinning':''}/>{refreshing||current?.running?'조회 중…':'원격 목록 새로 읽기'}</button></div>
  <p className="connected-connection">{!collection.enabled?'연결 사용 중지':current?connectionLabel(current.connection_state):'연결 상태 미확인'} · 읽기 전용 보기</p>
  {current&&<dl className="connected-read-times"><div><dt>마지막 조회 시도</dt><dd>{timestamp(current.last_attempt_ms)}</dd></div><div><dt>마지막 동기화 완료</dt><dd>{timestamp(current.last_success_ms)}</dd></div><div><dt>화면 상태 재조회</dt><dd>{timestamp(state.read_ms)}</dd></div></dl>}
  {current?.last_error&&<p className="connected-warning" role="status"><CircleAlert size={14}/>최근 동기화에 실패했습니다. 이전 성공 시각은 최신 상태를 뜻하지 않습니다.</p>}
  {state.error&&<p className="inline-error" role="alert">{state.error} <button className="text-button" disabled={!connected} onClick={()=>setAttempt(n=>n+1)}>현재 상태 다시 읽기</button></p>}
  {!planner.sync_status_available&&<p className="field-help">이 Host는 수동 원격 조회를 아직 제공하지 않습니다.</p>}
  <div className="planner-list">{state.items.map(item=><article className="connected-planner-item" key={`${item.collection_id}:${item.uid}`} data-connected-item={item.uid}><PlainView value={item.view}/><div className="connected-item-meta"><span>{item.view.kind==='VTODO'?(item.view.completed?'완료한 할 일':'할 일'):item.view.kind==='VEVENT'?'일정':'지원하지 않는 형식'}</span>{(item.read_only||item.diagnostic.length>0)&&<small>편집할 수 없는 항목</small>}{item.pending_operation&&<small>{plannerOperationLabel({phase:item.sync_state,remote_applied:item.remote_applied})}</small>}</div></article>)}</div>
  {!state.items.length&&!state.error&&<p className="quiet-empty"><CalendarDays size={17}/>{state.read_ms?'이 연결의 목록이 비어 있습니다.':'원격 목록을 읽고 있습니다.'}</p>}
  {state.status?.operations.length?<div className="connected-operations" aria-label="현재 동기화 작업">{state.status.operations.map(operation=><article key={operation.operation_id} data-planner-operation={operation.operation_id}><strong>{plannerOperationLabel(operation)}</strong><small>{state.items.find(item=>item.uid===operation.uid)?.view.title||operation.conflict?.desired.title||'변경 요청'}</small>{operation.conflict&&<DetailDialog title="충돌 내용 확인"><p className="field-help">내용을 확인하기 전에는 원격 항목을 덮어쓰지 않습니다.</p><div className="connected-conflict"><section><h4>수정 전</h4><PlainView value={operation.conflict.base}/></section><section><h4>내가 요청한 변경</h4><PlainView value={operation.conflict.desired}/></section><section><h4>현재 원격 내용</h4>{operation.conflict.remote_deleted?<p>원격에서 삭제된 항목입니다.</p>:<PlainView value={operation.conflict.remote}/>}</section></div></DetailDialog>}</article>)}</div>:null}
 </section>;
}
export function ConnectedPlanner({planner,workspaceId,query,action,busy,connected}:{planner:PlannerSnapshot|undefined;workspaceId:string;query:Request;action:Request;busy:boolean;connected:boolean}) {
 if(!planner?.collections.length)return null;
 return <section className="connected-planner" aria-label="연결된 할 일과 일정"><div className="section-heading"><h2>연결된 목록</h2></div><p className="planner-caption">Ghost에 저장한 목록과 별도로 표시합니다. 원격 조회는 항목을 수정하지 않습니다.</p>{planner.collections.map(collection=><CollectionView key={`${workspaceId}:${collection.id}`} planner={planner} collection={collection} query={query} action={action} busy={busy} connected={connected}/>)}</section>;
}

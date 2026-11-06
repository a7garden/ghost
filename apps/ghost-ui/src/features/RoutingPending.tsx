import {useCallback,useEffect,useRef,useState} from 'react';
import {CircleAlert,LoaderCircle,RefreshCw,Square} from 'lucide-react';
import {Button} from '@garden/ui';
import type {RoutingClient} from '../client/routingClient';
import type {PendingRoutingRequest,RoutingPendingObservation,RoutingEntry} from '../client/routingTypes';

type Settled=(request:PendingRoutingRequest,observation:RoutingPendingObservation)=>void;
const active=(request:PendingRoutingRequest)=>!['failed','cancelled'].includes(request.state);

// The original envelope is the journal of an input, never a client Work store.
// Polling is only the fallback — host event signals call scan() sooner — and it
// observes the canonical receipt/task; it never resends the prompt.
/** Live admission-pending state for one conversation: observed requests plus the actions on them. */
export interface PendingRoutingState {
 requests: PendingRoutingRequest[];
 waiting: boolean;
 blocking: boolean;
 checking: string[];
 notice: string;
 refresh: () => Promise<void>;
 check: (request: PendingRoutingRequest) => Promise<void>;
 cancel: (request: PendingRoutingRequest) => Promise<void>;
 dismiss: (request: PendingRoutingRequest) => Promise<void>;
}
export function usePendingRouting(client:RoutingClient|undefined,entry:RoutingEntry,connected:boolean,onSettled:Settled):PendingRoutingState{
 const clientRef=useRef(client),settledRef=useRef(onSettled),epoch=useRef(0),inFlight=useRef(new Set<string>()),notified=useRef(new Set<string>());
 if(client)clientRef.current=client;
 settledRef.current=onSettled;
 const [requests,setRequests]=useState<PendingRoutingRequest[]>([]),[checking,setChecking]=useState<string[]>([]),[notice,setNotice]=useState('');
 const entryKey=`${entry.entry_profile_id}:${entry.conversation_id}`;
 const scan=useCallback(async()=>{
  const current=clientRef.current,version=epoch.current,jobs=inFlight.current;
  if(!current||!entry.conversation_id||jobs.has('scan'))return;
  jobs.add('scan');
  try{
   const saved=await current.pending(entry);
   if(version!==epoch.current)return;
   setRequests(saved);
   if(!connected)return;
   for(const request of saved){
    if(!active(request)||inFlight.current.has(request.request_id))continue;
    const observation=await current.pollPending(request);
    if(version!==epoch.current)return;
    if(['admitted','cancelled','failed'].includes(observation.state)&&!notified.current.has(request.request_id)){
     notified.current.add(request.request_id);settledRef.current(request,observation);
    }
   }
   const latest=await current.pending(entry);
   if(version===epoch.current){setRequests(latest);setNotice('');}
  }catch{if(version===epoch.current)setNotice('연결을 기다리고 있습니다. 저장된 요청으로 접수 상태를 다시 확인할 수 있습니다.');}
  finally{jobs.delete('scan');}
 },[entryKey,connected]);
 useEffect(()=>{
  epoch.current++;inFlight.current=new Set();notified.current=new Set();setRequests([]);setChecking([]);setNotice('');
  let live=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{await scan();if(live)timer=setTimeout(poll,document.hidden?30000:10000);};void poll();
  return()=>{live=false;epoch.current++;clearTimeout(timer);};
 },[entryKey,connected,scan]);
 const change=useCallback(async(request:PendingRoutingRequest,kind:'check'|'cancel'|'dismiss')=>{
  const current=clientRef.current,version=epoch.current,jobs=inFlight.current;
  if(!current||jobs.has(request.request_id))return;
  jobs.add(request.request_id);setChecking(previous=>[...previous,request.request_id]);
  try{
   const observation=kind==='dismiss'?await current.dismissPending(request):kind==='cancel'?await current.cancelPending(request):await current.pollPending(request);
   if(version!==epoch.current)return;
   if(observation&&['admitted','cancelled','failed'].includes(observation.state)&&!notified.current.has(request.request_id)){
    notified.current.add(request.request_id);settledRef.current(request,observation);
   }
   const latest=await current.pending(entry);
   if(version===epoch.current){setRequests(latest);setNotice('');}
  }catch{if(version===epoch.current)setNotice('접수 상태를 아직 확인하지 못했습니다. 요청 기록을 유지하고 다시 확인합니다.');}
  finally{jobs.delete(request.request_id);if(version===epoch.current)setChecking(previous=>previous.filter(id=>id!==request.request_id));}
 },[entryKey]);
 return {requests,waiting:requests.some(active),blocking:requests.length>0,checking,notice,refresh:scan,check:(request:PendingRoutingRequest)=>change(request,'check'),cancel:(request:PendingRoutingRequest)=>change(request,'cancel'),dismiss:(request:PendingRoutingRequest)=>change(request,'dismiss')};
}

type PendingState=PendingRoutingState;
export function RoutingPendingInputs({pending,connected}:{pending:PendingState;connected:boolean}){
 if(!pending.requests.length)return null;
 return <section className="mt-2.5 mb-3 grid gap-2.5" aria-label="입력 접수 상태">
  {pending.requests.map(request=>{
   const terminal=!active(request),busy=pending.checking.includes(request.request_id);
   const label=request.state==='cancelled'?'입력 접수가 취소되었습니다.':request.state==='failed'?'이번 입력은 접수되지 않았습니다.':request.state==='cancel_requested'?'입력 접수 취소를 확인하고 있습니다.':request.state==='unknown'?'저장된 요청의 접수 상태를 확인하고 있습니다.':'요청을 접수하고 있습니다.';
   return <article key={request.request_id} data-pending-request={request.request_id} data-pending-state={request.state} className="rounded-xl border border-line bg-inset px-4 py-3">
    <div className="flex items-center gap-2 text-ui" role="status">{terminal?<CircleAlert className="size-4"/>:<LoaderCircle className="size-4 animate-spin motion-reduce:animate-none"/>}<strong>{label}</strong></div>
    <p className="m-0 mt-1.5 text-caption leading-[1.65] text-ink-2">{terminal?'작성한 메시지를 유지했습니다. 입력을 다시 준비한 뒤 보낼 수 있습니다.':request.state==='cancel_requested'?'취소 상태와 이미 저장된 접수 결과를 함께 확인합니다.':'대상이 확인되면 이 대화에 작업을 연결합니다. 작성한 메시지는 보관하고 있습니다.'}</p>
    {pending.notice&&<p className="m-0 mt-1.5 text-caption leading-[1.65] text-ink">{pending.notice}</p>}
    <div className="mt-2.5 flex flex-wrap gap-3">
     <Button type="button" variant="ghost" size="sm" disabled={!connected||busy} onClick={()=>void pending.check(request)}><RefreshCw className="size-3"/>다시 확인</Button>
     {terminal?<Button type="button" variant="ghost" size="sm" disabled={!connected||busy} onClick={()=>void pending.dismiss(request)}>입력 다시 준비</Button>:<Button type="button" variant="ghost" size="sm" disabled={!connected||busy||!request.task_id} onClick={()=>void pending.cancel(request)} title={!request.task_id?'접수 연결을 확인하면 취소할 수 있습니다.':undefined}><Square className="size-3"/>{request.state==='cancel_requested'?'취소 다시 요청':'접수 취소'}</Button>}
    </div>
   </article>;
  })}
 </section>;
}

import type { RoutingEntry } from './routingTypes';

export class ConfirmedFailure extends Error {}

// A non-2xx host reply whose status code callers may branch on (e.g. events
// long-polls stop permanently on 4xx but retry transient 5xx/network faults).
export class HttpStatusError extends Error {
 constructor(public readonly status: number, message: string) {
  super(message);
  this.name = 'HttpStatusError';
 }
}

// Asynchronous disposition of a routing turn: the exact submission is validated
// and still unconfirmed or still running. This is never failed work, never a
// ConfirmedFailure, and never a reason to submit the same intent as a new task.
export class RoutingPending extends Error {
 constructor(public readonly request_id: string, public readonly entry: RoutingEntry, public readonly state: 'pending' | 'unknown', public readonly task_id?: string | null) {
  super(state === 'pending'
   ? '접수 결과를 아직 확인하지 못했습니다. 초안을 유지하고 같은 요청으로 다시 확인할 수 있습니다.'
   : '요청 접수 응답을 확인할 수 없습니다. 초안을 유지하고 같은 요청으로 다시 확인할 수 있습니다.');
  this.name = 'RoutingPending';
 }
}

// Confirmed terminal outcome of the exact routing request — observed on its SDK
// task with no canonical admission after a final receipt recheck. Unlike a
// validation failure it is not cleaned up: the original envelope keeps a
// terminal record until explicit dismissal.
export class RoutingTerminal extends ConfirmedFailure {
 constructor(public readonly request_id: string, public readonly entry: RoutingEntry, public readonly state: 'failed' | 'cancelled', public readonly task_id?: string | null, message?: string) {
  super(message ?? (state === 'cancelled'
   ? '요청이 취소로 끝났지만 요청을 접수하지 못했습니다. 모델과 요청을 확인한 뒤 다시 보내 주세요.'
   : '요청 처리가 실패로 끝났습니다. 모델과 요청 내용을 확인한 뒤 다시 보내 주세요.'));
  this.name = 'RoutingTerminal';
 }
}

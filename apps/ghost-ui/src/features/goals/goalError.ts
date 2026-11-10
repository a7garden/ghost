import { HostError } from '../../host/client';

/** Host messages are technical English; report only the category actually returned. */
export function goalError(error: unknown): string {
  if (error instanceof HostError) {
    switch (error.code) {
      case 'conflict': return '현재 상태에서는 변경할 수 없습니다. 목표와 이정표 상태를 확인해 주세요.';
      case 'not_found': return '변경할 목표나 이정표를 찾을 수 없습니다.';
      case 'forbidden': return '이 변경을 할 권한이 없습니다.';
      case 'unavailable': return '지금은 호스트가 변경을 처리할 수 없습니다. 나중에 다시 시도해 주세요.';
      case 'invalid': return '입력한 내용을 확인해 주세요.';
      case 'network': return '호스트에 연결하지 못했습니다. 연결 후 다시 시도해 주세요.';
    }
  }
  return '변경을 저장하지 못했습니다. 다시 시도해 주세요.';
}

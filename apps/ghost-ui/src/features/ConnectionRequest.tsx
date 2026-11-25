import { useState } from 'react';
import { Button, FormField, InlineError, Textarea } from '../ui';
import type { ConnectionService } from './connection-services';

/** The conversation receives only what the owner writes here, never the direct setup draft. */
export function ConnectionRequest({ service, mainName, initialDetail = '', onAssist, onClose, onSendingChange }: {
  service: ConnectionService; mainName: string; initialDetail?: string;
  onAssist(service: ConnectionService, detail: string): Promise<void>; onClose(): void; onSendingChange(sending: boolean): void;
}) {
  const [said, setSaid] = useState(initialDetail);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    if (sending || !said.trim()) return;
    setSending(true); onSendingChange(true); setError('');
    try { await onAssist(service, said); }
    catch (reason) {
      setError(reason instanceof Error ? `연결 요청을 보내지 못했습니다. ${reason.message}` : '연결 요청을 보내지 못했습니다.');
      setSending(false); onSendingChange(false);
    }
  };
  return <form className="setup-route__body" onSubmit={event => { event.preventDefault(); void send(); }}>
    <FormField label={`${mainName}에게 말하기`} description="연결할 계정과 필요한 권한만 적어 주세요. 비밀번호와 토큰은 보내지 마세요.">
      {control => <Textarea {...control} rows={2} value={said} disabled={sending} onChange={event => setSaid(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
        }}/>}
    </FormField>
    {error && <InlineError>{error}</InlineError>}
    <div className="setup-route__actions">
      <Button variant="ghost" type="button" disabled={sending} onClick={onClose}>취소</Button>
      <Button type="submit" disabled={sending || !said.trim()}>{sending ? '보내는 중…' : '연결 요청 보내기'}</Button>
    </div>
  </form>;
}

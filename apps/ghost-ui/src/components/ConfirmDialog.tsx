import { useState, type ReactNode } from 'react';
import { Button, InlineError } from '../ui';
import { Modal } from './Modal';

/**
 * The one confirmation for actions that widen a Ghost's power or cannot be taken back.
 * The body states the consequence in plain words; the confirm button names the action.
 * Failure keeps the dialog open with the reason, so the owner never wonders whether it happened.
 */
export function ConfirmDialog({ title, children, confirmLabel, tone = 'destructive', onConfirm, onClose }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: 'destructive' | 'default';
  onConfirm(): Promise<unknown> | void;
  onClose(): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    setPending(true); setError('');
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.');
    } finally {
      setPending(false);
    }
  };
  return <Modal title={title} onClose={() => { if (!pending) onClose(); }} className="sm:max-w-[440px]">
    <div className="grid gap-2 text-ink-2">{children}</div>
    {error && <InlineError>{error}</InlineError>}
    <div className="flex justify-end gap-2">
      <Button variant="outline" type="button" disabled={pending} onClick={onClose}>닫기</Button>
      <Button variant={tone === 'destructive' ? 'destructive' : 'default'} type="button" disabled={pending} onClick={() => void confirm()}>{confirmLabel}</Button>
    </div>
  </Modal>;
}

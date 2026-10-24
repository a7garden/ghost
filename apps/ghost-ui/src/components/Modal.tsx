import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, children, onClose, drawer = false, className = '' }: { title: string; children: ReactNode; onClose: () => void; drawer?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null), label = `dialog-${title.replaceAll(' ', '-')}`;
  // Close before React removes the dialog so native focus restoration can reach its opener.
  useLayoutEffect(() => { const el = ref.current!; el.showModal(); const focus = el.querySelector<HTMLElement>('input, textarea, select, [data-autofocus]'); focus?.focus(); return () => el.close(); }, []);
  return <dialog ref={ref} className={`${drawer ? 'drawer' : 'modal'} ${className}`} aria-labelledby={label} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <header className="modal-head"><h2 id={label}>{title}</h2><button className="icon-button" aria-label="닫기" onClick={onClose}><X size={19}/></button></header>
    {children}
  </dialog>;
}

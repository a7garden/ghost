import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, cn } from '@garden/ui';

/** Blocking task or side detail on Garden's Dialog; `drawer` docks it to the trailing edge. */
export function Modal({ title, children, onClose, drawer = false, className = '', focusClose = false }: { title: string; children: ReactNode; onClose: () => void; drawer?: boolean; className?: string; focusClose?: boolean }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent closeLabel="닫기" aria-describedby={undefined}
      onOpenAutoFocus={focusClose ? event => {
        event.preventDefault();
        (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-slot="dialog-close"]')?.focus();
      } : undefined}
      className={cn(drawer && 'top-0 right-0 left-auto h-dvh max-h-dvh w-full translate-x-0 translate-y-0 content-start rounded-none border-y-0 border-r-0 sm:max-w-[560px]', className)}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}

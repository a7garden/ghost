import { useState, type ReactNode } from 'react';
import { Button } from '@garden/ui';
import { Modal } from './Modal';

/** Secondary details kept out of the primary flow until asked for. */
export function DetailDialog({ title, label, children, className }: {
  title: string;
  label?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return <div className={className}>
    <Button variant="ghost" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      {label ?? title}
    </Button>
    {open && <Modal title={title} focusClose onClose={() => setOpen(false)}>
      <div className="grid gap-3 text-ui text-ink-2 [overflow-wrap:anywhere]">{children}</div>
    </Modal>}
  </div>;
}

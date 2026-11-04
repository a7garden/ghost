import { useState, type ReactNode } from 'react';
import { Modal } from './Modal';

export function DetailDialog({ title, label, children, className }: {
  title: string;
  label?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return <div className={className}>
    <button className="button secondary detail-trigger" type="button" aria-haspopup="dialog" onClick={event => { event.currentTarget.focus(); setOpen(true); }}>
      {label ?? title}
    </button>
    {open && <Modal title={title} className="detail-dialog" focusClose onClose={() => setOpen(false)}>
      <div className="detail-dialog-body">{children}</div>
    </Modal>}
  </div>;
}

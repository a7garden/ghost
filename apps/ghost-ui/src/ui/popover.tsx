// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Dialog, DialogContent, DialogTitle } from './dialog';
import { useCompact } from './adaptive';
import { cn } from './utils';

const CompactPopover = React.createContext(false);
function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const compact = useCompact();
  return <CompactPopover.Provider value={compact}>{compact ? <Dialog {...props}/> : <PopoverPrimitive.Root data-slot="popover" {...props}/>}</CompactPopover.Provider>;
}
function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const compact = React.useContext(CompactPopover);
  return compact ? <DialogPrimitive.Trigger {...props}/> : <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props}/>;
}
function PopoverContent({ className, align = 'center', sideOffset = 4, side, avoidCollisions, collisionPadding, sticky, hideWhenDetached, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const compact = React.useContext(CompactPopover);
  if (compact) {
    const { children, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onInteractOutside, onPointerDownOutside, 'aria-label': label } = props;
    return <DialogContent closeLabel="닫기" aria-describedby={undefined} className={className}
      onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus} onEscapeKeyDown={onEscapeKeyDown}
      onInteractOutside={onInteractOutside} onPointerDownOutside={onPointerDownOutside}>
      <DialogTitle className="sr-only">{label ?? '메뉴'}</DialogTitle>{children}
    </DialogContent>;
  }
  return <PopoverPrimitive.Portal><PopoverPrimitive.Content data-slot="popover-content" align={align} side={side} sideOffset={sideOffset}
    avoidCollisions={avoidCollisions} collisionPadding={collisionPadding ?? 8} sticky={sticky} hideWhenDetached={hideWhenDetached}
    className={cn('bg-raised text-ui text-ink data-[state=open]:animate-[pop-in_150ms_var(--ease-enter)] data-[state=closed]:animate-[fade-in_100ms_ease-in_reverse] z-50 w-72 max-w-[calc(100vw-1rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto [overflow-wrap:anywhere] origin-(--radix-popover-content-transform-origin) rounded-lg p-4 shadow-overlay outline-none', className)} {...props}/></PopoverPrimitive.Portal>;
}
function PopoverAnchor(props: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  const compact = React.useContext(CompactPopover);
  return compact ? <>{props.children}</> : <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props}/>;
}
export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };

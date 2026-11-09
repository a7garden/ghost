// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"

import { cn } from "./utils"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { MoreHorizontal } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "./dialog"
import { useTouch } from "./adaptive"

const TouchMenu = React.createContext(false)

/** Right-click (or long-press) menu for an element; text fields keep the system menu. */
function ContextMenu(props: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  const touch = useTouch()
  return <TouchMenu.Provider value={touch}>{touch ? <Dialog onOpenChange={props.onOpenChange}>{props.children}</Dialog> : <ContextMenuPrimitive.Root data-slot="context-menu" modal={false} {...props}/>}</TouchMenu.Provider>
}

function ContextMenuTrigger({ touchAction = "default", ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Trigger> & { touchAction?: "default" | "inline" }) {
  const touch = React.useContext(TouchMenu)
  if (touch) return <div className={cn("touch-context", touchAction === "inline" && "touch-context--inline")}>
    <div className="touch-context__body" onContextMenu={props.onContextMenu}>{props.children}</div>
    {touchAction === "default" && <ContextMenuAction/>}
  </div>
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

/** An explicit touch trigger placed in the content's own action row; fine pointers keep right-click. */
function ContextMenuAction() {
  const touch = React.useContext(TouchMenu)
  return touch ? <DialogPrimitive.Trigger className="touch-context__trigger" aria-label="더 보기"><MoreHorizontal size={18}/></DialogPrimitive.Trigger> : null
}

function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  const touch = React.useContext(TouchMenu)
  if (touch) return <DialogContent closeLabel="닫기" aria-describedby={undefined} className="ghost-touch-menu">
    <DialogTitle className="sr-only">{props['aria-label'] ?? '더 보기'}</DialogTitle>{props.children}
  </DialogContent>
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        collisionPadding={8}
        className={cn(
          "ghost-context-menu z-50 min-w-44 max-w-72 origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-card bg-raised p-1 text-ui text-ink shadow-overlay outline-none",
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({ className, icon, shortcut, children, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  icon?: React.ReactNode
  shortcut?: string
}) {
  const touch = React.useContext(TouchMenu)
  if (touch) return <DialogPrimitive.Close asChild><button type="button" className="ghost-touch-menu__item" disabled={props.disabled}
    onClick={event => props.onSelect?.(event.nativeEvent)}>{icon}<span>{children}</span></button></DialogPrimitive.Close>
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        "flex min-h-8 cursor-pointer select-none items-center gap-2.5 rounded-control px-2.5 text-ink outline-none data-[highlighted]:bg-hover-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:text-ink-2",
        className
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="ml-4 font-mono text-micro text-ink-3">{shortcut}</span>}
    </ContextMenuPrimitive.Item>
  )
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  const touch = React.useContext(TouchMenu)
  if (touch) return <hr className="my-1 border-line"/>
  return <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn("mx-1.5 my-1 h-px bg-line", className)} {...props} />
}

export { ContextMenu, ContextMenuAction, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger }

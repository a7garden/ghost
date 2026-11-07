// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"

import { cn } from "./utils"

/** Right-click (or long-press) menu for an element; text fields keep the system menu. */
function ContextMenu(props: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" modal={false} {...props} />
}

function ContextMenuTrigger(props: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
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
  return <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn("mx-1.5 my-1 h-px bg-line", className)} {...props} />
}

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger }

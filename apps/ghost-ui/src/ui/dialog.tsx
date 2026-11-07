// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "./utils"


const DialogModalContext = React.createContext(true)

function Dialog({ modal = true, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogModalContext.Provider value={modal}>
    <DialogPrimitive.Root data-slot="dialog" modal={modal} {...props} />
  </DialogModalContext.Provider>
}

function DialogPortal(
  props: React.ComponentProps<typeof DialogPrimitive.Portal>
) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-[fade-in_150ms_ease-out] data-[state=closed]:animate-[fade-in_100ms_ease-in_reverse] fixed inset-0 z-50 bg-[color-mix(in_srgb,var(--ghost-page)_55%,transparent)] backdrop-blur-[3px]",
        className
      )}
      {...props}
    />
  )
}

export type DialogContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & (
  | { showCloseButton?: true; closeLabel: string }
  | { showCloseButton: false; closeLabel?: never }
)

function DialogContent({
  className,
  children,
  showCloseButton = true,
  closeLabel,
  ...props
}: DialogContentProps) {
  const modal = React.useContext(DialogModalContext)
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        aria-modal={modal || undefined}
        className={cn(
          "bg-raised text-body text-ink data-[state=open]:animate-[pop-in_180ms_var(--ease-enter)] data-[state=closed]:animate-[pop-in_100ms_var(--ease-exit)_reverse] fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-5 overflow-y-auto overscroll-contain rounded-xl p-6 shadow-overlay sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
          className="text-ink-3 hover:bg-hover hover:text-ink absolute top-3 right-3 flex size-7 items-center justify-center rounded-control transition-colors outline-none disabled:pointer-events-none cursor-pointer"
          >
            <X className="size-4" />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pr-7", className)}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-headingSm font-semibold", className)}
      {...props}
    />
  )
}

export { Dialog, DialogContent, DialogHeader, DialogTitle }

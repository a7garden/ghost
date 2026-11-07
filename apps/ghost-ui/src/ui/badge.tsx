// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "./utils"


const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1 rounded-pill px-2 h-5 text-micro font-semibold w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 [&>svg]:pointer-events-none transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default: "bg-hover text-ink-2",
        success: "bg-green-tint text-green",
        warning: "bg-amber-tint text-amber-ink",
        danger: "bg-red-tint text-red",
        outline: "text-ink-3 shadow-[inset_0_0_0_1px_var(--ghost-line-strong)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }

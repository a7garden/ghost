// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "./utils"


const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control text-ui font-medium transition-[color,background-color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none active:scale-[0.97] cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/88",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "bg-surface text-ink shadow-btn hover:bg-hover hover:text-ink",
        secondary:
          "bg-hover text-ink hover:bg-hover-2",
        ghost: "text-ink-2 hover:bg-hover hover:text-ink",
        link: "text-signal-ink underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3.5 has-[>svg]:px-3",
        sm: "h-7 gap-1 px-2.5 rounded-chip text-caption has-[>svg]:px-2",
        lg: "h-10 px-5 rounded-control text-body has-[>svg]:px-4",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

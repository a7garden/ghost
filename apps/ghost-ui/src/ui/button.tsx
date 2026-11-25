// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { Plus } from "lucide-react"

import { cn } from "./utils"


const buttonVariants = cva(
  "group/btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control text-ui font-[550] tracking-[-0.003em] transition-[color,background-color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none active:translate-y-px active:shadow-none cursor-pointer pointer-coarse:min-h-11 pointer-coarse:min-w-11",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_color-mix(in_srgb,var(--ghost-primary-ink)_18%,transparent),0_1px_2px_rgba(16,18,24,.22)] hover:bg-primary/86 dark:shadow-none",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[inset_0_1px_0_rgba(255,255,255,.2),0_1px_2px_rgba(16,18,24,.2)] hover:bg-destructive/90 dark:shadow-none",
        outline:
          "bg-surface text-ink shadow-btn hover:bg-hover hover:text-ink",
        secondary:
          "bg-hover text-ink hover:bg-hover-2",
        ghost: "text-ink-2 hover:bg-hover hover:text-ink",
        // A row action that fills an empty slot (연결, 계정 추가): no container at rest;
        // the dashed slot fills in on hover. A connected row shows a check instead.
        add: "text-ink-2 hover:bg-hover hover:text-ink",
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

function SlotMark() {
  return (
    <span
      aria-hidden="true"
      className="-ml-0.5 mr-0.5 grid size-4 place-items-center rounded-full border border-dashed border-current/50 text-current transition-[background-color,border-color,color] duration-150 group-hover/btn:border-solid group-hover/btn:border-transparent group-hover/btn:bg-primary group-hover/btn:text-primary-foreground"
    >
      <Plus className="!size-2.5" strokeWidth={2.5} />
    </span>
  )
}

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
  const children = variant === "add" && !asChild
    ? <><SlotMark />{props.children}</>
    : props.children

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >{children}</Comp>
  )
}

export { Button, buttonVariants }

// App-owned UI. Retained-source notices: ./LICENSE.
import type * as React from "react"

import { cn } from "./utils"


function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-[shimmer-text_1.4s_linear_infinite] rounded-control bg-[linear-gradient(90deg,var(--ghost-stripe-bg),var(--ghost-stripe),var(--ghost-stripe-bg))] bg-[length:200%_100%]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }

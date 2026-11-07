// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"

import { cn } from "./utils"


function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "aria-invalid:border-red aria-invalid:ring-red/30 aria-invalid:ring-[2px] bg-field shadow-inset-field placeholder:text-ink-3 selection:bg-accent-tint selection:text-accent-ink flex field-sizing-content min-h-16 w-full rounded-control border border-transparent px-3 py-2 text-ui leading-relaxed text-ink transition-[color,box-shadow] outline-none focus:shadow-[inset_0_0_0_1.5px_var(--ghost-ink3)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }

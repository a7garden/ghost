// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"

import { cn } from "./utils"


function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex w-full flex-col items-center justify-center px-4 py-8 text-center",
        className
      )}
      {...props}
    >
      <div className="flex w-full max-w-72 min-w-0 flex-col items-center gap-1.5 [overflow-wrap:anywhere]">
        {icon && <div aria-hidden="true" className="mb-1 text-ink-3 [&_svg]:size-4">{icon}</div>}
        <div className="text-ui font-medium text-ink-2">
          {title}
        </div>
        {description && (
          <div className="text-caption text-ink-3">{description}</div>
        )}
        {action && (
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {action}
          </div>
        )}
      </div>
    </div>
  )
}

export { EmptyState }

// App-owned UI. Retained-source notices: ./LICENSE.
import type * as React from "react"

import { cn } from "./utils"


function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-[shimmer-text_1.4s_linear_infinite] motion-reduce:animate-none rounded-control bg-[linear-gradient(90deg,var(--ghost-stripe-bg),var(--ghost-stripe),var(--ghost-stripe-bg))] bg-[length:200%_100%]",
        className
      )}
      {...props}
    />
  )
}

const lineWidths = ["w-2/3", "w-full", "w-5/6", "w-1/2"] as const

/** Loading stand-in for running text or a form: bars of uneven length. `label` is what assistive tech announces. */
function SkeletonText({ label, lines = 3, className }: { label: string; lines?: number; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={cn("grid w-full content-start gap-2.5", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, index) => <Skeleton key={index} aria-hidden="true" className={cn("h-3.5", lineWidths[index % lineWidths.length])} />)}
    </div>
  )
}

/** Loading stand-in for a list: a leading mark and two lines per row. */
function SkeletonRows({ label, rows = 3, className }: { label: string; rows?: number; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={cn("grid w-full content-start gap-3.5", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex items-center gap-3">
          <Skeleton className="size-4 flex-none rounded-full" />
          <div className="grid min-w-0 flex-1 gap-2">
            <Skeleton className={cn("h-3", index % 2 ? "w-1/2" : "w-2/3")} />
            <Skeleton className={cn("h-3 opacity-70", index % 2 ? "w-1/3" : "w-1/2")} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Loading stand-in for a transcript: a reply, a short message from the owner, a reply. */
function SkeletonChat({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={cn("grid w-full content-start gap-6 py-6", className)}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="flex gap-3">
        <Skeleton className="size-6 flex-none rounded-full" />
        <div className="grid min-w-0 flex-1 gap-2"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3.5 w-1/2" /></div>
      </div>
      <Skeleton aria-hidden="true" className="h-9 w-2/5 justify-self-end rounded-xl" />
      <div aria-hidden="true" className="flex gap-3">
        <Skeleton className="size-6 flex-none rounded-full" />
        <div className="grid min-w-0 flex-1 gap-2"><Skeleton className="h-3.5 w-5/6" /><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-3.5 w-1/3" /></div>
      </div>
    </div>
  )
}

export { Skeleton, SkeletonChat, SkeletonRows, SkeletonText }

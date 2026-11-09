// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"
import { Info, OctagonAlert, TriangleAlert, X } from "lucide-react"

import { cn } from "./utils"
import { Button } from "./button"


type BannerVariant = "warning" | "danger" | "info"

export type BannerProps = React.ComponentProps<"div"> & {
  variant?: BannerVariant
  /** 우측 보조 액션 (예: "자세히") */
  action?: React.ReactNode
} & (
  | { onDismiss: () => void; dismissLabel: string }
  | { onDismiss?: undefined; dismissLabel?: never }
)

const VARIANT_CLASS: Record<
  BannerVariant,
  { surfaceClass: string; icon: typeof TriangleAlert }
> = {
  warning: { surfaceClass: "bg-amber-tint text-amber-ink", icon: TriangleAlert },
  danger: { surfaceClass: "bg-red-tint text-red", icon: OctagonAlert },
  info: { surfaceClass: "bg-hover text-ink-2", icon: Info },
}

function Banner({
  variant = "warning",
  onDismiss,
  dismissLabel,
  action,
  className,
  children,
  ...props
}: BannerProps) {
  const { surfaceClass, icon: Icon } = VARIANT_CLASS[variant]
  return (
    <div
      role={variant === "danger" ? "alert" : "status"}
      aria-live={variant === "danger" ? "assertive" : "polite"}
      data-slot="banner"
      data-variant={variant}
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-card p-3 text-ui",
        surfaceClass,
        className
      )}
      {...props}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 min-h-7 flex-1 basis-48 content-center whitespace-normal [overflow-wrap:anywhere]">{children}</span>
        {action && <div data-slot="banner-action" className="flex max-w-full shrink-0 items-center gap-2">{action}</div>}
      </div>
      {onDismiss && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="text-ink-2"
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

export { Banner }

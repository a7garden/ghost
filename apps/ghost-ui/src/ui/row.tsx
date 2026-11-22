// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "./utils"

export type RowProps = React.ComponentProps<"button"> & {
  /** `menu`: compact entry in a popup list. `item`: full-width list entry with leading/trailing content. */
  size?: "menu" | "item"
  asChild?: boolean
}

/**
 * A pressable list entry. State is read from `aria-pressed` (choice) or `aria-current` (location),
 * so callers express it once and the row styles it. Content layout stays with the feature.
 */
function Row({ size = "item", asChild = false, className, type, ...props }: RowProps) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      data-slot="row"
      data-size={size}
      type={asChild ? undefined : (type ?? "button")}
      className={cn("ghost-row", className)}
      {...props}
    />
  )
}

export { Row }

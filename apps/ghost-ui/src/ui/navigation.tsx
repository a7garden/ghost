// App-owned UI. Retained-source notices: ./LICENSE.
import type { ComponentProps } from "react"
import { Slot } from "@radix-ui/react-slot"
import { cn } from "./utils"

export interface NavigationProps extends ComponentProps<"nav"> {
  label: string
}

export function Navigation({ label, className, ...props }: NavigationProps) {
  return <nav aria-label={label} className={cn("ghost-navigation", className)} {...props} />
}

export interface NavigationGroupProps extends ComponentProps<"div"> {
  label: string
}

export function NavigationGroup({ label, children, className, ...props }: NavigationGroupProps) {
  return <div className={cn("ghost-navigation-group", className)} {...props}>
    <p className="ghost-navigation-group__label">{label}</p>
    <div className="ghost-navigation-group__items">{children}</div>
  </div>
}

export interface NavigationItemProps extends ComponentProps<"button"> {
  /** Use an anchor or router link child to preserve native link behavior. */
  asChild?: boolean
  current?: boolean
}

export function NavigationItem({ asChild = false, current = false, className, ...props }: NavigationItemProps) {
  const Component = asChild ? Slot : "button"
  return <Component {...(!asChild ? { type: "button" as const } : {})} aria-current={current ? "page" : undefined} className={cn("ghost-navigation-item", className)} {...props} />
}

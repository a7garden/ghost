// App-owned UI. Retained-source notices: ./LICENSE.
import type { ComponentProps, ReactNode } from "react"
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
  /** A small control beside the label (e.g. "new"); it stays with the label when the label sticks. */
  action?: ReactNode
}

export function NavigationGroup({ label, action, children, className, ...props }: NavigationGroupProps) {
  return <div className={cn("ghost-navigation-group", className)} {...props}>
    <div className="ghost-navigation-group__head"><p className="ghost-navigation-group__label">{label}</p>{action}</div>
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

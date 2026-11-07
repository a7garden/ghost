// App-owned UI. Retained-source notices: ./LICENSE.
import type { ComponentProps, ReactNode } from "react"
import { cn } from "./utils"

export interface PageProps extends ComponentProps<"div"> {
  
  width?: "content" | "reading" | "full"
}

export function Page({ width = "content", className, ...props }: PageProps) {
  return <div data-slot="page" data-width={width} className={cn("ghost-page", className)} {...props} />
}

export interface PageHeaderProps extends Omit<ComponentProps<"header">, "title"> {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}

export function PageHeader({ title, description, actions, className, children, ...props }: PageHeaderProps) {
  return <header data-slot="page-header" className={cn("ghost-page-header", className)} {...props}>
    <div className="ghost-page-header__copy">
      <h1 className="ghost-page-header__title">{title}</h1>
      {description && <p className="ghost-page-header__description">{description}</p>}
      {children}
    </div>
    {actions && <div className="ghost-page-header__actions">{actions}</div>}
  </header>
}

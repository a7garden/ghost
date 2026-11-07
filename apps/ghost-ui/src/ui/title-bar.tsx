// App-owned UI. Retained-source notices: ./LICENSE.
import type { CSSProperties, ReactNode } from "react"

export interface TitleBarProps {
  left?: ReactNode
  center?: ReactNode
  right?: ReactNode
  /** Extra leading room for native macOS traffic lights in an overlay titlebar. */
  macOSInset?: number
  /** Accessible identity for the window titlebar. */
  "aria-label"?: string
  className?: string
}

export function TitleBar({
  left,
  center,
  right,
  macOSInset = 0,
  className,
  "aria-label": ariaLabel,
}: TitleBarProps) {
  const style = { "--ghost-titlebar-macos-inset": `${macOSInset}px` } as CSSProperties

  return (
    <header
      className={["ghost-titlebar", className].filter(Boolean).join(" ")}
      style={style}
      aria-label={ariaLabel}
      data-tauri-drag-region
    >
      <div data-tauri-drag-region className="ghost-titlebar__slot ghost-titlebar__slot--left">{left}</div>
      <div data-tauri-drag-region className="ghost-titlebar__slot ghost-titlebar__slot--center">{center}</div>
      <div data-tauri-drag-region className="ghost-titlebar__slot ghost-titlebar__slot--right">{right}</div>
    </header>
  )
}

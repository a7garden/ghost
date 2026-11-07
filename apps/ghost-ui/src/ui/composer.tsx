// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"
import { ArrowUp } from "lucide-react"

import { Button } from "./button"
import { cn } from "./utils"

export interface ComposerProps {
  value: string
  onValueChange: (value: string) => void
  onSubmit: (value: string) => void
  /** Accessible name of the text field; visually carried by the placeholder and header. */
  label: string
  placeholder: string
  submitLabel: string
  inputId?: string
  disabled?: boolean
  pending?: boolean
  /** The addressed Ghost is generating: the surface carries a travelling signal edge. */
  running?: boolean
  /** Above the text: addressing and mode. */
  header?: React.ReactNode
  /** Between the text and the controls: fields a mode adds. */
  extension?: React.ReactNode
  footer?: React.ReactNode
  trailing?: React.ReactNode
  inputRef?: React.Ref<HTMLTextAreaElement>
  describedBy?: string
  className?: string
}

const MAX_HEIGHT = 240

/** Controlled, auto-growing message composer. The owner clears the draft after submission. */
export function Composer({
  value,
  onValueChange,
  onSubmit,
  label,
  placeholder,
  submitLabel,
  inputId,
  disabled = false,
  pending = false,
  running = false,
  header,
  extension,
  footer,
  trailing,
  inputRef,
  describedBy,
  className,
}: ComposerProps) {
  const generatedId = React.useId()
  const resolvedInputId = inputId ?? generatedId
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const canSubmit = value.trim().length > 0 && !disabled && !pending

  const setInputRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node
      if (typeof inputRef === "function") inputRef(node)
      else if (inputRef) inputRef.current = node
    },
    [inputRef],
  )

  const resize = React.useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    const contentHeight = textarea.scrollHeight
    textarea.style.height = `${Math.min(contentHeight, MAX_HEIGHT)}px`
    textarea.style.overflowY = contentHeight > MAX_HEIGHT ? "auto" : "hidden"
  }, [])

  React.useLayoutEffect(resize, [resize, value])

  React.useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    let previousWidth = textarea.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.getBoundingClientRect().width
      if (nextWidth === previousWidth) return
      previousWidth = nextWidth
      resize()
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [resize])

  const submit = () => {
    const trimmedValue = value.trim()
    if (!trimmedValue || disabled || pending) return
    onSubmit(trimmedValue)
  }

  return (
    <div data-slot="ghost-composer" data-running={running || undefined} aria-busy={pending || undefined} className={cn("ghost-composer", className)}>
      <label className="ghost-composer__label ghost-composer__label--visually-hidden" htmlFor={resolvedInputId}>{label}</label>
      <div className="ghost-composer__surface">
        {header}
        <textarea
          ref={setInputRef}
          id={resolvedInputId}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={placeholder}
          rows={1}
          disabled={disabled || pending}
          aria-describedby={describedBy}
          className="ghost-composer__textarea"
        />
        {extension}
        <div className="ghost-composer__footer">
          <div className="ghost-composer__footer-slot">{footer}</div>
          <div className="ghost-composer__footer-actions">
            {trailing}
            <Button type="button" size="icon" aria-label={submitLabel} title={submitLabel} disabled={!canSubmit} onClick={submit}
              className="size-[34px] rounded-pill disabled:opacity-100 disabled:bg-hover-2 disabled:text-ink-3">
              <ArrowUp aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

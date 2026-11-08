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
  /** Directly above the text: files on their way with the message. */
  tray?: React.ReactNode
  /** Between the text and the controls: fields a mode adds. */
  extension?: React.ReactNode
  /** Bottom-left: the + menu (attach, assign, send later). */
  leading?: React.ReactNode
  footer?: React.ReactNode
  /** Bottom-right before send: model choice, cancel. */
  trailing?: React.ReactNode
  /** Files dropped on or pasted into the composer. */
  onFiles?: (files: File[]) => void
  /** Runs before the composer's own keys; `preventDefault()` keeps Enter from sending (e.g. to pick a suggestion). */
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  /** Combobox wiring for the text field while suggestions float above it. */
  inputAria?: Pick<React.AriaAttributes, "aria-expanded" | "aria-controls" | "aria-activedescendant" | "aria-autocomplete"> & { role?: "combobox" }
  /** Floats just above the composer: suggestions for what is being typed. */
  above?: React.ReactNode
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
  tray,
  extension,
  leading,
  footer,
  trailing,
  onFiles,
  onKeyDown,
  inputAria,
  above,
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

  const [dragging, setDragging] = React.useState(false)
  const dragDepth = React.useRef(0)
  const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files")
  const dropHandlers = onFiles && !disabled ? {
    onDragEnter: (event: React.DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth.current += 1; setDragging(true) },
    onDragOver: (event: React.DragEvent) => { if (hasFiles(event)) event.preventDefault() },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false) },
    onDrop: (event: React.DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault(); dragDepth.current = 0; setDragging(false)
      const files = Array.from(event.dataTransfer.files)
      if (files.length) onFiles(files)
    },
  } : {}

  return (
    <div data-slot="ghost-composer" data-running={running || undefined} data-dragging={dragging || undefined} aria-busy={pending || undefined} className={cn("ghost-composer", className)} {...dropHandlers}>
      {above}
      <label className="ghost-composer__label ghost-composer__label--visually-hidden" htmlFor={resolvedInputId}>{label}</label>
      <div className="ghost-composer__surface">
        {header}
        {tray}
        <textarea
          ref={setInputRef}
          id={resolvedInputId}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            if (event.defaultPrevented) return
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault()
              submit()
            }
          }}
          onPaste={onFiles ? (event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length) { event.preventDefault(); onFiles(files) }
          } : undefined}
          placeholder={placeholder}
          rows={1}
          disabled={disabled || pending}
          aria-describedby={describedBy}
          {...inputAria}
          className="ghost-composer__textarea"
        />
        {extension}
        <div className="ghost-composer__footer">
          {leading}
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

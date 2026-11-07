// App-owned UI. Retained-source notices: ./LICENSE.
import * as React from "react"
import { ArrowDown, ChevronRight } from "lucide-react"

import { Button } from "./button"
import { cn } from "./utils"

export interface ConversationProps {
  label: string
  transcriptLabel: string
  children: React.ReactNode
  header?: React.ReactNode
  /** Floats over the top of the transcript (identity, threads); the transcript scrolls beneath it. */
  overlay?: React.ReactNode
  composer: React.ReactNode
  footer?: React.ReactNode
  className?: string
  scrollKey?: string | number
  /** Changing it means the owner just acted (sent a message): follow the latest again wherever the view was. */
  followKey?: string | number
  jumpToLatestLabel: string
}

/** Extra article props (ref, handlers) let a context menu trigger wrap the message with `asChild`. */
export interface ConversationMessageProps extends Omit<React.ComponentProps<"article">, "role" | "children"> {
  role: "user" | "assistant"
  label: string
  children: React.ReactNode
  actions?: React.ReactNode
  className?: string
}

export interface ConversationActivityProps {
  summary: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  className?: string
}

const BOTTOM_THRESHOLD = 48

/** A local scrolling conversation frame with a fixed composer dock. */
export function Conversation({
  label,
  transcriptLabel,
  children,
  header,
  overlay,
  composer,
  footer,
  className,
  scrollKey,
  followKey,
  jumpToLatestLabel,
}: ConversationProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const hasMountedRef = React.useRef(false)
  const nearBottomRef = React.useRef(true)
  const preserveDisclosurePositionRef = React.useRef(false)
  const [showJumpToLatest, setShowJumpToLatest] = React.useState(false)

  const jumpToLatest = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    nearBottomRef.current = true
    setShowJumpToLatest(false)
  }, [])

  React.useLayoutEffect(() => {
    if (!hasMountedRef.current || nearBottomRef.current) {
      jumpToLatest()
    } else {
      setShowJumpToLatest(true)
    }
    hasMountedRef.current = true
  }, [jumpToLatest, scrollKey])

  React.useLayoutEffect(() => {
    if (followKey === undefined) return
    jumpToLatest()
  }, [jumpToLatest, followKey])

  React.useEffect(() => {
    const content = contentRef.current
    if (!content) return

    const observer = new ResizeObserver(() => {
      // Opening a tool disclosure is a reading action, even at the latest turn.
      // Preserve its summary instead of following newly revealed content down.
      if (preserveDisclosurePositionRef.current) {
        preserveDisclosurePositionRef.current = false
        const viewport = viewportRef.current
        if (viewport) {
          nearBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD
          setShowJumpToLatest(!nearBottomRef.current)
        }
        return
      }
      if (nearBottomRef.current) jumpToLatest()
    })
    observer.observe(content)
    if (viewportRef.current) observer.observe(viewportRef.current)
    return () => observer.disconnect()
  }, [jumpToLatest])

  // Layout shifts (a disclosure folding, reasoning collapsing into its summary, scroll anchoring) also fire
  // scroll events. Only scrolling the owner did recently may stop following the latest turn.
  const lastUserScrollRef = React.useRef(0)
  const pointerHeldRef = React.useRef(false)
  const markUserScroll = React.useCallback(() => { lastUserScrollRef.current = Date.now() }, [])
  // A held pointer (scrollbar thumb drag) keeps counting as the owner's scrolling until release.
  const holdPointer = React.useCallback(() => {
    pointerHeldRef.current = true
    markUserScroll()
    const release = () => { pointerHeldRef.current = false; markUserScroll(); window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release) }
    window.addEventListener("pointerup", release)
    window.addEventListener("pointercancel", release)
  }, [markUserScroll])
  const handleTranscriptScroll = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD
    if (!isNearBottom && nearBottomRef.current && !pointerHeldRef.current && Date.now() - lastUserScrollRef.current > 800) {
      jumpToLatest()
      return
    }
    nearBottomRef.current = isNearBottom
    setShowJumpToLatest(!isNearBottom)
  }, [jumpToLatest])

  return (
    <section
      data-slot="ghost-conversation"
      aria-label={label}
      className={cn("ghost-conversation", className)}
    >
      {header != null && (
        <header className="ghost-conversation__header">
          <div className="ghost-conversation__column">{header}</div>
        </header>
      )}

      <div className="ghost-conversation__transcript-frame" data-overlay={overlay != null || undefined}>
        {overlay != null && <div className="ghost-conversation__overlay">{overlay}</div>}
        <div
          ref={viewportRef}
          className="ghost-conversation__transcript"
          role="region"
          aria-label={transcriptLabel}
          tabIndex={0}
          onScroll={handleTranscriptScroll}
          onWheel={markUserScroll}
          onTouchMove={markUserScroll}
          onPointerDown={holdPointer}
          onKeyDown={markUserScroll}
          onClickCapture={(event) => {
            if (event.target instanceof Element && event.target.closest("summary")) {
              preserveDisclosurePositionRef.current = true
            }
          }}
        >
          <div ref={contentRef} className="ghost-conversation__column ghost-conversation__transcript-content">
            <div className="ghost-conversation__messages">{children}</div>
          </div>
        </div>
        {showJumpToLatest && (
          <Button
            type="button"
            variant="secondary"
            className="ghost-conversation__jump"
            onClick={() => {
              jumpToLatest()
              viewportRef.current?.focus({ preventScroll: true })
            }}
          >
            <ArrowDown aria-hidden="true" />
            {jumpToLatestLabel}
          </Button>
        )}
      </div>

      <div className="ghost-conversation__dock">
        <div className="ghost-conversation__column">
          {composer}
          {footer != null && <div className="ghost-conversation__footer">{footer}</div>}
        </div>
      </div>
    </section>
  )
}

/** A speaker-labelled article in the conversation transcript. */
export function ConversationMessage({
  role,
  label,
  children,
  actions,
  className,
  ...rest
}: ConversationMessageProps) {
  return (
    <article
      {...rest}
      data-slot="ghost-conversation-message"
      data-role={role}
      aria-label={label}
      className={cn("ghost-conversation-message", className)}
    >
      <div className="ghost-conversation-message__content">{children}</div>
      {actions != null && <div className="ghost-conversation-message__actions">{actions}</div>}
    </article>
  )
}

/** A native disclosure for collapsible activity or supporting details. */
export function ConversationActivity({
  summary,
  children,
  defaultOpen = false,
  className,
}: ConversationActivityProps) {
  return (
    <details
      data-slot="ghost-conversation-activity"
      className={cn("ghost-conversation-activity", className)}
      open={defaultOpen}
    >
      <summary className="ghost-conversation-activity__summary">
        <ChevronRight aria-hidden="true" className="ghost-conversation-activity__chevron" />
        <span>{summary}</span>
      </summary>
      <div className="ghost-conversation-activity__content">{children}</div>
    </details>
  )
}

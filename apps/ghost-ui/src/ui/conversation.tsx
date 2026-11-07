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
  composer: React.ReactNode
  footer?: React.ReactNode
  className?: string
  scrollKey?: string | number
  jumpToLatestLabel: string
}

export interface ConversationMessageProps {
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
  composer,
  footer,
  className,
  scrollKey,
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

  const handleTranscriptScroll = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD
    nearBottomRef.current = isNearBottom
    setShowJumpToLatest(!isNearBottom)
  }, [])

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

      <div className="ghost-conversation__transcript-frame">
        <div
          ref={viewportRef}
          className="ghost-conversation__transcript"
          role="region"
          aria-label={transcriptLabel}
          tabIndex={0}
          onScroll={handleTranscriptScroll}
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
}: ConversationMessageProps) {
  return (
    <article
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

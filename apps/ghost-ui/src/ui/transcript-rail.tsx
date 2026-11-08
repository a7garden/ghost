// App-owned UI.
import * as React from "react"

/** A landmark in the transcript: any element carrying `data-rail` (kind), `data-rail-label` and optionally `data-rail-tone`. */
interface Landmark { y: number; ratio: number; kind: string; tone: string | undefined; label: string }

const MIN_THUMB = 28
const ACTIVE_MS = 900
/** How long after a wheel, key or touch a scroll still counts as the owner's. */
const INTENT_MS = 600

/**
 * The conversation's scrollbar, redrawn as a map of the conversation: a hairline thumb for the
 * view and a tick for every landmark — the owner's turns, threads that branched off, Work that
 * came back in its state color. Hover a tick for what it is, click to go there, drag anywhere to
 * scrub. It appears with the pointer or while scrolling and is gone otherwise. Pointer-only:
 * keyboard and touch keep native scrolling on the transcript itself.
 */
export function TranscriptRail({ viewportRef, contentRef, onScrub }: {
  viewportRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  /** Called when the owner moves the view from the rail, so following the latest turn stops. */
  onScrub(): void
}) {
  const railRef = React.useRef<HTMLDivElement>(null)
  const thumbRef = React.useRef<HTMLDivElement>(null)
  const [landmarks, setLandmarks] = React.useState<Landmark[]>([])
  const [scrollable, setScrollable] = React.useState(false)
  const [hovered, setHovered] = React.useState<number | null>(null)

  /** Thumb geometry in rail pixels: the view's share of the conversation and where it sits. */
  const geometry = React.useCallback(() => {
    const viewport = viewportRef.current
    const rail = railRef.current
    if (!viewport || !rail) return null
    const span = rail.clientHeight
    const total = viewport.scrollHeight
    const view = viewport.clientHeight
    const height = Math.min(span, Math.max(MIN_THUMB, (view / total) * span))
    const travel = Math.max(1, total - view)
    return { span, height, travel, top: (viewport.scrollTop / travel) * (span - height) }
  }, [viewportRef])

  const placeThumb = React.useCallback(() => {
    const thumb = thumbRef.current
    const shape = geometry()
    if (!thumb || !shape) return
    thumb.style.height = `${shape.height}px`
    thumb.style.transform = `translateY(${shape.top}px)`
  }, [geometry])

  React.useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    let frame = 0
    let idle: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      frame = 0
      const total = viewport.scrollHeight
      const canScroll = total > viewport.clientHeight + 1
      setScrollable(canScroll)
      if (!canScroll) { setLandmarks([]); return }
      const origin = viewport.getBoundingClientRect().top - viewport.scrollTop
      const next: Landmark[] = []
      for (const element of content.querySelectorAll<HTMLElement>("[data-rail]")) {
        const rect = element.getBoundingClientRect()
        const y = rect.top - origin
        next.push({ y, ratio: Math.min(1, (y + Math.min(rect.height, 40) / 2) / total), kind: element.dataset.rail ?? "", tone: element.dataset.railTone, label: element.dataset.railLabel ?? "" })
      }
      setLandmarks(current => current.length === next.length && current.every((mark, index) => mark.ratio === next[index]!.ratio && mark.tone === next[index]!.tone && mark.label === next[index]!.label) ? current : next)
      placeThumb()
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    // Only the owner's own scrolling wakes the rail; following the latest reply stays silent.
    let intent = 0
    const markIntent = () => { intent = Date.now() }
    const onScroll = () => {
      placeThumb()
      const rail = railRef.current
      if (!rail || Date.now() - intent > INTENT_MS) return
      rail.dataset.active = ""
      clearTimeout(idle)
      idle = setTimeout(() => { delete rail.dataset.active }, ACTIVE_MS)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(content)
    resize.observe(viewport)
    const mutations = new MutationObserver(schedule)
    mutations.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-rail", "data-rail-tone", "data-rail-label"] })
    viewport.addEventListener("scroll", onScroll, { passive: true })
    for (const type of ["wheel", "touchmove", "keydown"] as const) viewport.addEventListener(type, markIntent, { passive: true })
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(idle)
      resize.disconnect()
      mutations.disconnect()
      viewport.removeEventListener("scroll", onScroll)
      for (const type of ["wheel", "touchmove", "keydown"] as const) viewport.removeEventListener(type, markIntent)
    }
  }, [viewportRef, contentRef, placeThumb])

  // The thumb is measured against the rail, which has no height until it is shown.
  React.useLayoutEffect(() => { if (scrollable) placeThumb() }, [scrollable, placeThumb])

  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    const rail = railRef.current
    const shape = geometry()
    if (event.button !== 0 || !viewport || !rail || !shape) return
    event.preventDefault()
    rail.setPointerCapture(event.pointerId)
    rail.dataset.dragging = ""
    onScrub()
    const railTop = rail.getBoundingClientRect().top
    const at = event.clientY - railTop
    // Grabbing the thumb keeps the grip point under the pointer; anywhere else centres the view there.
    const grip = at >= shape.top && at <= shape.top + shape.height ? at - shape.top : shape.height / 2
    const move = (clientY: number) => {
      const room = Math.max(1, shape.span - shape.height)
      viewport.scrollTop = Math.min(1, Math.max(0, (clientY - railTop - grip) / room)) * (viewport.scrollHeight - viewport.clientHeight)
    }
    move(event.clientY)
    const onMove = (next: PointerEvent) => { onScrub(); move(next.clientY) }
    const release = () => {
      delete rail.dataset.dragging
      rail.removeEventListener("pointermove", onMove)
      rail.removeEventListener("pointerup", release)
      rail.removeEventListener("pointercancel", release)
    }
    rail.addEventListener("pointermove", onMove)
    rail.addEventListener("pointerup", release)
    rail.addEventListener("pointercancel", release)
  }

  const go = (mark: Landmark) => {
    onScrub()
    viewportRef.current?.scrollTo({ top: Math.max(0, mark.y - 56), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }

  const label = hovered !== null ? landmarks[hovered] : undefined
  return (
    <div ref={railRef} className="ghost-rail" aria-hidden="true" hidden={!scrollable} onPointerDown={scrub} onPointerLeave={() => setHovered(null)}>
      <div ref={thumbRef} className="ghost-rail__thumb" />
      {landmarks.map((mark, index) => (
        <span key={index} className="ghost-rail__mark" data-kind={mark.kind} data-tone={mark.tone} style={{ top: `${mark.ratio * 100}%` }}
          onPointerEnter={() => setHovered(index)} onPointerLeave={() => setHovered(null)}
          onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation(); event.preventDefault(); go(mark) }} />
      ))}
      {label?.label && <span key={hovered} className="ghost-rail__label" data-tone={label.tone} style={{ top: `${label.ratio * 100}%` }}>{label.label}</span>}
    </div>
  )
}

// App-owned UI.
import * as React from "react"
import { createPortal } from "react-dom"

type Axis = "y" | "x"

/** A landmark in the transcript: any element carrying `data-rail` (kind), `data-rail-label` and optionally `data-rail-tone`. */
interface Landmark { y: number; ratio: number; kind: string; tone: string | undefined; label: string }

const MIN_THUMB = 28
const ACTIVE_MS = 900
/** How long after a wheel, key or touch a scroll still counts as the owner's. */
const INTENT_MS = 600
/** Gap between a floating rail and the ends of the edge it sits on. */
const INSET = 4
const FINE_POINTER = "(hover: hover) and (pointer: fine)"

/** The owner's last wheel, key or touch anywhere in the window, shared by every rail. */
let intent: { at: number; target: EventTarget | null } = { at: 0, target: null }
let watchingIntent = false
function watchIntent() {
  if (watchingIntent) return
  watchingIntent = true
  const mark = (event: Event) => { intent = { at: Date.now(), target: event.target } }
  for (const type of ["wheel", "touchmove", "keydown"]) document.addEventListener(type, mark, { capture: true, passive: true })
}

/** Whether a scroll of `viewport` follows the owner's own wheel, key or touch on it or on a rail, rather than an auto-follow. */
function ownerMoved(viewport: HTMLElement) {
  const { at, target } = intent
  if (Date.now() - at > INTENT_MS || !(target instanceof Node)) return false
  if (target === document.body || target === document.documentElement || viewport.contains(target)) return true
  return target instanceof Element && target.closest(".ghost-rail") !== null
}

function scrolls(element: Element, axis: Axis) {
  const style = getComputedStyle(element)
  const overflow = axis === "y" ? style.overflowY : style.overflowX
  if (overflow !== "auto" && overflow !== "scroll") return false
  return axis === "y" ? element.scrollHeight > element.clientHeight + 1 : element.scrollWidth > element.clientWidth + 1
}

/** The scroller a wheel on `start` moves along `axis`: `start` itself or its nearest ancestor that can scroll that way. */
function scrollerFor(start: Element | null, axis: Axis): HTMLElement | null {
  for (let element = start; element && element !== document.body; element = element.parentElement) {
    if (element instanceof HTMLElement && scrolls(element, axis)) return element
  }
  return null
}

/** Ancestors that clip what they contain; a floating rail stays inside all of them. */
function clippingAncestors(element: HTMLElement) {
  const clips: HTMLElement[] = []
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (style.overflowX !== "visible" || style.overflowY !== "visible") clips.push(parent)
  }
  return clips
}

export interface ScrollRailProps {
  viewportRef: React.RefObject<HTMLElement | null>
  /** Where `data-rail` landmarks live; without it the rail is a bare thumb. */
  contentRef?: React.RefObject<HTMLElement | null>
  /** Called when the owner moves the view from the rail, e.g. so a transcript stops following its latest turn. */
  onScrub?(): void
  axis?: Axis
  /** Set by ScrollRails: drawn on the scroller's edge from the page's top layer; `hover` while the pointer is on the scroller, `wake` bumps on the owner's scrolling. */
  floating?: { hover: boolean; wake: number }
}

/**
 * The app's scrollbar, redrawn as a map of what it scrolls: a hairline thumb for the view and a
 * tick for every landmark inside — in the conversation the owner's turns, threads that branched
 * off and Work that came back; in the sidebar the Ghosts that are working or need the owner.
 * Hover a tick for what it is, click to go there, drag anywhere to scrub, wheel over it to
 * scroll. It appears with the pointer or the owner's own scrolling and is gone otherwise.
 * A rail placed here claims its viewport; ScrollRails covers every other scroller.
 * Pointer-only: keyboard and touch keep native scrolling on the scroller itself.
 */
export function ScrollRail({ viewportRef, contentRef, onScrub, axis = "y", floating }: ScrollRailProps) {
  const railRef = React.useRef<HTMLDivElement>(null)
  const thumbRef = React.useRef<HTMLDivElement>(null)
  const idleRef = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const clipsRef = React.useRef<HTMLElement[]>([])
  const measureRef = React.useRef<() => void>(undefined)
  const [landmarks, setLandmarks] = React.useState<Landmark[]>([])
  const [scrollable, setScrollable] = React.useState(false)
  const [hovered, setHovered] = React.useState<number | null>(null)
  const vertical = axis === "y"
  const isFloating = floating !== undefined

  /** Thumb geometry in rail pixels: the view's share of the content and where it sits. */
  const geometry = React.useCallback(() => {
    const viewport = viewportRef.current
    const rail = railRef.current
    if (!viewport || !rail) return null
    const span = vertical ? rail.clientHeight : rail.clientWidth
    const total = vertical ? viewport.scrollHeight : viewport.scrollWidth
    const view = vertical ? viewport.clientHeight : viewport.clientWidth
    const offset = vertical ? viewport.scrollTop : viewport.scrollLeft
    const size = Math.min(span, Math.max(MIN_THUMB, (view / total) * span))
    const travel = Math.max(1, total - view)
    return { span, size, start: (offset / travel) * (span - size) }
  }, [viewportRef, vertical])

  const placeThumb = React.useCallback(() => {
    const thumb = thumbRef.current
    const shape = geometry()
    if (!thumb || !shape) return
    if (vertical) {
      thumb.style.height = `${shape.size}px`
      thumb.style.transform = `translateY(${shape.start}px)`
    } else {
      thumb.style.width = `${shape.size}px`
      thumb.style.transform = `translateX(${shape.start}px)`
    }
  }, [geometry, vertical])

  /** A floating rail sits on its scroller's trailing edge, cut to whatever clips the scroller. */
  const placeRail = React.useCallback(() => {
    const viewport = viewportRef.current
    const rail = railRef.current
    if (!isFloating || !viewport || !rail) return
    let top = 0, left = 0, bottom = window.innerHeight, right = window.innerWidth
    for (const element of [viewport, ...clipsRef.current]) {
      const box = element.getBoundingClientRect()
      top = Math.max(top, box.top)
      left = Math.max(left, box.left)
      bottom = Math.min(bottom, box.bottom)
      right = Math.min(right, box.right)
    }
    const length = (vertical ? bottom - top : right - left) - INSET * 2
    rail.style.visibility = length < MIN_THUMB ? "hidden" : ""
    if (vertical) {
      rail.style.top = `${top + INSET}px`
      rail.style.height = `${Math.max(0, length)}px`
      rail.style.left = `${right - rail.offsetWidth - 1}px`
    } else {
      rail.style.left = `${left + INSET}px`
      rail.style.width = `${Math.max(0, length)}px`
      rail.style.top = `${bottom - rail.offsetHeight - 1}px`
    }
  }, [viewportRef, isFloating, vertical])

  const wake = React.useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    rail.dataset.active = ""
    clearTimeout(idleRef.current)
    idleRef.current = setTimeout(() => { delete rail.dataset.active }, ACTIVE_MS)
  }, [])

  React.useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef?.current
    const rail = railRef.current
    if (!viewport || !rail) return
    watchIntent()
    if (!isFloating) viewport.dataset.scrollRail = axis
    clipsRef.current = isFloating ? clippingAncestors(viewport) : []
    let frame = 0
    let place = 0
    let last = vertical ? viewport.scrollTop : viewport.scrollLeft
    const measure = () => {
      frame = 0
      const canScroll = vertical ? viewport.scrollHeight > viewport.clientHeight + 1 : viewport.scrollWidth > viewport.clientWidth + 1
      setScrollable(canScroll)
      if (!canScroll) { setLandmarks(current => current.length ? [] : current); return }
      if (content && vertical) {
        const total = viewport.scrollHeight
        const origin = viewport.getBoundingClientRect().top - viewport.scrollTop
        const next: Landmark[] = []
        for (const element of content.querySelectorAll<HTMLElement>("[data-rail]")) {
          const box = element.getBoundingClientRect()
          const y = box.top - origin
          next.push({ y, ratio: Math.min(1, (y + Math.min(box.height, 40) / 2) / total), kind: element.dataset.rail ?? "", tone: element.dataset.railTone, label: element.dataset.railLabel ?? "" })
        }
        setLandmarks(current => current.length === next.length && current.every((mark, index) => mark.ratio === next[index]!.ratio && mark.tone === next[index]!.tone && mark.label === next[index]!.label) ? current : next)
      }
      placeRail()
      placeThumb()
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    measureRef.current = schedule
    // Only the owner's own scrolling wakes the rail; following the latest reply stays silent.
    const onScroll = () => {
      placeThumb()
      const position = vertical ? viewport.scrollTop : viewport.scrollLeft
      if (position === last) return
      last = position
      if (ownerMoved(viewport)) wake()
    }
    // A wheel over the rail scrolls what is under it, as it would over a native scrollbar.
    const onWheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
      const down = scrollerFor(viewport, "y")
      const across = scrollerFor(viewport, "x")
      if (!down && !across) return
      event.preventDefault()
      onScrub?.()
      down?.scrollBy({ top: event.deltaY * unit })
      across?.scrollBy({ left: event.deltaX * unit })
    }
    // Floating rails follow their scroller when anything around it scrolls or the window resizes.
    const onMoved = () => { if (!place) place = requestAnimationFrame(() => { place = 0; placeRail(); placeThumb() }) }
    const resize = new ResizeObserver(schedule)
    resize.observe(viewport)
    if (content) resize.observe(content)
    const mutations = content ? new MutationObserver(schedule) : undefined
    mutations?.observe(content!, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-rail", "data-rail-tone", "data-rail-label"] })
    viewport.addEventListener("scroll", onScroll, { passive: true })
    rail.addEventListener("wheel", onWheel, { passive: false })
    if (isFloating) {
      window.addEventListener("scroll", onMoved, { capture: true, passive: true })
      window.addEventListener("resize", onMoved)
    }
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(place)
      clearTimeout(idleRef.current)
      measureRef.current = undefined
      resize.disconnect()
      mutations?.disconnect()
      viewport.removeEventListener("scroll", onScroll)
      rail.removeEventListener("wheel", onWheel)
      window.removeEventListener("scroll", onMoved, { capture: true })
      window.removeEventListener("resize", onMoved)
      if (!isFloating) delete viewport.dataset.scrollRail
    }
  }, [viewportRef, contentRef, axis, vertical, isFloating, placeRail, placeThumb, wake, onScrub])

  // The rail is measured against itself, which has no size until it is shown.
  React.useLayoutEffect(() => { if (scrollable) { placeRail(); placeThumb() } }, [scrollable, placeRail, placeThumb])
  // A floating rail re-reads its scroller each time it is shown; content may have changed while it was away.
  const hover = floating?.hover ?? false
  const wakes = floating?.wake ?? 0
  React.useLayoutEffect(() => { if (hover) measureRef.current?.() }, [hover])
  React.useEffect(() => { if (wakes) { measureRef.current?.(); wake() } }, [wakes, wake])

  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    const rail = railRef.current
    const shape = geometry()
    if (event.button !== 0 || !viewport || !rail || !shape) return
    event.preventDefault()
    // A rail drawn over a popover or dialog must not read as a press outside it.
    event.stopPropagation()
    rail.setPointerCapture(event.pointerId)
    rail.dataset.dragging = ""
    onScrub?.()
    const box = rail.getBoundingClientRect()
    const along = (point: { clientX: number; clientY: number }) => vertical ? point.clientY - box.top : point.clientX - box.left
    const at = along(event)
    // Grabbing the thumb keeps the grip point under the pointer; anywhere else centres the view there.
    const grip = at >= shape.start && at <= shape.start + shape.size ? at - shape.start : shape.size / 2
    const move = (point: { clientX: number; clientY: number }) => {
      const ratio = Math.min(1, Math.max(0, (along(point) - grip) / Math.max(1, shape.span - shape.size)))
      if (vertical) viewport.scrollTop = ratio * (viewport.scrollHeight - viewport.clientHeight)
      else viewport.scrollLeft = ratio * (viewport.scrollWidth - viewport.clientWidth)
    }
    move(event)
    const onMove = (next: PointerEvent) => { onScrub?.(); move(next) }
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
    onScrub?.()
    const viewport = viewportRef.current
    viewport?.scrollTo({ top: Math.max(0, mark.y - viewport.clientHeight / 3), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }

  const label = hovered !== null ? landmarks[hovered] : undefined
  return (
    <div ref={railRef} className="ghost-rail" aria-hidden="true" hidden={!scrollable} data-axis={axis} data-floating={isFloating || undefined} data-hover={hover || undefined}
      onPointerDown={scrub} onPointerLeave={() => setHovered(null)}>
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

interface Slot { element: HTMLElement; hover: boolean; wake: number }
type Slots = Record<Axis, Slot | null>

const slotIds = new WeakMap<HTMLElement, number>()
let nextSlotId = 0
function slotId(element: HTMLElement) {
  let id = slotIds.get(element)
  if (id === undefined) slotIds.set(element, id = ++nextSlotId)
  return id
}

/** The scroller under the pointer for `axis`, unless a placed ScrollRail already owns it. */
function unclaimedScroller(start: Element | null, axis: Axis) {
  const element = scrollerFor(start, axis)
  return element && element.dataset.scrollRail !== axis ? element : null
}

function hovering(slot: Slot | null, element: HTMLElement | null): Slot | null {
  if (!element) return slot?.element.isConnected ? (slot.hover ? { ...slot, hover: false } : slot) : null
  if (slot?.element === element) return slot.hover ? slot : { ...slot, hover: true }
  return { element, hover: true, wake: 0 }
}

function woken(slot: Slot | null, element: HTMLElement): Slot {
  return slot?.element === element ? { ...slot, wake: slot.wake + 1 } : { element, hover: false, wake: 1 }
}

function FloatingRail({ slot, axis }: { slot: Slot; axis: Axis }) {
  const viewportRef = React.useMemo(() => ({ current: slot.element }), [slot.element])
  return <ScrollRail viewportRef={viewportRef} axis={axis} floating={{ hover: slot.hover, wake: slot.wake }} />
}

/**
 * Native scrollbars are hidden on fine pointers; this draws a ScrollRail over whichever other
 * scroller the pointer is on or the owner just scrolled, one per axis. Mount once per window.
 */
export function ScrollRails() {
  const [slots, setSlots] = React.useState<Slots>({ y: null, x: null })

  React.useEffect(() => {
    watchIntent()
    const fine = window.matchMedia(FINE_POINTER)
    const positions = new WeakMap<HTMLElement, [number, number]>()
    const onOver = (event: PointerEvent) => {
      if (!fine.matches || event.pointerType === "touch") return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(".ghost-rail")) return
      const down = unclaimedScroller(target, "y")
      const across = unclaimedScroller(target, "x")
      setSlots(current => ({ y: hovering(current.y, down), x: hovering(current.x, across) }))
    }
    const onOut = (event: PointerEvent) => {
      if (event.relatedTarget) return
      setSlots(current => ({ y: hovering(current.y, null), x: hovering(current.x, null) }))
    }
    const onScroll = (event: Event) => {
      const element = event.target
      if (!fine.matches || !(element instanceof HTMLElement)) return
      const before = positions.get(element)
      positions.set(element, [element.scrollTop, element.scrollLeft])
      if (!ownerMoved(element)) return
      const down = (before ? before[0] !== element.scrollTop : true) && scrolls(element, "y") && element.dataset.scrollRail !== "y"
      const across = (before ? before[1] !== element.scrollLeft : !scrolls(element, "y")) && scrolls(element, "x") && element.dataset.scrollRail !== "x"
      if (!down && !across) return
      setSlots(current => ({ y: down ? woken(current.y, element) : current.y, x: across ? woken(current.x, element) : current.x }))
    }
    document.addEventListener("pointerover", onOver, { capture: true, passive: true })
    document.addEventListener("pointerout", onOut, { capture: true, passive: true })
    document.addEventListener("scroll", onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener("pointerover", onOver, { capture: true })
      document.removeEventListener("pointerout", onOut, { capture: true })
      document.removeEventListener("scroll", onScroll, { capture: true })
    }
  }, [])

  return createPortal(<>
    {slots.y && <FloatingRail key={`y${slotId(slots.y.element)}`} slot={slots.y} axis="y" />}
    {slots.x && <FloatingRail key={`x${slotId(slots.x.element)}`} slot={slots.x} axis="x" />}
  </>, document.body)
}

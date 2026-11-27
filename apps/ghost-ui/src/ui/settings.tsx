// App-owned UI. Retained-source notices: ./LICENSE.
import type { ReactNode, KeyboardEvent } from "react"
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Plus } from "lucide-react"
import "./settings.css"

export interface SettingsLayoutSection {
  id: string
  label: string
  icon?: ReactNode
  /** Heading shown above the first section of each run of equal groups. */
  group?: string
  /** Rare, technical sections: hidden behind one toggle until opened or selected. */
  folded?: boolean
  /** A reported state or count alongside the section label. */
  status?: ReactNode
  /** The section's current value (default model, theme, device count) read under the label. */
  value?: ReactNode
}

export interface SettingsLayoutProps {
  sections: SettingsLayoutSection[]
  activeSection: string
  onSectionChange: (id: string) => void
  children: ReactNode
  title?: string
  pageTitle?: ReactNode
  strings: {
    navigationLabel: string
    contentLabel: string
  }
  className?: string
  compactDetail?: boolean
  /** Use the wider settings measure for pages that place a list beside its detail. */
  wide?: boolean
  /** Label of the toggle that opens the `folded` sections. */
  foldedLabel?: string
  /** Label of the rail search; while typing, matched tabs (folded ones included) stay in place. */
  searchLabel?: string
  /** Shown when the rail search matches no section. */
  searchEmptyLabel?: string
}

export interface SettingsGroupProps {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned controls in the group header (e.g. a primary action). */
  actions?: ReactNode
  children: ReactNode
  className?: string
}

export interface SettingsRowProps {
  label: ReactNode
  description?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}

export function SettingsLayout({
  sections,
  activeSection,
  onSectionChange,
  children,
  title,
  pageTitle,
  strings,
  className,
  compactDetail = false,
  wide = false,
  foldedLabel,
  searchLabel,
  searchEmptyLabel,
}: SettingsLayoutProps) {
  const instanceId = useId()
  const panelId = `${instanceId}-panel`
  const settingsRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  const previousSection = useRef(activeSection)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [horizontalNavigation, setHorizontalNavigation] = useState(false)
  const [foldedOpen, setFoldedOpen] = useState(false)
  const [query, setQuery] = useState("")

  useEffect(() => {
    const settings = settingsRef.current
    if (!settings || typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHorizontalNavigation(entry.contentRect.width <= 700)
    })
    observer.observe(settings)
    return () => observer.disconnect()
  }, [])

  // Keyboard and deep-link selection can land outside the visible rail; bring it back.
  useEffect(() => {
    tabRefs.current.get(activeSection)?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeSection])

  useLayoutEffect(() => {
    if (previousSection.current === activeSection) return
    previousSection.current = activeSection
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [activeSection])

  const tabId = (sectionId: string) => `${instanceId}-tab-${sectionId}`
  const selectedSection = sections.find((section) => section.id === activeSection)
  const foldedVisible = foldedOpen || Boolean(selectedSection?.folded)
  const needle = query.trim().toLocaleLowerCase()
  // The horizontal strip has no room to type in; filtering only runs in the vertical rail.
  const searching = Boolean(searchLabel) && !horizontalNavigation && needle.length > 0
  // Typing never moves the selection: the visible content follows the tab, not the query.
  const shown = searching
    ? sections.filter((section) => section.label.toLocaleLowerCase().includes(needle))
    : sections.filter((section) => !section.folded || foldedVisible)
  const activeVisible = shown.some((section) => section.id === activeSection)

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, sectionId: string) => {
    const previousKey = horizontalNavigation ? "ArrowLeft" : "ArrowUp"
    const nextKey = horizontalNavigation ? "ArrowRight" : "ArrowDown"
    const currentIndex = shown.findIndex((section) => section.id === sectionId)
    let nextSection: SettingsLayoutSection | undefined

    if (event.key === "Home") nextSection = shown[0]
    else if (event.key === "End") nextSection = shown[shown.length - 1]
    else if (event.key === previousKey || event.key === nextKey) {
      const offset = event.key === nextKey ? 1 : -1
      nextSection = shown[(currentIndex + offset + shown.length) % shown.length]
    } else return

    if (!nextSection) return
    const selectedNextSection = nextSection
    event.preventDefault()
    onSectionChange(selectedNextSection.id)
    requestAnimationFrame(() => tabRefs.current.get(selectedNextSection.id)?.focus())
  }

  const focusActiveRailTab = () => {
    const fallback = shown[0] ? tabRefs.current.get(shown[0].id) : undefined
    ;(tabRefs.current.get(activeSection) ?? fallback)?.focus()
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      if (query) setQuery("")
      else focusActiveRailTab()
    } else if (event.key === "ArrowDown" && shown.length > 0) {
      event.preventDefault()
      tabRefs.current.get(shown[0]!.id)?.focus()
    }
  }

  return (
    <div ref={settingsRef} className={["ghost-settings", className].filter(Boolean).join(" ")} data-compact-detail={compactDetail || undefined} data-wide={wide || undefined}>
      <div className="ghost-settings__layout">
        <nav className="ghost-settings__navigation" aria-label={strings.navigationLabel}>
          {title && <h1 className="ghost-settings__title">{title}</h1>}
          {searchLabel && !horizontalNavigation && (
            <input
              className="ghost-settings__search"
              type="search"
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          )}
          <div
            className="ghost-settings__section-list"
            role="tablist"
            aria-label={strings.navigationLabel}
            aria-orientation={horizontalNavigation ? "horizontal" : "vertical"}
          >
            {shown.map((section, index) => {
              const isSelected = activeSection === section.id
              const previous = shown[index - 1]
              const startsFold = !searching && Boolean(section.folded) && !previous?.folded
              const statusId = section.status ? `${tabId(section.id)}-status` : undefined
              const valueId = section.value ? `${tabId(section.id)}-value` : undefined
              const heading = !searching && !section.folded && section.group && section.group !== previous?.group ? section.group : null
              return (
                <Fragment key={section.id}>
                  {heading && <div className="ghost-settings__group-label" role="presentation">{heading}</div>}
                  {startsFold && <div className="ghost-settings__group-label" role="presentation">{foldedLabel}</div>}
                  <button
                    ref={(node) => {
                      if (node) tabRefs.current.set(section.id, node)
                      else tabRefs.current.delete(section.id)
                    }}
                    id={tabId(section.id)}
                    className="ghost-settings__section ghost-navigation-item"
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    aria-label={section.label}
                    aria-describedby={[statusId, valueId].filter(Boolean).join(" ") || undefined}
                    aria-controls={panelId}
                    tabIndex={isSelected || (!activeVisible && index === 0) ? 0 : -1}
                    onClick={() => onSectionChange(section.id)}
                    onKeyDown={(event) => onTabKeyDown(event, section.id)}
                  >
                    {section.icon && <span className="ghost-settings__section-icon" aria-hidden="true">{section.icon}</span>}
                    <span className="ghost-settings__section-copy">
                      <span className="ghost-settings__section-label">{section.label}</span>
                      {valueId && <span className="ghost-settings__section-value" id={valueId}>{section.value}</span>}
                    </span>
                    {statusId && <span className="ghost-settings__section-status" id={statusId}>{section.status}</span>}
                  </button>
                </Fragment>
              )
            })}
            {!searching && foldedLabel && !foldedVisible && sections.some((section) => section.folded) && (
              <button type="button" className="ghost-settings__fold ghost-navigation-item" aria-expanded="false" onClick={() => setFoldedOpen(true)}>
                <span className="ghost-settings__section-icon" aria-hidden="true"><Plus /></span>
                <span>{foldedLabel}</span>
              </button>
            )}
          </div>
          {searching && shown.length === 0 && searchEmptyLabel && (
            <p className="ghost-settings__search-empty" role="status">{searchEmptyLabel}</p>
          )}
        </nav>
        <section
          ref={contentRef}
          id={panelId}
          className="ghost-settings__content"
          role="tabpanel"
          aria-labelledby={!compactDetail && selectedSection ? tabId(selectedSection.id) : undefined}
          aria-label={strings.contentLabel}
          tabIndex={0}
        >
          <div className="ghost-settings__content-inner">
            {pageTitle && <h1 className="ghost-settings__page-title">{pageTitle}</h1>}
            {children}
          </div>
        </section>
      </div>
    </div>
  )
}

export function SettingsGroup({ title, description, actions, children, className }: SettingsGroupProps) {
  const headingId = useId()
  const descriptionId = useId()

  return (
    <section
      className={["ghost-settings-group", className].filter(Boolean).join(" ")}
      aria-labelledby={headingId}
      aria-describedby={description ? descriptionId : undefined}
    >
      <header className="ghost-settings-group__header" data-actions={actions ? "" : undefined}>
        <div className="ghost-settings-group__header-copy">
          <h2 id={headingId} className="ghost-settings-group__title">{title}</h2>
          {description && <p id={descriptionId} className="ghost-settings-group__description">{description}</p>}
        </div>
        {actions && <div className="ghost-settings-group__header-actions">{actions}</div>}
      </header>
      <div className="ghost-settings-group__rows">{children}</div>
    </section>
  )
}

export function SettingsRow({ label, description, htmlFor, children, className }: SettingsRowProps) {
  return (
    <div className={["ghost-settings-row", className].filter(Boolean).join(" ")}>
      <div className="ghost-settings-row__copy">
        {htmlFor
          ? <label className="ghost-settings-row__label" htmlFor={htmlFor}>{label}</label>
          : <div className="ghost-settings-row__label">{label}</div>}
        {description && <p className="ghost-settings-row__description">{description}</p>}
      </div>
      <div className="ghost-settings-row__control">{children}</div>
    </div>
  )
}

import { getNotionIconUrl, icon } from "@notionhq/custom-blocks"
import { useEffect, useId, useRef, useState } from "react"
import { colors, type IconSelection } from "./selection"
import { IconGrid } from "./IconGrid"
import { CheckGlyph, SearchGlyph } from "./Glyphs"
import "./IconPicker.css"

export type { IconSelection } from "./selection"
export type IconPickerProps = {
  value: IconSelection
  onChange: (value: IconSelection) => void
}

/** Controlled selection. The consumer decides whether and where to save it. */
export function IconPicker({ value, onChange }: IconPickerProps) {
  const panelId = useId()
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const [searchRequest, setSearchRequest] = useState({ query: "" })
  const query = searchRequest.query
  const [names, setNames] = useState<string[]>([])
  const [catalogCount, setCatalogCount] = useState(0)
  const [searching, setSearching] = useState(true)
  const [searchError, setSearchError] = useState<string>()
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let current = true
    setSearching(true)
    setNames([])
    setSearchError(undefined)
    const request = searchRequest.query.trim()
      ? icon.query({ query: searchRequest.query })
      : icon.list()
    void request
      .then((result) => {
        if (!current) {
          return
        }
        if (result.status === "error") {
          setNames([])
          setSearchError(
            result.error.code === "unsupported_feature"
              ? "This host doesn't support this icon request. Clear the search to try browsing."
              : result.error.message
          )
        } else {
          setNames(result.names)
          if (!searchRequest.query.trim()) {
            setCatalogCount(result.names.length)
          }
        }
      })
      .catch((error) => {
        console.error("Icon catalog request failed", error)
        if (current) {
          setSearchError("Couldn't load icons. Try again.")
        }
      })
      .finally(() => {
        if (current) {
          setSearching(false)
        }
      })
    // A slower earlier query must never replace the latest visible results.
    return () => {
      current = false
    }
  }, [searchRequest])

  useEffect(() => {
    if (open) {
      search.current?.focus()
    }
  }, [open])

  function closePicker() {
    setOpen(false)
    trigger.current?.focus()
  }
  return (
    <section className="icon-picker-component" aria-label="Icon picker">
      <button
        ref={trigger}
        type="button"
        className="picker-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <img src={getNotionIconUrl(value)} width={22} height={22} alt="" />
        Change icon <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div
          id={panelId}
          className="picker"
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              closePicker()
            }
          }}
        >
          <div className="picker-title">
            <h2 id={titleId}>Icons</h2>
            <button
              type="button"
              aria-label="Close icon picker"
              className="close"
              onClick={closePicker}
            >
              ×
            </button>
          </div>
          <label className="search">
            <SearchGlyph />
            <input
              ref={search}
              aria-label="Search Notion icons"
              placeholder="Search icons…"
              value={query}
              onChange={(event) =>
                setSearchRequest({ query: event.target.value })
              }
            />
            <kbd>esc</kbd>
          </label>
          <fieldset className="color-bar" aria-label="Icon color">
            {colors.map((color) => (
              <button
                key={color.value}
                type="button"
                className="swatch"
                aria-label={color.label}
                aria-pressed={value.color === color.value}
                title={color.label}
                onClick={() => onChange({ ...value, color: color.value })}
              >
                <span style={{ background: `var(${color.token})` }}>
                  {value.color === color.value ? <CheckGlyph /> : null}
                </span>
              </button>
            ))}
          </fieldset>
          <div className="results-heading">
            <span>{query.trim() ? "Search results" : "All icons"}</span>
            <span role="status" aria-live="polite">
              {searching
                ? "Searching…"
                : searchError
                  ? "Unavailable"
                  : `${names.length} ${names.length === 1 ? "icon" : "icons"}`}
            </span>
          </div>
          {searchError ? (
            <div className="empty" role="alert">
              <p>{searchError}</p>
              <button type="button" onClick={() => setSearchRequest({ query })}>
                Try again
              </button>
            </div>
          ) : names.length === 0 && !searching ? (
            <div className="empty">
              <SearchGlyph />
              <p>No icons found</p>
              <span>Try a different name or a shorter search.</span>
            </div>
          ) : (
            <IconGrid
              key={query}
              names={names}
              value={value}
              onChange={onChange}
              searching={searching}
            />
          )}
          <footer className="picker-footer">
            <span>Search by name, label, or keyword</span>
            <span>↑ ↓ ← →</span>
          </footer>
        </div>
      ) : (
        <div className="closed-hint">
          <img src={getNotionIconUrl(value)} width={72} height={72} alt="" />
          <h2>
            A small change.
            <br />A whole new feeling.
          </h2>
          <p>Open the picker to explore {catalogCount || "the"} icons.</p>
        </div>
      )}
    </section>
  )
}

import { getNotionIconUrl } from "@notionhq/custom-blocks"
import { type KeyboardEvent, useRef, useState } from "react"
import { type IconSelection, nextGridIndex } from "./selection"

type IconGridProps = {
  names: string[]
  value: IconSelection
  onChange: (value: IconSelection) => void
  searching: boolean
}

export function IconGrid({ names, value, onChange, searching }: IconGridProps) {
  const [focusedIndex, setFocusedIndex] = useState(0)
  const grid = useRef<HTMLFieldSetElement>(null)

  function handleKey(event: KeyboardEvent<HTMLFieldSetElement>) {
    if (!(event.target instanceof HTMLButtonElement)) return
    const name = event.target.dataset.icon
    if (!name) return
    const next = nextGridIndex(event.key, names.indexOf(name), names.length)
    if (next === undefined) return
    event.preventDefault()
    setFocusedIndex(next)
    grid.current?.querySelectorAll("button")[next]?.focus()
  }

  return (
    <fieldset
      ref={grid}
      className="icon-grid"
      aria-label="Notion icons"
      aria-busy={searching}
      onKeyDown={handleKey}
    >
      {names.map((name, index) => (
        <button
          key={name}
          type="button"
          data-icon={name}
          aria-label={`Choose ${name}`}
          aria-pressed={value.name === name}
          title={name.replaceAll("-", " ")}
          tabIndex={focusedIndex === index ? 0 : -1}
          onFocus={() => setFocusedIndex(index)}
          onClick={() => onChange({ ...value, name })}
        >
          <img
            src={getNotionIconUrl({ name, color: value.color })}
            width={26}
            height={26}
            alt=""
            loading="lazy"
          />
        </button>
      ))}
    </fieldset>
  )
}

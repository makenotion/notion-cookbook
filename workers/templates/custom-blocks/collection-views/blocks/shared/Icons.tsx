import type { View } from "./model"

type IconName =
	| View
	| "page"
	| "search"
	| "filter"
	| "sort"
	| "more"
	| "plus"
	| "chevron"
	| "stage"
	| "due"
	| "owner"
	| "rating"
	| "name"
	| "properties"
	| "drag"
	| "open"
	| "edit"
type IconProps = { name: IconName; size?: number }

export function Icon({ name, size = 16 }: IconProps) {
	const paths: Record<IconName, string> = {
		table: "M2.5 3.5h15v13h-15zM2.5 8h15M2.5 12.5h15M8 3.5v13",
		board: "M2.5 3.5h15v13h-15zM7.5 3.5v13M12.5 3.5v13",
		gallery: "M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z",
		list: "M6 4h11M6 10h11M6 16h11M2.5 4h.1M2.5 10h.1M2.5 16h.1",
		feed: "M6 3h11v14H6zM3 6v11h3M9 6h5M9 9h5M9 12h5",
		page: "M4 2.5h7l5 5v10H4zM11 2.5v5h5M7 10h6M7 12.5h6M7 15h5",
		search: "M13.5 13.5 18 18M15 8.5a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0",
		filter: "M3 5h14M5 10h10M8 15h4",
		sort: "M6 3v14M3 6l3-3 3 3M14 3v14M11 14l3 3 3-3",
		more: "M4 10h.1M10 10h.1M16 10h.1",
		plus: "M10 3v14M3 10h14",
		chevron: "M5 8l5 5 5-5",
		stage: "M17.5 10a7.5 7.5 0 1 0-15 0 7.5 7.5 0 0 0 15 0M7 9l3 4 3-4z",
		due: "M3 5h14v12H3zM3 9h14M6 2.5v5M14 2.5v5",
		owner:
			"M8 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0M17 6a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0M1.5 17v-3a4 4 0 0 1 8 0v3zM11 17v-2.5a3.5 3.5 0 0 1 7 0V17z",
		rating: "M7 2 5 18M14 2l-2 16M3 7h14M2 13h14",
		name: "M2 15 6 4l4 11M3.5 11h5M17 15V8M17 11c-5-3-6 5-1 3",
		properties: "M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M7 13v4",
		drag: "M7 4h.1M13 4h.1M7 10h.1M13 10h.1M7 16h.1M13 16h.1",
		open: "M11 3h6v6M17 3 8 12M8 4H3v13h13v-5",
		edit: "m13 3 4 4-10 10H3v-4zM11 5l4 4",
	}
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			strokeWidth={name === "more" || name === "drag" ? 3 : 1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[name]} />
		</svg>
	)
}

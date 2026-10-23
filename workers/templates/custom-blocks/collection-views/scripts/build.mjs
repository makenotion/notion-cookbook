import { build } from "vite"

for (const view of ["table", "board", "gallery", "list", "feed"]) {
	await build({ root: `blocks/${view}`, base: "./" })
}

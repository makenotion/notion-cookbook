export interface SlideItem {
  text: string
  type: "text" | "bullet" | "numbered" | "todo" | "code" | "quote"
  checked?: boolean
}

export interface Slide {
  title: string
  items: SlideItem[]
}

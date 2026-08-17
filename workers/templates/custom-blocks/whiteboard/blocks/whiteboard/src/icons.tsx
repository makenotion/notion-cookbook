/** 16×16 stroke icons, drawn with currentColor. */

type IconProps = { size?: number };

function Svg({ children, size = 16 }: IconProps & { children: React.ReactNode }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export function SelectIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M4 2.5 L12.3 9.2 L8.6 9.8 L10.4 13.5 L8.5 14.4 L6.7 10.7 L4 13 Z" fill="currentColor" stroke="none" />
		</Svg>
	);
}

export function HandIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M5.2 7.4 V 4.5 a1 1 0 0 1 2 0 v2.1 V 3.4 a1 1 0 0 1 2 0 v3.2 V 4.2 a1 1 0 0 1 2 0 v3.1 l0.5 -0.7 a1 1 0 0 1 1.7 1.1 l-2.2 4 a3.2 3.2 0 0 1 -2.8 1.7 H 7.1 a3 3 0 0 1 -2.5 -1.3 L 2.8 9.4 a1 1 0 0 1 1.6 -1.2 Z" />
		</Svg>
	);
}

export function PenIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M9.9 3.3 L12.7 6.1 L6 12.8 L2.7 13.3 L3.2 10 Z" />
			<path d="M11.3 1.9 a1 1 0 0 1 1.4 0 l1.4 1.4 a1 1 0 0 1 0 1.4 l-0.7 0.7 -2.8 -2.8 Z" fill="currentColor" stroke="none" />
		</Svg>
	);
}

export function EraserIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M6.2 12.8 L2.9 9.5 a1.4 1.4 0 0 1 0 -2 L8.3 2.1 a1.4 1.4 0 0 1 2 0 L13.6 5.4 a1.4 1.4 0 0 1 0 2 L8.2 12.8 a1.4 1.4 0 0 1 -2 0 Z" />
			<path d="M5.4 4.9 L11 10.5" />
			<path d="M8.5 13 H 13.8" />
		</Svg>
	);
}

export function StickyIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M2.8 3.8 a1 1 0 0 1 1 -1 H 12.2 a1 1 0 0 1 1 1 V 8.6 L 8.8 13.2 H 3.8 a1 1 0 0 1 -1 -1 Z" />
			<path d="M13 8.8 H 9.9 a1 1 0 0 0 -1 1 V 13" />
		</Svg>
	);
}

export function LineIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M3 13 L 13 3" />
		</Svg>
	);
}

export function ArrowIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M3 13 L 12.4 3.6" />
			<path d="M7.4 3.2 L 12.8 3.2 L 12.8 8.6" />
		</Svg>
	);
}

import {
	SetupCard,
	SkeletonView,
	Tracker,
} from "./components/Tracker";
import { useSampleStore } from "./mockStore";
import type { HabitStore } from "./types";

export function App({
	store,
	readOnly,
}: {
	store: HabitStore;
	readOnly?: boolean;
}) {
	const sample = useSampleStore();
	if (store.status === "unbound") {
		return (
			<div className="ht-unbound">
				<div className="ht-unbound-demo" inert aria-hidden="true">
					<Tracker store={sample} readOnly />
				</div>
				<SetupCard detail={store.unboundDetail} />
			</div>
		);
	}
	if (store.status === "loading") {
		return <SkeletonView />;
	}
	return <Tracker store={store} readOnly={readOnly} />;
}

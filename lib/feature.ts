import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { featureDefaults, isFeature, readFeatureConfig } from "./features.ts";

/** Check before invoking a factory, so disabled features register no resources or handlers. */
export function feature(source: string, factory: ExtensionFactory): ExtensionFactory {
	const name = basename(fileURLToPath(source), ".ts");
	assert(isFeature(name), `Unknown Vibes wrapper '${name}'`);
	return (pi) => {
		const choices = readFeatureConfig(join(getAgentDir(), "vibes.json"));
		// Explicit infrastructure requests must still work despite a personal opt-out.
		const requested = (name === "vibes-check" && process.env.VIBES_CHECK_READY)
			|| (name === "inventory" && process.env.VIBES_INVENTORY);
		if ((choices[name] ?? featureDefaults[name]) || requested) return factory(pi);
	};
}

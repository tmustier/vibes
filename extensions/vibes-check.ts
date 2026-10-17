import { feature } from "../lib/feature.ts";
/**
 * Tells `vibes check` that Pi has finished starting. Pi emits resources_discover only after every
 * extension has loaded and every session_start handler has finished. Does nothing outside a check.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default feature(import.meta.url, (pi: ExtensionAPI) => {
	const marker = process.env.VIBES_CHECK_READY;
	if (!marker) return;
	pi.on("resources_discover", (event) => {
		if (event.reason === "startup") writeFileSync(marker, "");
	});
});

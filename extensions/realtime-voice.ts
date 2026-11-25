import { bundled } from "../lib/bundled.ts";

export default bundled(import.meta.url, {
	package: "@howaboua/pi-gippity-control",
	// Codex Conversion ships the same voice controls; running both would register every shortcut twice.
	includedIn: ["@howaboua/pi-codex-conversion"],
});

import { bundled } from "../lib/bundled.ts";

export default bundled(import.meta.url, {
	package: "mitsupi",
	entry: "extensions/whimsical.ts",
});

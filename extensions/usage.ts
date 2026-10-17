import { bundled } from "../lib/bundled.ts";

export default bundled(import.meta.url, {
	package: "pi-extensions",
	entry: "usage-extension/index.ts",
});

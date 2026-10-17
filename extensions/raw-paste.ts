import { bundled } from "../lib/bundled.ts";

export default bundled(import.meta.url, {
	package: "pi-extensions",
	entry: "raw-paste/index.ts",
});

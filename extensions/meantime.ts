import { bundled } from "../lib/bundled.ts";

export default bundled(import.meta.url, {
	package: "pine-of-glass",
	entry: "extensions/pi-meantime",
});

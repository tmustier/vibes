import { bundled } from "../lib/bundled.ts";

export default bundled(import.meta.url, {
	package: "@tmustier/pi-anthropic-gzip",
});

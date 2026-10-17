import { bundled } from "../lib/bundled.ts";

export default bundled(import.meta.url, {
	package: "@earendil-works/pi-radius",
	noExtensions: true,
	skills: ["skills/radius-api"],
});

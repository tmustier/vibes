import { bundled } from "../lib/bundled.ts";

export default bundled(import.meta.url, {
	package: "pi-extensions",
	noExtensions: true,
	skills: ["extending-pi/SKILL.md"],
});

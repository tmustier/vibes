import { bundled } from "../lib/bundled.ts";

export default bundled(import.meta.url, {
	package: "pi-extensions",
	noExtensions: true,
	skills: ["extending-pi/SKILL.md", "extending-pi/skill-creator/SKILL.md"],
});

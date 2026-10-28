import { feature } from "../lib/feature.ts";

export default feature(import.meta.url, async (pi) => {
	const { default: claudeArtifacts } = await import("../lib/claude-artifacts/extension.ts");
	claudeArtifacts(pi);
});

import { feature } from "../lib/feature.ts";

export default feature(import.meta.url, async (pi) => {
	const { default: ampOrbs } = await import("../lib/amp-orbs/extension.ts");
	ampOrbs(pi);
});

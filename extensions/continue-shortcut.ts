import { feature } from "../lib/feature.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default feature(import.meta.url, (pi: ExtensionAPI) => {
  pi.registerShortcut("ctrl+shift+enter", {
    description: "Send 'continue' to the agent",
    handler: async () => {
      pi.sendUserMessage("continue");
    },
  });
});

import { createPluginHooks } from "./plugin.js";

// Magpie treats every named exported function as a potential plugin. Expose
// only this v1 entry object; implementation helpers live in separate modules.
export default {
  id: "magpie-chatgptweb2api",
  async server(_input: unknown, options: unknown = {}) { return createPluginHooks(options); },
};

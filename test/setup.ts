import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Keep Bun's native fetch/Request/Response/Headers so server tests talk to a real Bun.serve.
const native = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
};

GlobalRegistrator.register();

Object.assign(globalThis, native);

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Keep Bun's native fetch/Request/Response/Headers so server tests talk to a real Bun.serve.
const native = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
};

// A real base URL so relative URLs (e.g. `<img src="/media/x.jpg">`) parse; on about:blank
// happy-dom fires `error` on every such image.
GlobalRegistrator.register({ url: "http://localhost/" });

Object.assign(globalThis, native);

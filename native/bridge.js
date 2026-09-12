(() => {
  const controllers = new Map();
  const chunkBytes = 32 * 1024;
  async function perform(request) {
    const controller = new AbortController();
    controllers.set(request.id, controller);
    const url = new URL(location.origin);
    let limit = 2 * 1024 ** 2;
    const headers = {};
    if (request.kind === "notes") url.pathname = "/kindle-notebook/api/notes";
    else if (request.kind === "open") {
      url.pathname = "/openNotebook";
      url.search = new URLSearchParams({
        notebookId: request.notebookId,
        marketplaceId: "ATVPDKIKX0DER",
      });
    } else if (request.kind === "render") {
      url.pathname = "/renderPage";
      url.search = new URLSearchParams({
        startPage: String(request.page),
        endPage: String(request.page),
        width: "620",
        height: "877",
        dpi: "50",
      });
      headers["x-amzn-karamel-notebook-rendering-token"] = request.token;
      limit = 64 * 1024 ** 2;
    } else return { error: "protocol-unsupported" };
    let reader;
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers,
      });
      if (
        response.status === 401 ||
        response.status === 403 ||
        (response.headers.get("content-type") || "")
          .toLowerCase()
          .includes("text/html")
      )
        return { error: "authentication-required" };
      if (response.status !== 200) return { error: "service-error" };
      if (!response.body) return { error: "protocol-unsupported" };
      reader = response.body.getReader();
      let size = 0,
        sequence = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.length; offset += chunkBytes) {
          const bytes = value.subarray(
            offset,
            Math.min(offset + chunkBytes, value.length),
          );
          if (size + bytes.length > limit)
            return { error: "response-too-large" };
          size += bytes.length;
          let binary = "";
          for (let i = 0; i < bytes.length; i++)
            binary += String.fromCharCode(bytes[i]);
          const accepted =
            await window.webkit.messageHandlers.scribeChunk.postMessage({
              id: request.id,
              sequence,
              base64: btoa(binary),
            });
          if (accepted !== true) return { error: "protocol-unsupported" };
          sequence++;
        }
      }
      return { bytes: size, chunks: sequence };
    } catch {
      return {
        error: controller.signal.aborted ? "interrupted" : "network-error",
      };
    } finally {
      controllers.delete(request.id);
      if (reader) await reader.cancel().catch(() => {});
      controller.abort();
    }
  }
  globalThis.scribeBridge = Object.freeze({
    perform,
    abort: (id) => controllers.get(id)?.abort(),
  });
})();

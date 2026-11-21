const HF_ORIGIN = "https://huggingface.co";
const MODEL_PREFIX = "/hf/Xenova/whisper-base.en/";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/hf/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (!url.pathname.startsWith(MODEL_PREFIX)) {
        return new Response("Model path not allowed", { status: 404 });
      }

      const upstreamUrl = new URL(url.pathname.slice(4) + url.search, `${HF_ORIGIN}/`);
      const headers = new Headers();
      for (const name of ["range", "if-range", "if-none-match", "if-modified-since"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }

      try {
        const upstream = await fetch(upstreamUrl, {
          method: request.method,
          headers,
          redirect: "follow",
        });
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.set("Access-Control-Allow-Origin", url.origin);
        responseHeaders.set("Cache-Control", "public, max-age=3600");
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return new Response(`Could not fetch model file from Hugging Face: ${detail}`, {
          status: 502,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};

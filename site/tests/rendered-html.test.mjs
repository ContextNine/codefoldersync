import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the landing page and social metadata", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Code Folder Sync<\/title>/i);
  assert.match(html, /<main>/i);
  assert.match(html, /aria-label="Product capabilities"/i);
  assert.match(html, /http:\/\/localhost:3000\/og\.png/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("server-renders a documentation detail route with local navigation", async () => {
  const response = await render("/docs/how-it-works");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>How sync works · Code Folder Sync<\/title>/i);
  assert.match(html, /aria-label="Documentation navigation"/i);
  assert.match(html, /aria-label="On this page"/i);
  assert.doesNotMatch(html, /property="og:image"/i);
});

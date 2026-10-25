import { assert, assertEquals, assertNotEquals } from "@std/assert";
import * as esbuild from "esbuild";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import {
  APP_PREVIEW_MIME,
  APP_PREVIEW_SHIM,
  appPreviewResource,
  appPreviewResourceContents,
  isAppPreviewUri,
  showAppListing,
  showAppResult,
} from "./mcp-app-preview.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

function pageScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

Deno.test({
  ...testOpts,
  name: "the preview page and the script it injects are valid JavaScript",
  fn: async () => {
    await initCompiler();
    try {
      const scripts = pageScripts(appPreviewResource().html);
      assertEquals(scripts.length, 1);
      await esbuild.transform(scripts[0]!, { loader: "js" });
      await esbuild.transform(
        `(function () { var PAGE = "http://127.0.0.1:1/"; ${APP_PREVIEW_SHIM} })();`,
        { loader: "js" },
      );
      // The page embeds the shim as a JSON string inside its own <script>, so
      // a closing tag in it would end the page's script early.
      assert(!APP_PREVIEW_SHIM.includes("</"));
    } finally {
      stopCompiler();
    }
  },
});

Deno.test("the preview resource is cached by a URI that changes with it", () => {
  const local = appPreviewResource("127.0.0.1");
  assert(isAppPreviewUri(local.uri));
  assertEquals(appPreviewResource("127.0.0.1").uri, local.uri);
  assertEquals(local.csp.connectDomains, ["http://127.0.0.1:*"]);
  assertEquals(local.csp.resourceDomains, ["http://127.0.0.1:*"]);
  // Another host means another CSP, so another URI.
  assertNotEquals(appPreviewResource("100.64.0.7").uri, local.uri);

  const [content] = appPreviewResourceContents(local).contents;
  assertEquals(content!.mimeType, APP_PREVIEW_MIME);
  assertEquals(content!.uri, local.uri);
  assertEquals(content!._meta.ui.csp, local.csp);
});

Deno.test("show_app points at the preview resource and returns the app's URL", () => {
  const preview = appPreviewResource();
  const listing = showAppListing(preview);
  assertEquals(
    (listing._meta as { ui: { resourceUri: string } }).ui.resourceUri,
    preview.uri,
  );
  assertEquals(listing.annotations?.readOnlyHint, true);

  const root = showAppResult({ appPort: 4321 }, {});
  assert(root.structuredContent.url.endsWith(":4321/"));
  assert(root.content[0]!.text.includes(root.structuredContent.url));
  const page = showAppResult({ appPort: 4321 }, { path: "notes/7" });
  assert(page.structuredContent.url.endsWith(":4321/notes/7"));
});

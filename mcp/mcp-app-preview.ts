// @layer mcp — show_app: the running app, live, inside an MCP client's chat.
//
// Clients that render MCP Apps (the io.modelcontextprotocol/ui extension; Claude
// Desktop does) show a tool's UI resource in a sandboxed frame under the call.
// Probed in Claude Desktop (2026-10-25):
//   - The sandbox is https://<hash>.claudemcpcontent.com. Its CSP takes only
//     connectDomains and resourceDomains from the resource; frameDomains and
//     baseUriDomains are dropped. So the app can't be framed by URL, and a
//     <base> tag is ignored.
//   - The page CAN fetch the app (the app server answers CORS with *). So it
//     fetches the app's HTML, makes its URLs absolute, and renders it in a
//     srcdoc frame with a small script first in <head> that sends the app's
//     relative fetch/XHR calls, link clicks and form posts to the app's origin.
//   - Desktop caches a ui:// resource by URI, across chats and reinstalls. So the
//     page is static (the URL comes from the tool result) and the URI carries a
//     hash of the page and its CSP: change either and the URI changes with it.
//
// Clients without MCP Apps get the tool's text: the app's URL.
import { appPreviewUrl, getAppServerDialHost } from "../core/config.ts";
import { hashParts } from "../core/fingerprint.ts";
import type { Kernel } from "../core/registries.ts";
import type { McpToolListing } from "./mcp-projection.ts";

export const SHOW_APP = "show_app";
export const APP_PREVIEW_MIME = "text/html;profile=mcp-app";
const APP_PREVIEW_URI_PREFIX = "ui://opentide/app-preview-";

export interface AppPreviewCsp {
  connectDomains: string[];
  resourceDomains: string[];
}

export interface AppPreviewResource {
  uri: string;
  html: string;
  csp: AppPreviewCsp;
}

export interface ShowAppResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { url: string };
  isError?: boolean;
}

// Any port on the host the app server is dialled at: the resource is cached by
// URI, so it can't name the port of the app that happens to be running.
function previewCsp(host: string): AppPreviewCsp {
  const origins = [`http://${host}:*`];
  return { connectDomains: origins, resourceDomains: origins };
}

export function appPreviewResource(
  host: string = getAppServerDialHost(),
): AppPreviewResource {
  const csp = previewCsp(host);
  const hash = hashParts([APP_PREVIEW_HTML, JSON.stringify(csp)]);
  return {
    uri: `${APP_PREVIEW_URI_PREFIX}${hash}`,
    html: APP_PREVIEW_HTML,
    csp,
  };
}

export function isAppPreviewUri(uri: string): boolean {
  return uri.startsWith(APP_PREVIEW_URI_PREFIX);
}

// What resources/list advertises and resources/read returns.
export function appPreviewResourceListing(preview = appPreviewResource()) {
  return {
    uri: preview.uri,
    name: "App preview",
    description: "The running app, rendered live in the chat.",
    mimeType: APP_PREVIEW_MIME,
    _meta: { ui: { csp: preview.csp, prefersBorder: true } },
  };
}

export function appPreviewResourceContents(preview = appPreviewResource()) {
  return {
    contents: [{
      uri: preview.uri,
      mimeType: APP_PREVIEW_MIME,
      text: preview.html,
      _meta: { ui: { csp: preview.csp, prefersBorder: true } },
    }],
  };
}

export function showAppListing(preview = appPreviewResource()): McpToolListing {
  return {
    name: SHOW_APP,
    description:
      "Show the user the running app. In clients that render MCP Apps (Claude " +
      "Desktop) it appears live in the chat, and the user can click and type in " +
      "it; elsewhere this returns the app's URL to give them. Call it after a " +
      "change the user can see, or when they ask to see the app.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The page to open, e.g. /notes (default /).",
        },
      },
    },
    annotations: {
      title: "Show app",
      readOnlyHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { resourceUri: preview.uri } },
  };
}

export function showAppResult(
  kernel: Pick<Kernel, "appPort">,
  args: Record<string, unknown>,
): ShowAppResult {
  const path = typeof args.path === "string" && args.path.trim()
    ? args.path.trim()
    : "/";
  const url = appPreviewUrl(kernel.appPort, path);
  return {
    content: [{
      type: "text",
      text: `The app is running at ${url}. Clients that render MCP Apps show ` +
        "it live in the chat; otherwise give the user this link.",
    }],
    structuredContent: { url },
  };
}

// What the page injects first in the rendered app's <head>, after `var PAGE`.
// Plain JS, kept out of the page so tests can parse it.
export const APP_PREVIEW_SHIM = `
var ORIGIN = new URL(PAGE).origin;
function abs(x) {
  try { return new URL(String(x), PAGE).href; } catch (e) { return x; }
}
function same(url) {
  try { return new URL(url).origin === ORIGIN; } catch (e) { return false; }
}
var fetch0 = window.fetch.bind(window);
window.fetch = function (input, init) {
  if (input instanceof Request) return fetch0(new Request(abs(input.url), input), init);
  return fetch0(abs(input), init);
};
var open0 = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url) {
  var rest = Array.prototype.slice.call(arguments, 2);
  return open0.apply(this, [method, abs(url)].concat(rest));
};
["pushState", "replaceState"].forEach(function (name) {
  var original = history[name];
  history[name] = function (state, title, url) {
    try { return original.apply(history, arguments); }
    catch (e) {
      if (url != null) parent.postMessage({ opentidePreview: "path", url: abs(url) }, "*");
    }
  };
});
addEventListener("click", function (e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  var a = e.target.closest && e.target.closest("a[href]");
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
  var href = a.getAttribute("href");
  if (!href || href.charAt(0) === "#") return;
  var to = abs(href);
  e.preventDefault();
  parent.postMessage({ opentidePreview: same(to) ? "navigate" : "open", url: to }, "*");
});
addEventListener("submit", function (e) {
  if (e.defaultPrevented) return;
  var form = e.target;
  var to = abs(form.getAttribute("action") || PAGE);
  if (!same(to)) return;
  e.preventDefault();
  var body = new URLSearchParams(new FormData(form)).toString();
  parent.postMessage({
    opentidePreview: "submit", url: to, method: (form.method || "get").toUpperCase(), body: body
  }, "*");
});
new MutationObserver(function (records) {
  records.forEach(function (r) {
    r.addedNodes.forEach(function (n) {
      if (n.nodeType !== 1) return;
      [n].concat(Array.prototype.slice.call(n.querySelectorAll("[src]"))).forEach(function (el) {
        var src = el.getAttribute && el.getAttribute("src");
        if (src && !/^(https?:|data:|blob:)/.test(src)) el.setAttribute("src", abs(src));
      });
    });
  });
}).observe(document.documentElement, { childList: true, subtree: true });
`;

// The page. Plain JS, no template literals: it lives in this TS string.
const APP_PREVIEW_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>App preview</title>
<style>
  :root { --bg:#ffffff; --fg:#1d1d1f; --muted:#6b6b70; --line:#e3e3e6; --button:#f2f2f4; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1f1f1e; --fg:#ececec; --muted:#9a9a96; --line:#3a3a38; --button:#2c2c2a; }
  }
  html, body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.4 system-ui,-apple-system,sans-serif; }
  #bar { display:flex; gap:8px; align-items:center; padding:6px 8px; border-bottom:1px solid var(--line); }
  #where { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font-family:ui-monospace,Menlo,monospace; }
  button { font:inherit; color:var(--fg); background:var(--button); border:1px solid var(--line); border-radius:6px; padding:3px 10px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  #frame { display:block; width:100%; height:560px; border:0; background:#ffffff; }
  #message { display:none; padding:24px 12px; color:var(--muted); }
</style>
</head>
<body>
<div id="bar">
  <span id="where">Waiting for the app...</span>
  <button id="reload" disabled>Reload</button>
  <button id="open" disabled>Open in browser</button>
</div>
<div id="message"></div>
<iframe id="frame" title="App preview"></iframe>
<script>
(function () {
  var SHIM_SOURCE = __SHIM_SOURCE__;
  var frame = document.getElementById("frame");
  var where = document.getElementById("where");
  var message = document.getElementById("message");
  var reloadButton = document.getElementById("reload");
  var openButton = document.getElementById("open");
  var current = null;
  var nextId = 1;
  var waiting = {};

  function request(method, params) {
    var id = nextId++;
    parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
    return new Promise(function (resolve) { waiting[id] = resolve; });
  }
  function notify(method, params) {
    parent.postMessage({ jsonrpc: "2.0", method: method, params: params }, "*");
  }
  function reportSize() {
    notify("ui/notifications/size-changed", { height: document.documentElement.scrollHeight });
  }
  function showMessage(text) {
    message.textContent = text;
    message.style.display = "block";
    frame.style.display = "none";
    reportSize();
  }

  // Runs first inside the rendered app (APP_PREVIEW_SHIM): its relative URLs
  // would otherwise resolve against the sandbox, which the CSP blocks.
  function shim(pageUrl) {
    return "<scr" + "ipt>(function () { var PAGE = " + JSON.stringify(pageUrl) + ";" +
      SHIM_SOURCE + "})();</scr" + "ipt>";
  }

  // Absolute URLs for what the page loads, and the shim first in <head>.
  function prepare(html, pageUrl) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    var attrs = [["script", "src"], ["img", "src"], ["source", "src"], ["link", "href"], ["iframe", "src"], ["video", "src"], ["audio", "src"]];
    attrs.forEach(function (pair) {
      doc.querySelectorAll(pair[0] + "[" + pair[1] + "]").forEach(function (el) {
        try { el.setAttribute(pair[1], new URL(el.getAttribute(pair[1]), pageUrl).href); } catch (e) {}
      });
    });
    return "<!doctype html>" + doc.documentElement.outerHTML.replace(/<head([^>]*)>/i, function (m) {
      return m + shim(pageUrl);
    });
  }

  function show(url, init) {
    current = url;
    where.textContent = url;
    reloadButton.disabled = false;
    openButton.disabled = false;
    fetch(url, init).then(function (response) {
      var type = response.headers.get("content-type") || "";
      return response.text().then(function (body) {
        if (type.indexOf("html") === -1) {
          var escaped = body.replace(/&/g, "&amp;").replace(/</g, "&lt;");
          return "<pre style=\\"white-space:pre-wrap;font:13px ui-monospace,monospace;padding:12px\\">" + escaped + "</pre>";
        }
        return prepare(body, response.url || url);
      });
    }).then(function (doc) {
      message.style.display = "none";
      frame.style.display = "block";
      frame.srcdoc = doc;
      reportSize();
    }).catch(function () {
      showMessage("Couldn't reach the app at " + url + ". It may have stopped; ask Claude to start it again, then Reload.");
    });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data) return;
    if (event.source === frame.contentWindow && data.opentidePreview) {
      if (data.opentidePreview === "navigate") show(data.url);
      else if (data.opentidePreview === "open") request("ui/open-link", { url: data.url });
      else if (data.opentidePreview === "path") { current = data.url; where.textContent = data.url; }
      else if (data.opentidePreview === "submit") {
        if (data.method === "GET") {
          var target = new URL(data.url);
          target.search = data.body;
          show(target.href);
        } else {
          show(data.url, { method: data.method, body: data.body, headers: { "content-type": "application/x-www-form-urlencoded" } });
        }
      }
      return;
    }
    if (data.jsonrpc !== "2.0") return;
    if (data.id !== undefined && waiting[data.id]) {
      waiting[data.id](data);
      delete waiting[data.id];
      return;
    }
    if (data.method === "ui/notifications/tool-result") {
      var structured = data.params && data.params.structuredContent;
      if (structured && structured.url) show(structured.url);
    }
  });

  reloadButton.onclick = function () { if (current) show(current); };
  openButton.onclick = function () { if (current) request("ui/open-link", { url: current }); };

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "opentide-app-preview", version: "1" },
    appCapabilities: {}
  }).then(function () {
    notify("ui/notifications/initialized", {});
    reportSize();
  });
})();
</script>
</body>
</html>
`;

const APP_PREVIEW_HTML = APP_PREVIEW_PAGE.replace(
  "__SHIM_SOURCE__",
  () => JSON.stringify(APP_PREVIEW_SHIM),
);

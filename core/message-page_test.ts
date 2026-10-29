import { assertEquals } from "@std/assert";
import {
  compactResult,
  compactToolCalls,
  messageWindowFrom,
  pageMessages,
} from "./message-page.ts";
import { TOOL_RESULT_INLINE_BYTES } from "./config.ts";

const all = [10, 20, 30, 40, 50].map((id) => ({ id }));
const ids = (page: { messages: { id: number }[] }) =>
  page.messages.map((m) => m.id);

Deno.test("the newest messages, and how many came before", () => {
  const page = pageMessages(all, { last: 2 });
  assertEquals(ids(page), [40, 50]);
  assertEquals(page.earlier, 3);
});

Deno.test("the page before a message", () => {
  const page = pageMessages(all, { last: 2, before: 40 });
  assertEquals(ids(page), [20, 30]);
  assertEquals(page.earlier, 1);
  assertEquals(pageMessages(all, { last: 5, before: 20 }), {
    messages: [{ id: 10 }],
    earlier: 0,
  });
});

Deno.test("everything from a message on", () => {
  const page = pageMessages(all, { since: 30 });
  assertEquals(ids(page), [30, 40, 50]);
  assertEquals(page.earlier, 2);
  assertEquals(pageMessages(all, { since: 99 }).messages, []);
});

Deno.test("a page bigger than the session is the session", () => {
  assertEquals(pageMessages(all, { last: 50 }), { messages: all, earlier: 0 });
});

Deno.test("the window comes from the query, or there is none", () => {
  const query = (q: Record<string, string>) => (name: string) => q[name];
  assertEquals(messageWindowFrom(query({})), null);
  assertEquals(messageWindowFrom(query({ limit: "all" })), null);
  assertEquals(messageWindowFrom(query({ last: "60", before: "7" })), {
    last: 60,
    before: 7,
    since: undefined,
  });
  assertEquals(messageWindowFrom(query({ last: "-1" })), null);
});

const big = "x".repeat(TOOL_RESULT_INLINE_BYTES + 1);

Deno.test("a small result goes whole", () => {
  const result = { ok: true, data: { rows: [1, 2] } };
  assertEquals(compactResult(result), result);
});

Deno.test("a big result goes as a stub with its outcome and changeset", () => {
  const changeset = { id: "cs_1", status: "in_progress", plan: { steps: [] } };
  const result = {
    ok: false,
    error: { code: "E" },
    _changeset: changeset,
    data: { screenshot: big },
  };
  assertEquals(compactResult(result), {
    _omitted: { bytes: JSON.stringify(result).length },
    ok: false,
    error: { code: "E" },
    _changeset: changeset,
  });
  const asData = compactResult({ ok: true, data: { ...changeset, log: big } });
  assertEquals((asData as { data: { id: string } }).data.id, "cs_1");
  assertEquals(Object.keys(compactResult(big) as object), ["_omitted"]);
});

Deno.test("only the results of a message's tool calls are cut", () => {
  const calls = [
    { name: "test_app", input: { a: 1 }, result: { ok: true, data: big } },
    { name: "list_routes", input: {}, result: { ok: true, data: [] } },
  ];
  const compact = JSON.parse(compactToolCalls(JSON.stringify(calls))!);
  assertEquals(compact[0].input, { a: 1 });
  assertEquals(compact[0].result.ok, true);
  assertEquals(compact[0].result.data, undefined);
  assertEquals(compact[1], calls[1]);
  assertEquals(compactToolCalls(null), null);
});

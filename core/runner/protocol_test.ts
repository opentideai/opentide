import { assert, assertEquals } from "@std/assert";
import {
  decodeRequest,
  decodeResponse,
  decodeValue,
  encodeRequest,
  encodeResponse,
  encodeValue,
  parseRpcMessage,
  RUNNER_ERROR_CODES,
} from "./protocol.ts";

function roundTrip(value: unknown): unknown {
  const encoded = encodeValue(value);
  assert(encoded.ok);
  return decodeValue(JSON.parse(JSON.stringify(encoded.data)));
}

Deno.test("values JSON mangles come back as themselves", () => {
  const value = {
    at: new Date("2026-11-05T10:00:00.000Z"),
    big: 9007199254740993n,
    bytes: new Uint8Array([0, 1, 254, 255]),
    missing: undefined,
    nums: [NaN, Infinity, -Infinity, -0, 1.5],
    nested: [{ deep: [new Date(0)] }],
    nil: null,
  };
  const back = roundTrip(value) as typeof value;
  assertEquals(back, value);
  assert(Object.is(back.nums[3], -0));
  assert("missing" in back);
});

Deno.test("user data with the tag key is not mistaken for a tagged value", () => {
  const value = { $rt: "date", v: "not a date", other: { $rt: 1 } };
  assertEquals(roundTrip(value), value);
});

Deno.test("values that aren't plain data fail loudly, with a path", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const cases: [unknown, string][] = [
    [{ a: [1, () => 0] }, "$.a[1] is a function"],
    [{ m: new Map() }, "$.m is a Map"],
    [{ s: Symbol("x") }, "$.s is a symbol"],
    [circular, "$.self is circular"],
  ];
  for (const [value, message] of cases) {
    const result = encodeValue(value);
    assert(!result.ok);
    assertEquals(result.error.code, RUNNER_ERROR_CODES.unserializable);
    assertEquals(result.error.message, message);
  }
});

Deno.test("the same object twice is fine; only a cycle fails", () => {
  const shared = { n: 1 };
  assertEquals(roundTrip([shared, shared]), [{ n: 1 }, { n: 1 }]);
});

Deno.test("parseRpcMessage keeps requests, notifications and responses, drops junk", () => {
  assertEquals(parseRpcMessage({ id: 1, method: "m", params: 2 }), {
    id: 1,
    method: "m",
    params: 2,
  });
  assertEquals(parseRpcMessage({ method: "n" }), {
    method: "n",
    params: undefined,
  });
  assertEquals(parseRpcMessage({ id: 3, result: null }), {
    id: 3,
    result: null,
  });
  assertEquals(
    parseRpcMessage({ id: 4, error: { code: "X", message: "y" } }),
    { id: 4, error: { code: "X", message: "y" } },
  );
  for (
    const junk of [
      null,
      "text",
      [],
      { id: 1.5, result: 1 },
      { id: 1 },
      { id: 1, error: "nope" },
      { result: 1 },
    ]
  ) {
    assertEquals(parseRpcMessage(junk), null, JSON.stringify(junk));
  }
});

Deno.test("a Request survives the wire, body and repeated headers included", async () => {
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("x-multi", "a");
  headers.append("x-multi", "b");
  const original = new Request("http://app.local/items?x=1", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "ü" }),
  });
  const wire = await encodeRequest(original);
  const encoded = encodeValue(wire);
  assert(encoded.ok);
  const back = decodeRequest(
    decodeValue(JSON.parse(JSON.stringify(encoded.data))) as typeof wire,
  );
  assertEquals(back.method, "POST");
  assertEquals(back.url, "http://app.local/items?x=1");
  assertEquals(back.headers.get("x-multi"), "a, b");
  assertEquals(await back.json(), { name: "ü" });
});

Deno.test("a GET Request has no body on the wire", async () => {
  const wire = await encodeRequest(new Request("http://app.local/"));
  assertEquals(wire.body, null);
  assertEquals(decodeRequest(wire).method, "GET");
});

Deno.test("a Response keeps status, every Set-Cookie and its bytes", async () => {
  const headers = new Headers();
  headers.append("set-cookie", "a=1");
  headers.append("set-cookie", "b=2");
  const original = new Response(new Uint8Array([1, 2, 3]), {
    status: 201,
    statusText: "Created",
    headers,
  });
  const back = decodeResponse(await encodeResponse(original));
  assertEquals(back.status, 201);
  assertEquals(back.statusText, "Created");
  assertEquals(back.headers.getSetCookie(), ["a=1", "b=2"]);
  assertEquals(
    new Uint8Array(await back.arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );
});

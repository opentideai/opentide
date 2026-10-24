import { assertEquals, assertStringIncludes } from "@std/assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { FakeModelProvider } from "./model-provider-fake.ts";
import type { ProviderEvent } from "./model-provider.ts";
import {
  createRecoveryChatRuntime,
  recoveryToolNames,
} from "./recovery-chat.ts";
import { getProjectPaths } from "./project-manager.ts";

async function withProject(fn: (projectDir: string) => Promise<void>) {
  const projectDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "genie-recovery-chat-",
  });
  try {
    const paths = getProjectPaths(projectDir);
    writeFileSync(paths.manifest, JSON.stringify({ name: "Recovery Chat" }));
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(`${paths.stateDir}/routes.json`, "[]");
    await fn(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

Deno.test("recovery chat exposes only read-only recovery tools and streams ChatEvents", async () => {
  await withProject(async (projectDir) => {
    const script: ProviderEvent[][] = [
      [
        {
          type: "tool_use_start",
          toolName: "inspect_recovery_state",
          toolInput: { projectPath: projectDir },
          toolCallId: "call_1",
        },
        { type: "message_complete", stopReason: "requires_action" },
      ],
      [
        { type: "text_delta", text: "Routes state is present. " },
        { type: "text_delta", text: "Use Attempt Repair first." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ];
    const provider = new FakeModelProvider(script);
    const runtime = createRecoveryChatRuntime(provider);
    const events: Array<{ type: string; text?: string; toolName?: string }> =
      [];

    const text = await runtime.sendMessage(
      { projectPath: projectDir, text: "what will I lose?" },
      (event) =>
        events.push({
          type: event.type,
          text: event.text,
          toolName: event.toolName,
        }),
    );

    assertEquals(text, "Routes state is present. Use Attempt Repair first.");
    assertEquals(provider.requests.length, 2);
    assertEquals(
      provider.requests[0]?.tools.map((tool) => tool.name),
      recoveryToolNames(),
    );
    assertEquals(
      provider.requests[0]?.tools.some((tool) => tool.name.includes("reset")),
      false,
    );
    assertEquals(events.map((event) => event.type), [
      "tool_use_start",
      "tool_use_end",
      "text_delta",
      "text_delta",
      "message_complete",
    ]);
    assertStringIncludes(
      provider.requests[0]?.system ?? "",
      "No Kernel is loaded",
    );
    assertStringIncludes(provider.requests[0]?.system ?? "", "read-only tools");
  });
});

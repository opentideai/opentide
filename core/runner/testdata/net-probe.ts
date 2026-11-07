// Run by net-boundary_integration_test.ts under the runner's flags. Fetches
// each URL it's given and prints, for each, "open", "denied" (Deno's
// permissions said no) or "refused" (allowed, but nothing answered).
const outcomes: Record<string, string> = {};
for (const url of Deno.args) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await res.body?.cancel();
    outcomes[url] = "open";
  } catch (err) {
    outcomes[url] = err instanceof Deno.errors.NotCapable
      ? "denied"
      : "refused";
  }
}
console.log(JSON.stringify(outcomes));

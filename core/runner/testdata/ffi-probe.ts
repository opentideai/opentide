// Run by net-boundary_integration_test.ts under the runner's flags: calls
// getpid() through libc and prints it, or the error's name.
const LIBC = Deno.build.os === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
try {
  const lib = Deno.dlopen(LIBC, { getpid: { parameters: [], result: "i32" } });
  console.log(JSON.stringify({ pid: lib.symbols.getpid() }));
} catch (err) {
  console.log(JSON.stringify({ error: (err as Error).name }));
}

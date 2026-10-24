---
description: "The database will not open (PgliteCorruptError): the recovery procedure, step by step."
disable-model-invocation: true
---

The project database will not open (PgliteCorruptError or similar). Walk the
user through recovery; do not improvise storage repairs.

- PgliteCorruptError, or a database that will not open: stop and tell the user. Do not repair storage by hand.
- INVALID_ARGUMENTS names the argument you meant. Fix the call and retry once.

The procedure, for the user to run with this server stopped:
1. Confirm nothing owns the database:
   ps -axo pid,ppid,command | grep -E 'mcp-main.ts|opentide' | grep -v grep
2. Archive the data directory before touching it:
   tar czf /tmp/<project>-data-<timestamp>.tgz data/
3. Try the bounded repair (attemptRepairDatabase). Expect it to fail; it usually does.
4. Restore from the newest backup in ~/.config/opentide/backups/<sha256 of the
   project path>, keeping the newer .opentide/state rather than the backup's.
5. Start the server again and confirm it logs that the project loaded and the
   MCP server is ready.
6. Call project_status and run_tests to confirm the restore.

Stop the server cleanly when finished: a clean shutdown flushes state, closes the
database and writes a fresh backup. Killing it is what corrupts the database.

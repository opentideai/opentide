// @layer shared — L0, the OpenTide *open* wire contract for the debugger surface:
// the breakpoint/pause/frame/variable shapes served by the /api/debug/* endpoints
// and the debug WebSocket. Type-only; imports NOTHING. Debugging is a core runtime
// capability (open). Consumed by the Deno backend (re-exported from
// core/debug-manager.ts) and the IDE (`$shared` alias). These are the shapes served
// verbatim (listBreakpoints() / the pauseState event), so cdpBreakpointId and
// scopeChain — internal detail that leaks to the wire — are part of the contract.

export interface BreakpointInfo {
  id: string;
  entityType: string;
  entityName: string;
  line: number;
  condition?: string;
  logMessage?: string;
  enabled: boolean;
  cdpBreakpointId?: string;
}

export interface CallFrame {
  callFrameId: string;
  functionName: string;
  url: string;
  entityType: string | null;
  entityName: string | null;
  line: number;
  column: number;
  scopeChain: unknown[];
}

export interface PauseState {
  reason: string;
  callFrames: CallFrame[];
  entityType: string | null;
  entityName: string | null;
  line: number;
}

export interface Variable {
  name: string;
  value: string;
  type: string;
  objectId?: string;
}

export interface LogpointOutput {
  entityType: string;
  entityName: string;
  line: number;
  message: string;
  timestamp: string;
}

export interface AgentResponse {
  apiVersion: 1;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

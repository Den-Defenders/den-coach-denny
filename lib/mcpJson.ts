/**
 * lib/mcpJson.ts
 *
 * Small helpers for calling the ServiceTitan MCP from server code (not from a
 * chat model) and getting plain JSON back. Every call still goes through the
 * read-only allow-list in lib/mcpToolPolicy.ts.
 */
import { auth0 } from "@/lib/auth0";
import { connectServiceTitanMcp } from "@/lib/serviceTitanMcp";
import { isToolAllowedForDenny } from "@/lib/mcpToolPolicy";

export type McpClient = Awaited<ReturnType<typeof connectServiceTitanMcp>>;

export class McpToolError extends Error {
  constructor(public toolName: string, message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

/** Open an MCP connection as the signed-in user. Caller must close() it. */
export async function openMcpForCurrentUser(): Promise<McpClient> {
  const { token } = await auth0.getAccessToken();
  if (!token) throw new Error("Missing ServiceTitan MCP access token");
  return connectServiceTitanMcp(token);
}

export async function callMcpJson<T = unknown>(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 120_000
): Promise<T> {
  if (!isToolAllowedForDenny(name)) {
    throw new McpToolError(name, `Tool ${name} is not on Denny's read-only allow-list.`);
  }

  const result = (await client.callTool({ name, arguments: args }, { timeout: timeoutMs })) as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };

  const text = (result.content || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");

  if (result.isError) {
    // Keep ServiceTitan's raw error text in the server log, not in the reply.
    console.error(`MCP tool ${name} failed:`, text.slice(0, 2000));
    throw new McpToolError(name, `ServiceTitan lookup "${name}" failed.`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * WRITE tools Denny may call. Deliberately separate from the read-only
 * allow-list (lib/mcpToolPolicy.ts) so the CSR chat can never reach them.
 * Only "Talk with Coach Denny" uses this, for add_job_note, after a spoken
 * preview and a yes. The MCP server enforces its own role check as well
 * (owner / operations, or the Auth0 "field_notes" role for notes only).
 */
const DENNY_WRITE_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(["add_job_note"]);

export async function callMcpWriteJson<T = unknown>(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 120_000
): Promise<T> {
  if (!DENNY_WRITE_TOOL_ALLOWLIST.has(name)) {
    throw new McpToolError(name, `Tool ${name} is not an allowed Denny write tool.`);
  }

  let result: { isError?: boolean; content?: { type: string; text?: string }[] };
  try {
    result = (await client.callTool({ name, arguments: args }, { timeout: timeoutMs })) as typeof result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`MCP write tool ${name} call failed:`, message);
    // The MCP answers 403 (or "tool not found") when the login lacks a write
    // role. Anything else (timeout, network) is NOT a permission problem, and
    // the write may or may not have happened.
    const refused = /\b403\b|forbidden|does not have a role|requires the owner|not found|unknown tool/i.test(message);
    throw new McpToolError(name, refused ? "NOT_ALLOWED" : "WRITE_FAILED");
  }

  const text = (result.content || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");

  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }

  if (result.isError) {
    const code = parsed && typeof parsed === "object" ? (parsed as { error?: string }).error : undefined;
    console.error(`MCP write tool ${name} returned an error:`, text.slice(0, 2000));
    throw new McpToolError(name, code || (/not found|unknown tool/i.test(text) ? "NOT_ALLOWED" : "WRITE_FAILED"));
  }
  return parsed as T;
}

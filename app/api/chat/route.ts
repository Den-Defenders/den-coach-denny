import OpenAI from "openai";
import { NextResponse } from "next/server";
import { COACH_CHAT_SYSTEM_PROMPT } from "@/app/lib/coachChatPrompt";
import { auth0 } from "@/lib/auth0";
import { connectServiceTitanMcp } from "@/lib/serviceTitanMcp";
import {
  filterToolsForDenny,
  isToolAllowedForDenny,
} from "@/lib/mcpToolPolicy";

export const runtime = "nodejs";
export const maxDuration = 300;

function formatMcpResult(result: unknown) {
  const text = JSON.stringify(result);

  if (text.length > 80000) {
    return `${text.slice(
      0,
      80000
    )}\n\n[Result shortened because it was very large.]`;
  }

  return text;
}

export async function POST(req: Request) {
  let mcpClient: Awaited<
    ReturnType<typeof connectServiceTitanMcp>
  > | null = null;

  try {
    const session = await auth0.getSession();

    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing OPENAI_API_KEY" },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));

    const input =
      typeof body?.input === "string" ? body.input.trim() : "";

    if (!input) {
      return NextResponse.json(
        { error: "Missing input" },
        { status: 400 }
      );
    }

    const tokenResponse = await auth0.getAccessToken();
    const accessToken = tokenResponse.token;

    if (!accessToken) {
      return NextResponse.json(
        { error: "Missing ServiceTitan MCP access token" },
        { status: 401 }
      );
    }

    mcpClient = await connectServiceTitanMcp(accessToken);

    const mcpToolList = await mcpClient.listTools();

    // READ-ONLY allow-list. The MCP server may advertise write tools to
    // privileged users; the CSR chat must never see or call them.
    const { allowed: allowedTools, hidden: hiddenTools } =
      filterToolsForDenny(mcpToolList.tools);

    if (hiddenTools.length > 0) {
      console.info(
        "Denny chat hid MCP tools not on the read-only allow-list:",
        hiddenTools.join(", ")
      );
    }

    const openAiTools = allowedTools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description:
          tool.description || `ServiceTitan tool: ${tool.name}`,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));

    const openai = new OpenAI({ apiKey });

    const messages: any[] = [
      {
        role: "system",
        content: `${COACH_CHAT_SYSTEM_PROMPT}

You also have access to live, READ-ONLY ServiceTitan MCP tools.

Use those tools whenever the user asks about customers, jobs, appointments,
technicians, estimates, invoices, payments, projects, or other ServiceTitan
information.

You cannot change anything in ServiceTitan from this chat. If the user asks
you to add a note, book, move or cancel something, explain that this chat is
read-only and they should make the change in ServiceTitan directly.

Never claim you checked ServiceTitan unless you actually used a tool.`,
      },
      {
        role: "user",
        content: input,
      },
    ];

    for (let round = 0; round < 8; round++) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages,
        tools: openAiTools,
        tool_choice: "auto",
      });

      const message = completion.choices?.[0]?.message;

      if (!message) {
        return NextResponse.json(
          { error: "OpenAI returned no message" },
          { status: 502 }
        );
      }

      messages.push(message);

      const toolCalls = message.tool_calls || [];

      if (toolCalls.length === 0) {
        const reply =
          message.content?.trim() || "No reply returned.";

        return NextResponse.json({ reply });
      }

      for (const toolCall of toolCalls) {
        if (toolCall.type !== "function") {
          continue;
        }

        // Second gate: refuse any tool the model names that is not on the
        // read-only allow-list, even if it somehow appeared in the tool list.
        if (!isToolAllowedForDenny(toolCall.function.name)) {
          console.warn(
            "Denny chat refused a tool call outside the read-only allow-list:",
            toolCall.function.name
          );

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              error: "TOOL_NOT_ALLOWED",
              message: `The tool "${toolCall.function.name}" is not available in this read-only chat.`,
            }),
          });

          continue;
        }

        let toolArguments: Record<string, unknown> = {};

        try {
          toolArguments = JSON.parse(
            toolCall.function.arguments || "{}"
          );
        } catch {
          toolArguments = {};
        }

        const toolResult = await mcpClient.callTool(
          {
            name: toolCall.function.name,
            arguments: toolArguments,
          },
          {
            timeout: 240_000,
          }
        );

        const toolResultText = formatMcpResult(toolResult);

        if (
          typeof toolResult === "object" &&
          toolResult !== null &&
          "isError" in toolResult &&
          toolResult.isError
        ) {
          return NextResponse.json(
            {
              error: `ServiceTitan tool failed: ${toolCall.function.name}`,
              details: toolResultText,
            },
            { status: 502 }
          );
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResultText,
        });
      }
    }

    return NextResponse.json(
      {
        error:
          "The request needed too many ServiceTitan tool steps. Please make the request more specific.",
      },
      { status: 500 }
    );
  } catch (err: any) {
    const status = err?.status || 500;
    const message = err?.message || String(err);

    return NextResponse.json(
      {
        error: "Server crashed in /api/chat",
        details: message,
      },
      { status }
    );
  } finally {
    if (mcpClient) {
      await mcpClient.close().catch(() => undefined);
    }
  }
}
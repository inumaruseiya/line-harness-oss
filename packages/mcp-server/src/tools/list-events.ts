import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, toToolResult } from "../api-call.js";
import { eventsQuery, resolveAccountId } from "./event-utils.js";

export function registerListEvents(server: McpServer): void {
  server.tool(
    "list_events",
    "イベント型予約 (Pochiko 相当) のイベント一覧。各イベントに next_slot_starts_at / total_capacity / total_active (active 予約数) / pending_count (承認待ち) が付く。",
    {
      accountId: z
        .string()
        .optional()
        .describe("LINE account ID (uses LINE_HARNESS_ACCOUNT_ID if omitted)"),
    },
    async ({ accountId }) => {
      try {
        const id = resolveAccountId(accountId);
        return toToolResult(await apiCall(`/api/events/admin/events${eventsQuery(id)}`));
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: String(error) }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

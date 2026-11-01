import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, toToolResult } from "../api-call.js";
import { eventsQuery, resolveAccountId } from "./event-utils.js";

/**
 * イベント予約 (event_bookings) の管理。
 * - list: 予約一覧 (friend 名付き)
 * - decide: confirm / reject — どちらも友人への LINE 通知とリマインダー作成
 *   (confirm の場合) が Worker により行われるため、実通信が発生する
 * - cancel: 管理者キャンセル (友人へ通知が飛ぶ)
 * - update_note: 内部メモ (通知は飛ばない)
 */
export function registerManageEventBookings(server: McpServer): void {
  server.tool(
    "manage_event_bookings",
    "イベント予約の管理。list: 一覧、decide: 承認/却下 (友人へLINE通知が飛ぶ)、cancel: 管理者キャンセル (友人へLINE通知が飛ぶ)、update_note: 内部メモ更新 (通知なし)。",
    {
      action: z.enum(["list", "decide", "cancel", "update_note"]).describe("Action"),
      eventId: z.string().describe("Event ID"),
      bookingId: z
        .string()
        .optional()
        .describe("Booking ID (required for decide, cancel, update_note)"),
      status: z
        .enum(["requested", "confirmed", "rejected", "cancelled", "expired", "no_show", "attended"])
        .optional()
        .describe("(list) filter by status"),
      slotId: z.string().optional().describe("(list) filter by slot"),
      decision: z
        .enum(["confirm", "reject"])
        .optional()
        .describe("(decide) confirm = 承認, reject = 却下"),
      reason: z.string().optional().describe("(decide reason=reject) 内部メモに残る却下理由"),
      internalNote: z.string().nullish().describe("(update_note) internal note (replaces)"),
      accountId: z.string().optional().describe("LINE account ID (uses default if omitted)"),
    },
    async ({ action, eventId, bookingId, status, slotId, decision, reason, internalNote, accountId }) => {
      try {
        const id = resolveAccountId(accountId);
        const base = `/api/events/admin/events/${eventId}/bookings`;

        if (action === "list") {
          return toToolResult(
            await apiCall(
              `${base}${eventsQuery(id, { status, slot_id: slotId })}`,
            ),
          );
        }

        if (action === "decide") {
          if (!bookingId) throw new Error("bookingId is required for decide");
          if (!decision) throw new Error("decision ('confirm' | 'reject') is required for decide");
          if (decision === "reject" && !reason) {
            throw new Error("reason is recommended (and required here) when rejecting");
          }
          return toToolResult(
            await apiCall(`${base}/${bookingId}/decide${eventsQuery(id)}`, "POST", {
              action: decision,
              ...(reason !== undefined ? { reason } : {}),
            }),
          );
        }

        if (action === "cancel") {
          if (!bookingId) throw new Error("bookingId is required for cancel");
          return toToolResult(
            await apiCall(`${base}/${bookingId}/cancel${eventsQuery(id)}`, "POST", {}),
          );
        }

        if (action === "update_note") {
          if (!bookingId) throw new Error("bookingId is required for update_note");
          return toToolResult(
            await apiCall(`${base}/${bookingId}${eventsQuery(id)}`, "PUT", {
              internal_note: internalNote ?? null,
            }),
          );
        }

        throw new Error(`Unknown action: ${action}`);
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

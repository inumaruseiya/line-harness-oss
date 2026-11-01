import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, toToolResult } from "../api-call.js";
import type { ApiCallResult } from "../api-call.js";
import { eventsQuery, resolveAccountId } from "./event-utils.js";

export function registerGetEvent(server: McpServer): void {
  server.tool(
    "get_event",
    "イベント型予約の 1 件詳細。includeBookings=true で予約枠 (slots) と予約一覧 (bookings, 友だち名/LINEユーザーID付き) も返す。",
    {
      eventId: z.string().describe("Event ID"),
      includeBookings: z
        .boolean()
        .optional()
        .describe("Also include slots and bookings (default true)"),
      bookingStatus: z
        .enum(["requested", "confirmed", "rejected", "cancelled", "expired", "no_show", "attended"])
        .optional()
        .describe("Filter bookings by status"),
      slotId: z.string().optional().describe("Filter bookings by slot"),
      accountId: z.string().optional().describe("LINE account ID (uses default if omitted)"),
    },
    async ({ eventId, includeBookings, bookingStatus, slotId, accountId }) => {
      try {
        const id = resolveAccountId(accountId);
        const withBookings = includeBookings ?? true;
        const parts: [string, string][] = [];
        if (withBookings) {
          parts.push(["fields", "event,slots,bookings"]);
        }
        if (bookingStatus !== undefined) parts.push(["booking_status", bookingStatus]);
        if (slotId !== undefined) parts.push(["slot_id", slotId]);

        if (!withBookings) {
          return toToolResult(
            await apiCall(`/api/events/admin/events/${eventId}${eventsQuery(id)}`),
          );
        }

        // 1 件本体 + slots + bookings を 3 リクエストに分けて返す (既存 API は複合エンドポイントを持たない)。
        const [event, slots, bookings] = await Promise.all([
          apiCall(`/api/events/admin/events/${eventId}${eventsQuery(id)}`),
          apiCall(
            `/api/events/admin/events/${eventId}/slots${eventsQuery(id)}`,
          ),
          apiCall(
            `/api/events/admin/events/${eventId}/bookings${eventsQuery(id, {
              status: bookingStatus,
              slot_id: slotId,
            })}`,
          ),
        ]);
        return toToolResult({
          ok: event.ok && slots.ok && bookings.ok,
          status: event.status,
          data: { event: event.data, slots: slots.data, bookings: bookings.data, _hints: [event.hint, slots.hint, bookings.hint].filter(Boolean) },
        } satisfies ApiCallResult);
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

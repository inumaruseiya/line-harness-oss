import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, toToolResult } from "../api-call.js";
import type { ApiCallResult } from "../api-call.js";
import type { SlotInput } from "./event-utils.js";
import { eventsQuery, mapSlot, resolveAccountId } from "./event-utils.js";

const slotSchema = z.object({
  startsAt: z.string().describe("Slot start (UTC ISO8601, e.g. 2026-11-10T02:00:00Z)"),
  endsAt: z.string().describe("Slot end (UTC ISO8601)"),
  capacity: z.number().int().nullish().describe("Max bookings for this slot (null = unlimited)"),
  isActive: z.number().int().optional().describe("1 = active (default), 0 = inactive"),
  sortOrder: z.number().int().optional().describe("Display order (default 0)"),
});

export function registerCreateEvent(server: McpServer): void {
  server.tool(
    "create_event",
    "イベント型予約のイベントを作成 (Pochiko 相当)。name は必須。slots を渡すと作成直後に枠も追加する。notification は送らない; isPublished=1 にすると LIFF 予約ページが有効化される。",
    {
      name: z.string().min(1).describe("Event name"),
      venueName: z.string().nullish().describe("Venue display name"),
      venueUrl: z.string().nullish().describe("Venue map / access URL"),
      description: z.string().nullish().describe("Free description (plain text)"),
      maxBookingsPerFriend: z
        .number()
        .int()
        .nullish()
        .describe("Max bookings per friend (null = unlimited)"),
      requiresApproval: z
        .boolean()
        .optional()
        .describe("Bookings start as 'requested' and need admin confirm (default false)"),
      cancelDeadlineHoursBefore: z
        .number()
        .int()
        .nullish()
        .describe("Self-cancel deadline in hours before start (null = always allowed)"),
      reminderDayBeforeEnabled: z
        .boolean()
        .optional()
        .describe("Send day-before reminder (default true)"),
      reminderHoursBefore: z
        .number()
        .int()
        .nullish()
        .describe("Send hours-before reminder at this offset (null = off)"),
      isPublished: z.number().int().optional().describe("1 = published (visible on LIFF), 0 = draft"),
      slots: z.array(slotSchema).optional().describe("Slots to create right after the event"),
      accountId: z.string().optional().describe("LINE account ID (uses default if omitted)"),
    },
    async ({
      name,
      venueName,
      venueUrl,
      description,
      maxBookingsPerFriend,
      requiresApproval,
      cancelDeadlineHoursBefore,
      reminderDayBeforeEnabled,
      reminderHoursBefore,
      isPublished,
      slots,
      accountId,
    }) => {
      try {
        const id = resolveAccountId(accountId);
        const body: Record<string, unknown> = { name };
        if (venueName !== null && venueName !== undefined) body.venue_name = venueName;
        if (venueUrl !== null && venueUrl !== undefined) body.venue_url = venueUrl;
        if (description !== null && description !== undefined) body.description = description;
        if (maxBookingsPerFriend !== null && maxBookingsPerFriend !== undefined) {
          body.max_bookings_per_friend = maxBookingsPerFriend;
        }
        if (requiresApproval !== undefined) body.requires_approval = requiresApproval ? 1 : 0;
        if (cancelDeadlineHoursBefore !== null && cancelDeadlineHoursBefore !== undefined) {
          body.cancel_deadline_hours_before = cancelDeadlineHoursBefore;
        }
        if (reminderDayBeforeEnabled !== undefined) {
          body.reminder_day_before_enabled = reminderDayBeforeEnabled ? 1 : 0;
        }
        if (reminderHoursBefore !== null && reminderHoursBefore !== undefined) {
          body.reminder_hours_before = reminderHoursBefore;
        }
        if (isPublished !== undefined) body.is_published = isPublished;

        const created = await apiCall(`/api/events/admin/events${eventsQuery(id)}`, "POST", body);
        if (!created.ok || !Array.isArray(slots) || slots.length === 0) {
          return toToolResult(created);
        }

        const eventId = (created.data as { id?: string } | null)?.id;
        if (!eventId) {
          return toToolResult({
            ...created,
            hint: "event created but response had no id; add slots via manage_events add_slots",
          } as ApiCallResult);
        }
        const added = await apiCall(
          `/api/events/admin/events/${eventId}/slots${eventsQuery(id)}`,
          "POST",
          { slots: (slots as SlotInput[]).map(mapSlot) },
        );
        return toToolResult({
          ok: added.ok,
          status: added.status,
          data: { event: created.data, slots: added.data },
        });
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, toToolResult } from "../api-call.js";
import type { SlotInput } from "./event-utils.js";
import { eventsQuery, mapSlot, resolveAccountId } from "./event-utils.js";

/**
 * イベント型予約の既存イベント操作。list/get/create は専用ツールに分離済み。
 * ここでは更新系のみ: update (部分更新) / add_slots / update_slot / delete。
 * delete は retaliation 防止のため confirmDelete=true 必須。delete は
 * deleted_at を立てるソフト削除。
 */
export function registerManageEvents(server: McpServer): void {
  server.tool(
    "manage_events",
    "既存イベントの操作。update: 部分更新、add_slots: 枠追加、update_slot: 枠更新 (capacity/is_active 等)、delete: ソフト削除 (confirmDelete=true 必須)。",
    {
      action: z.enum(["update", "add_slots", "update_slot", "delete"]).describe("Action"),
      eventId: z.string().describe("Event ID (required for all actions)"),
      name: z.string().optional().describe("(update) new event name"),
      venueName: z.string().nullish().describe("(update) venue display name"),
      venueUrl: z.string().nullish().describe("(update) venue URL"),
      description: z.string().nullish().describe("(update) description"),
      maxBookingsPerFriend: z.number().int().nullish().describe("(update)"),
      requiresApproval: z.boolean().optional().describe("(update)"),
      cancelDeadlineHoursBefore: z.number().int().nullish().describe("(update)"),
      reminderDayBeforeEnabled: z.boolean().optional().describe("(update)"),
      reminderHoursBefore: z.number().int().nullish().describe("(update)"),
      isPublished: z.number().int().optional().describe("(update) 1 = publish, 0 = unpublish"),
      slots: z
        .array(
          z.object({
            startsAt: z.string(),
            endsAt: z.string(),
            capacity: z.number().int().nullish(),
            isActive: z.number().int().optional(),
            sortOrder: z.number().int().optional(),
          }),
        )
        .optional()
        .describe("(add_slots) slots to add"),
      slotId: z.string().optional().describe("(update_slot) slot ID"),
      slotStartsAt: z.string().optional().describe("(update_slot) new start"),
      slotEndsAt: z.string().optional().describe("(update_slot) new end"),
      slotCapacity: z.number().int().nullish().describe("(update_slot) new capacity"),
      slotIsActive: z.number().int().optional().describe("(update_slot) 1/0"),
      confirmDelete: z
        .boolean()
        .optional()
        .describe("(delete) must be true to actually delete"),
      accountId: z.string().optional().describe("LINE account ID (uses default if omitted)"),
    },
    async ({
      action,
      eventId,
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
      slotId,
      slotStartsAt,
      slotEndsAt,
      slotCapacity,
      slotIsActive,
      confirmDelete,
      accountId,
    }) => {
      try {
        const id = resolveAccountId(accountId);
        const base = `/api/events/admin/events/${eventId}`;

        if (action === "update") {
          const body: Record<string, unknown> = {};
          if (name !== undefined) body.name = name;
          if (venueName !== undefined) body.venue_name = venueName;
          if (venueUrl !== undefined) body.venue_url = venueUrl;
          if (description !== undefined) body.description = description;
          if (maxBookingsPerFriend !== undefined) body.max_bookings_per_friend = maxBookingsPerFriend;
          if (requiresApproval !== undefined) body.requires_approval = requiresApproval ? 1 : 0;
          if (cancelDeadlineHoursBefore !== undefined) {
            body.cancel_deadline_hours_before = cancelDeadlineHoursBefore;
          }
          if (reminderDayBeforeEnabled !== undefined) {
            body.reminder_day_before_enabled = reminderDayBeforeEnabled ? 1 : 0;
          }
          if (reminderHoursBefore !== undefined) body.reminder_hours_before = reminderHoursBefore;
          if (isPublished !== undefined) body.is_published = isPublished;
          if (Object.keys(body).length === 0) {
            throw new Error("updatable field is required for update");
          }
          return toToolResult(await apiCall(`${base}${eventsQuery(id)}`, "PUT", body));
        }

        if (action === "add_slots") {
          if (!Array.isArray(slots) || slots.length === 0) {
            throw new Error("slots is required for add_slots");
          }
          return toToolResult(
            await apiCall(`${base}/slots${eventsQuery(id)}`, "POST", {
              slots: (slots as SlotInput[]).map(mapSlot),
            }),
          );
        }

        if (action === "update_slot") {
          if (!slotId) throw new Error("slotId is required for update_slot");
          const body: Record<string, unknown> = {};
          if (slotStartsAt !== undefined) body.starts_at = slotStartsAt;
          if (slotEndsAt !== undefined) body.ends_at = slotEndsAt;
          if (slotCapacity !== undefined) body.capacity = slotCapacity;
          if (slotIsActive !== undefined) body.is_active = slotIsActive;
          if (Object.keys(body).length === 0) {
            throw new Error("at least one slot field is required for update_slot");
          }
          return toToolResult(
            await apiCall(`${base}/slots/${slotId}${eventsQuery(id)}`, "PUT", body),
          );
        }

        if (action === "delete") {
          if (!confirmDelete) {
            throw new Error("confirmDelete=true is required for delete (bookings become invisible)");
          }
          return toToolResult(await apiCall(`${base}${eventsQuery(id)}`, "DELETE"));
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

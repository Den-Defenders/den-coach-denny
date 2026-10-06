/**
 * lib/mcpToolPolicy.ts
 *
 * Which ServiceTitan MCP tools the Den Coach Denny web app is allowed to hand
 * to its AI models. This is a FAIL-CLOSED allow-list: a tool the MCP server
 * advertises that is not listed here is filtered out before the model sees it,
 * and refused if the model asks for it anyway.
 *
 * Why: the MCP server is gaining WRITE tools (the first is add_job_note).
 * Denny is a CSR-facing chat and must stay read-only until a write flow is
 * deliberately designed for it. Adding a tool here is an explicit decision.
 *
 * Keep this list in sync with the READ tools in servicetitan-mcp/index.js
 * (DEN_DEFENDERS_ALL_TOOL_NAMES minus DEN_DEFENDERS_WRITE_TOOL_NAMES).
 */

export const DENNY_READ_ONLY_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "list_customers",
  "search_customers",
  "get_customer_jobs",
  "search_open_invoices",
  "search_payments",
  "get_customer_contacts",
  "collections_call_list",
  "get_job_notes",
  "get_job_forms",
  "get_job_appointments",
  "get_job_estimates",
  "get_job_invoices",
  "get_project_details",
  "get_job_history",
  "get_job_cancellation_details",
  "get_install_hardware_order_report",
  "get_technician_roster",
  "get_technician_shifts",
  "get_dispatch_board",
  "get_installer_availability",
  "get_drive_times",
  "recommend_install_schedule",
  "recommend_sales_schedule",
  "get_operations_command_center",
  "audit_install_readiness",
  "find_dispatch_problems",
  "find_stuck_projects",
  "get_customer_risk_report",
  "forecast_install_capacity",
  "find_revenue_fill_opportunities",
  "audit_production_dispatch_handoff",
  "get_tomorrow_dispatch_brief",
  "find_schedule_improvements",
  "get_installer_utilization_report",
  "get_weekly_operations_review",
  "hatch_search_contacts",
  "hatch_get_conversation_history",
  "hatch_search_message_history",
  "hatch_bulk_export_status",
  "hatch_sync_database_window",
  "hatch_preview_contact_backfill_window",
  "hatch_database_status",
  "hatch_stored_search_contacts",
  "hatch_stored_conversation_history",
  "hatch_stored_search_messages",
  "hatch_conversion_audit_pilot",
  "hatch_conversation_match_pilot",
  "hatch_booking_evidence_pilot",
  "hatch_booking_batch_pilot",
  "hatch_booking_saved_results",
  "get_business_time",
  "get_servicetitan_sms_sent_history",
  "get_servicetitan_inbound_sms_history",
  "get_servicetitan_customer_calls",
  "get_servicetitan_call_transcript",
  "get_servicetitan_customer_call_360",
]);

/**
 * Belt-and-braces: even if a name were ever added to the allow-list by
 * mistake, anything that looks like a mutation is still refused.
 */
const WRITE_LIKE_NAME =
  /^(add|create|update|set|write|delete|remove|cancel|book|schedule|reschedule|move|assign|unassign|hold|release|post|edit|patch)_/i;

export function isToolAllowedForDenny(toolName: string): boolean {
  if (!toolName) return false;
  if (WRITE_LIKE_NAME.test(toolName)) return false;
  return DENNY_READ_ONLY_TOOL_ALLOWLIST.has(toolName);
}

/**
 * Filter an MCP tools/list result down to what Denny may expose.
 * Returns the allowed tools and the names that were hidden (for logging).
 */
export function filterToolsForDenny<T extends { name: string }>(
  tools: readonly T[]
): { allowed: T[]; hidden: string[] } {
  const allowed: T[] = [];
  const hidden: string[] = [];
  for (const tool of tools) {
    if (isToolAllowedForDenny(tool.name)) allowed.push(tool);
    else hidden.push(tool.name);
  }
  return { allowed, hidden };
}

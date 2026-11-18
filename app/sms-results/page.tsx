import { notFound } from "next/navigation";
import DenShell from "@/app/components/DenShell";
import { textingAdminRole } from "@/lib/ownerAccess";
import LeadResults from "./LeadResults";

export const dynamic = "force-dynamic";

/** Lead results report (owners + managers): replies, calls, bookings by form choice and ad set. */
export default async function LeadResultsPage() {
  if (!await textingAdminRole()) notFound();
  return (
    <DenShell title="Lead results" subtitle="What form leads did after Denny texted them" theme="texting">
      <LeadResults />
    </DenShell>
  );
}

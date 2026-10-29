import { notFound } from "next/navigation";
import DenShell from "@/app/components/DenShell";
import { canViewOwner } from "@/lib/ownerAccess";
import SmsSimulator from "./SmsSimulator";

export const dynamic = "force-dynamic";

/** Owner-only Simulator: test the texting AI with pretend customers (nothing is texted). */
export default async function SmsSimPage() {
  if (!await canViewOwner()) notFound();
  return (
    <DenShell title="Texting Simulator" subtitle="Test the texting AI without sending texts" theme="simulator">
      <SmsSimulator />
    </DenShell>
  );
}

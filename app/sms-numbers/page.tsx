import { notFound } from "next/navigation";
import DenShell from "@/app/components/DenShell";
import { canViewOwner } from "@/lib/ownerAccess";
import TextingNumbers from "./TextingNumbers";

export const dynamic = "force-dynamic";

/** Session 8: owner-only page for our Twilio numbers and which ad sets use them (linked from /sms-test). */
export default async function TextingNumbersPage() {
  if (!await canViewOwner()) notFound();
  return (
    <DenShell title="Texting numbers" subtitle="Which number each new lead gets texted from" theme="texting">
      <TextingNumbers />
    </DenShell>
  );
}

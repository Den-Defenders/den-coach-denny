import { notFound } from "next/navigation";
import DenShell from "@/app/components/DenShell";
import { canViewOwner } from "@/lib/ownerAccess";
import SmsTester from "./SmsTester";

export const dynamic = "force-dynamic";

/** Owner-only page for testing texts on the pilot number (not in the menu). */
export default async function SmsTestPage() {
  if (!await canViewOwner()) notFound();
  return (
    <DenShell title="Texting test" subtitle="Pilot number (916) 891-1680" theme="texting">
      <SmsTester />
    </DenShell>
  );
}

import { notFound } from "next/navigation";
import DenShell from "@/app/components/DenShell";
import { textingAdminRole } from "@/lib/ownerAccess";
import SmsTester from "./SmsTester";

export const dynamic = "force-dynamic";

/** Texting setup & test page: owners and managers (linked under the Texting inbox). */
export default async function SmsTestPage() {
  const role = await textingAdminRole();
  if (!role) notFound();
  return (
    <DenShell title="Texting test" subtitle="Texting setup and tests" theme="texting">
      <div className="hero-actions" style={{ marginBottom: 14 }}>
        <a className="btn btn-outline" href="/texting">Back to Texting</a>
        <a className="btn btn-outline" href="/sms-results">Lead results</a>
        {role === "owner" && <a className="btn btn-outline" href="/sms-numbers">Texting numbers</a>}
        {role === "owner" && <a className="btn btn-outline" href="/door-photos">Door photos for the bot</a>}
      </div>
      <SmsTester />
    </DenShell>
  );
}

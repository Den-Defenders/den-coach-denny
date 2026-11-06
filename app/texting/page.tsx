import { notFound } from "next/navigation";
import DenShell from "@/app/components/DenShell";
import { canAccessTextingInbox } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";
import TextingInbox from "./TextingInbox";

export const dynamic = "force-dynamic";

/** The Texting inbox: every customer conversation on the Twilio numbers, "Needs CSR" first. */
export default async function TextingPage() {
  const access = await getCurrentAccess();
  if (!access || !canAccessTextingInbox(access)) notFound();
  const owner = access.role === "owner";
  return (
    <DenShell title="Texting" subtitle="Customer texts, Needs CSR first" theme="texting">
      <TextingInbox />
      {owner && (
        <div className="hero-actions inbox-owner-links">
          <a className="btn btn-outline btn-small" href="/sms-test">Texting setup &amp; test page</a>
          <a className="btn btn-outline btn-small" href="/door-photos">Door photos for the AI</a>
        </div>
      )}
    </DenShell>
  );
}

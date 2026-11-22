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
  // Owners + managers see Lead results and the setup & test page under the inbox (numbers + photos: owners).
  // The links live in TextingInbox so they follow "View as".
  return (
    <DenShell title="The Fox Hole" subtitle="Customer texts, Needs CSR first" theme="texting">
      <TextingInbox myRole={access.role} />
    </DenShell>
  );
}

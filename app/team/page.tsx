import { notFound } from "next/navigation";
import DenShell from "@/app/components/DenShell";
import { canManageTeam } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";
import TeamManager from "./TeamManager";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const access = await getCurrentAccess();
  if (!access || !canManageTeam(access.role)) notFound();
  return (
    <DenShell title="Team" subtitle="Who can use Den Coach Denny" theme="team">
      <TeamManager viewerRole={access.role === "owner" ? "owner" : "manager"} />
    </DenShell>
  );
}

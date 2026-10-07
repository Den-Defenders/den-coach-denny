import { notFound } from "next/navigation";
import DenShell from "@/app/components/DenShell";
import { canViewOwner } from "@/lib/ownerAccess";
import TeamManager from "./TeamManager";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  if (!await canViewOwner()) notFound();
  return (
    <DenShell title="Team" subtitle="Who can use Den Coach Denny" theme="team">
      <TeamManager />
    </DenShell>
  );
}

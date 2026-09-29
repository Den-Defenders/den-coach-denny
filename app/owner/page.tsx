import { notFound } from "next/navigation";
import { canViewOwner } from "@/lib/ownerAccess";
import DenShell from "@/app/components/DenShell";
import OwnerDashboard from "./OwnerDashboard";

export const dynamic = "force-dynamic";

export default async function OwnerPage() {
  if (!await canViewOwner()) notFound();
  return <DenShell title="Owner dashboard" theme="owner">
    <OwnerDashboard />
  </DenShell>;
}

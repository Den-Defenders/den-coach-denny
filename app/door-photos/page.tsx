import { notFound } from "next/navigation";
import DenShell from "@/app/components/DenShell";
import { canViewOwner } from "@/lib/ownerAccess";
import DoorPhotos from "./DoorPhotos";

export const dynamic = "force-dynamic";

/** Owner-only library of door photos the texting bot can send (linked from the Texting page). */
export default async function DoorPhotosPage() {
  if (!await canViewOwner()) notFound();
  return (
    <DenShell title="Door photos" subtitle="Photos the texting bot can send" theme="texting">
      <DoorPhotos />
    </DenShell>
  );
}

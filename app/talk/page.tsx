import Image from "next/image";
import DenShell from "@/app/components/DenShell";
import FieldVoiceDenny from "@/app/components/FieldVoiceDenny";
import { crewPositionFor, seesAllTechnicians } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";

export const dynamic = "force-dynamic";

export default async function TalkPage() {
  const access = await getCurrentAccess();
  const firstName = (access?.displayName || "").split(" ")[0];
  const linked = Boolean(access?.member?.stTechnicianId);
  const seesAll = access ? seesAllTechnicians(access.role) : false;
  const crewPosition = access ? crewPositionFor(access.role) : null;
  const crew = crewPosition === "Installer" ? "any installer" : crewPosition === "Sales" ? "any sales rep" : null;

  return (
    <DenShell title="Talk with Coach Denny" subtitle="Your schedule and customer 360, by voice" theme="talk">
      <div className="talk-page">
        <section className="talk-hero">
          <div>
            <p className="eyebrow">Hands-free in the field</p>
            <h1 className="display-title">{firstName ? `Hey ${firstName}, ` : ""}<span>just ask Denny.</span></h1>
            <p>Ask about your schedule, get a full 360 on your next customer or any address, check when a sales rep can come out, or have Denny add a note to your job.</p>
            {seesAll && <p>You can also ask about any technician by name, like &ldquo;What does Juan have tomorrow?&rdquo;</p>}
            {crew && <p>As a team lead, you can also ask about {crew} by name, like &ldquo;What&rsquo;s Juan&rsquo;s next job?&rdquo;, and add notes to their jobs.</p>}
          </div>
          <Image src="/brand/denny.png" alt="Coach Denny" width={260} height={260} priority />
        </section>

        {!linked && (
          <div className="notice">
            {seesAll
              ? "Your login isn't linked to a ServiceTitan technician. Address lookups work; for schedules, name the technician."
              : "Your login isn't linked to your ServiceTitan name yet, so \"my schedule\" won't work. Ask an owner or manager to link you on the Team page."}
          </div>
        )}

        <FieldVoiceDenny />
      </div>
    </DenShell>
  );
}

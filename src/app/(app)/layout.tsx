import { Sidebar } from "@/components/app/sidebar";
import { Topbar } from "@/components/app/topbar";
import { NAV_SECTIONS } from "@/components/app/nav";
import { can } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { mtx } from "@/lib/mediamtx/client";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  const sections = NAV_SECTIONS.map((s) => ({
    title: s.title,
    items: s.items.filter((i) => !i.permission || can(user, i.permission)),
  })).filter((s) => s.items.length > 0);

  const streamingOnline = await mtx
    .info()
    .then(() => true)
    .catch(() => false);

  return (
    <div className="flex min-h-dvh">
      <Sidebar sections={sections} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={{ name: user.name, email: user.email, role: user.role }} streamingOnline={streamingOnline} />
        <main className="flex-1 px-4 py-5 lg:px-6 lg:py-6">
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

import PortalLiveSync from "@/components/PortalLiveSync";
import { createClient } from "@/lib/supabase/server";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <>
      {user && <PortalLiveSync userId={user.id} />}
      {children}
    </>
  );
}

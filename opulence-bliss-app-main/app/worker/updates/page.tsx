import NotificationsList from "@/components/NotificationsList";

export default function ProviderUpdatesPage() {
  return (
    <main style={{ maxWidth: 700, fontFamily: "'Nunito', system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 30, fontWeight: 900, letterSpacing: "-0.025em", margin: "0 0 4px", color: "#16202A" }}>Updates</h1>
      <p style={{ color: "#7A828C", fontSize: 16, fontWeight: 600, margin: "0 0 22px" }}>Offers, confirmations, payments and reviews.</p>
      <NotificationsList />
    </main>
  );
}

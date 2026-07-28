import { headers } from "next/headers";
import { getChatGPTUser } from "./chatgpt-auth";
import PantryApp from "./PantryApp";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [user, requestHeaders] = await Promise.all([getChatGPTUser(), headers()]);
  const host = requestHeaders.get("host") ?? "";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const viewer = user
    ? { displayName: user.displayName, email: user.email, isDemo: false }
    : isLocal
      ? { displayName: "デモユーザー", email: "demo@localhost", isDemo: true }
      : null;

  return <PantryApp viewer={viewer} />;
}

import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAuth } from "../server/auth";
import SettingsForm from "./settings-form";

export default async function SettingsPage() {
  const session = await createAuth(env).api.getSession({
    headers: new Headers(await headers()),
  });
  if (!session || session.user.status !== "active") {
    redirect("/");
  }

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <a className="home-brand" href="/">koge</a>
        <a className="settings-back" href="/">ルーム一覧へ戻る</a>
      </header>
      <section className="settings-intro">
        <p>アカウント</p>
        <h1>設定</h1>
        <span>プロフィールとアカウントを管理します。</span>
      </section>
      <SettingsForm
        email={session.user.email}
        initialImage={session.user.image ?? null}
        initialName={session.user.name}
      />
    </main>
  );
}

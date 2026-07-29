import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import AuthActions from "./auth-actions";
import { createAuth } from "./server/auth";
import {
  listOwnedLiveRoomSlugs,
  listPublicRooms,
  type PublicRoom,
} from "./server/rooms";

const STATUS_LABELS: Record<PublicRoom["status"], string> = {
  active: "お絵描き中",
  waiting: "参加待ち",
  idle: "ひと休み中",
};

export default async function Home() {
  const requestHeaders = new Headers(await headers());
  const [session, rooms] = await Promise.all([
    createAuth(env).api.getSession({ headers: requestHeaders }),
    listPublicRooms(env.DB),
  ]);
  const activeUser = session?.user.status === "active" ? session.user : null;
  const ownedRoomSlugs = activeUser
    ? await listOwnedLiveRoomSlugs(env.DB, activeUser.id)
    : new Set<string>();

  return (
    <main className="home-shell">
      <header className="home-header">
        <a className="home-brand" href="/">koge</a>
        <div className="home-account">
          {activeUser ? (
            <span className="home-user">{activeUser.name}</span>
          ) : (
            <span className="home-user">ゲスト</span>
          )}
          <AuthActions isAuthenticated={Boolean(activeUser)} />
        </div>
      </header>

      <section className="home-intro">
        <div>
          <p className="home-kicker">開催中のルーム</p>
          <h1>いま描ける場所を見つける</h1>
          <p>
            ログインしなくても公開ルームを見たり、ゲストとして参加できます。
          </p>
        </div>
      </section>

      <section aria-labelledby="public-rooms-heading" className="home-rooms">
        <div className="home-section-heading">
          <div>
            <h2 id="public-rooms-heading">公開ルーム</h2>
            <p>{rooms.length}件が開催中です</p>
          </div>
        </div>

        {rooms.length === 0 ? (
          <div className="home-empty">
            <span aria-hidden="true">○</span>
            <h3>いま開催中の公開ルームはありません</h3>
            <p>
              {activeUser
                ? "最初のルームを作って、誰かを待ってみましょう。"
                : "ログインすると、新しいルームを作れます。"}
            </p>
          </div>
        ) : (
          <div className="home-room-grid">
            {rooms.map((room) => (
              <article className="home-room-card" key={room.publicSlug}>
                <div className="home-room-paper" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="home-room-body">
                  <div className="home-room-status">
                    <span className={`status-${room.status}`} />
                    {STATUS_LABELS[room.status]}
                    {ownedRoomSlugs.has(room.publicSlug) ? (
                      <em>あなたのルーム</em>
                    ) : null}
                  </div>
                  <h3>{room.name}</h3>
                  <p>{room.theme || "お題なし"}</p>
                  <div className="home-room-footer">
                    <span>
                      描く人 {room.participantCount}/{room.participantLimit}
                    </span>
                    <span>
                      見る人 {room.viewerCount}/{room.viewerLimit}
                    </span>
                    <a href={`/rooms/${encodeURIComponent(room.publicSlug)}`}>
                      入る
                    </a>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

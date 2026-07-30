import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import AuthActions from "./auth-actions";
import DrawingRoom from "./drawing-room";
import { createAuth } from "./server/auth";
import {
  listOwnedLiveRoomSlugs,
  listPublicRooms,
  type PublicRoom,
} from "./server/rooms";

const STATUS_LABELS: Record<PublicRoom["status"], string> = {
  active: "お絵描き中",
  waiting: "準備中",
  idle: "ひと休み中",
};

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{
    accountDeleted?: string;
    room?: string;
    sync?: string;
  }>;
}) {
  const parameters = await searchParams;
  if (
    env.APP_ENV === "local"
    && parameters?.sync === "1"
    && parameters.room
  ) {
    return <DrawingRoom roomName="E2E同期ルーム" />;
  }
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
            <a
              className="home-profile-link"
              href="/settings"
              aria-label="アカウント設定"
            >
              <span className="home-profile-avatar" aria-hidden="true">
                {activeUser.image ? (
                  <img alt="" src={activeUser.image} />
                ) : (
                  [...activeUser.name].slice(0, 1).join("").toUpperCase()
                )}
              </span>
              <span className="home-user">{activeUser.name}</span>
            </a>
          ) : (
            <span className="home-user">ゲスト</span>
          )}
          <AuthActions isAuthenticated={Boolean(activeUser)} />
        </div>
      </header>

      <section aria-labelledby="public-rooms-heading" className="home-rooms">
        {parameters?.accountDeleted === "1" ? (
          <p className="home-account-notice" role="status">
            アカウントの削除を受け付けました。
          </p>
        ) : null}
        <div className="home-section-heading">
          <div>
            <h2 id="public-rooms-heading">公開ルーム</h2>
            <p>{rooms.length}件が開催中です</p>
          </div>
        </div>

        {rooms.length === 0 ? (
          <div className="home-empty">
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
                  {env.THUMBNAIL_ENABLED === "true"
                      && room.thumbnailVersion !== null
                    ? (
                      <img
                        alt=""
                        src={`/api/rooms/${
                          encodeURIComponent(room.publicSlug)
                        }/thumbnail?v=${room.thumbnailVersion}`}
                      />
                    )
                    : null}
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

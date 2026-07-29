import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import DrawingRoom from "../../drawing-room";
import { createAuth } from "../../server/auth";
import { getLiveRoomDisplayInfo } from "../../server/rooms";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [room, session] = await Promise.all([
    getLiveRoomDisplayInfo(env.DB, slug),
    createAuth(env).api.getSession({
      headers: new Headers(await headers()),
    }),
  ]);
  const isAuthenticated = session?.user.status === "active";
  return (
    <DrawingRoom
      isAuthenticated={isAuthenticated}
      roomSlug={slug}
      roomName={room?.name ?? "お絵描きルーム"}
    />
  );
}

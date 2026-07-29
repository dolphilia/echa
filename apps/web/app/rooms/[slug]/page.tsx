import { env } from "cloudflare:workers";
import DrawingRoom from "../../drawing-room";
import { getLiveRoomDisplayInfo } from "../../server/rooms";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const room = await getLiveRoomDisplayInfo(env.DB, slug);
  return (
    <DrawingRoom
      roomSlug={slug}
      roomName={room?.name ?? "お絵描きルーム"}
    />
  );
}

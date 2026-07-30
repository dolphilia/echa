import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import AdminRoomConsole from "./room-console";
import {
  CloudflareAccessAuthorizationError,
  CloudflareAccessConfigurationError,
  verifyCloudflareAdminAccess,
} from "../../server/admin-access";
import { listAdminRooms } from "../../server/admin-moderation";
import { readServiceControls } from "../../server/service-controls";
import {
  SERVICE_LIVE_ROOM_HARD_LIMIT,
  SERVICE_ROOM_CONNECTION_HARD_LIMIT,
  readServiceCapacityLimits,
} from "../../server/service-capacity";
import { listAdminServiceBans } from "../../server/service-bans";

export const dynamic = "force-dynamic";

export default async function AdminRoomsPage() {
  const requestHeaders = new Headers(await headers());
  try {
    await verifyCloudflareAdminAccess(requestHeaders, env);
  } catch (error) {
    const configurationError =
      error instanceof CloudflareAccessConfigurationError;
    if (
      configurationError
      || error instanceof CloudflareAccessAuthorizationError
    ) {
      return (
        <main className="admin-shell">
          <section className="admin-denied">
            <p className="admin-kicker">koge administration</p>
            <h1>管理画面を開けません</h1>
            <p>
              {configurationError
                ? "管理者認証の設定を確認してください。"
                : "Cloudflare Accessでの管理者認証が必要です。"}
            </p>
          </section>
        </main>
      );
    }
    throw error;
  }

  const [rooms, controls, capacityLimits, serviceBans] = await Promise.all([
    listAdminRooms(env.DB),
    readServiceControls(env.DB),
    readServiceCapacityLimits(env.DB),
    listAdminServiceBans(env.DB),
  ]);
  return (
    <AdminRoomConsole
      capacityHardLimits={{
        liveRooms: SERVICE_LIVE_ROOM_HARD_LIMIT,
        roomConnections: SERVICE_ROOM_CONNECTION_HARD_LIMIT,
      }}
      initialCapacityLimits={capacityLimits}
      initialControls={controls}
      initialRooms={rooms}
      initialServiceBans={serviceBans}
    />
  );
}

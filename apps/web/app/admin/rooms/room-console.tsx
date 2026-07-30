"use client";

import { useState } from "react";
import type { ActiveRoomMember } from "@koge/protocol";
import type {
  AdminRoom,
  AdminModerationInput,
} from "../../server/admin-moderation";
import type { ServiceControls } from "../../server/service-controls";
import type { ServiceCapacityLimits } from "../../server/service-capacity";
import type { AdminServiceBan } from "../../server/service-bans";

const STATUS_LABELS: Record<AdminRoom["status"], string> = {
  waiting: "準備中",
  active: "開催中",
  idle: "休止中",
  suspended: "管理停止中",
  closing: "終了処理中",
};

const ROLE_LABELS: Record<ActiveRoomMember["role"], string> = {
  host: "ホスト",
  participant: "描く人",
  viewer: "見る人",
};

type Notice = {
  kind: "success" | "error";
  message: string;
} | null;

export default function AdminRoomConsole({
  capacityHardLimits,
  initialCapacityLimits,
  initialControls,
  initialRooms,
  initialServiceBans,
}: {
  capacityHardLimits: {
    liveRooms: number;
    roomConnections: number;
  };
  initialCapacityLimits: ServiceCapacityLimits;
  initialControls: ServiceControls;
  initialRooms: AdminRoom[];
  initialServiceBans: AdminServiceBan[];
}) {
  const [capacityLimits, setCapacityLimits] = useState(initialCapacityLimits);
  const [capacityDraft, setCapacityDraft] = useState(initialCapacityLimits);
  const [capacityReason, setCapacityReason] = useState("");
  const [controls, setControls] = useState(initialControls);
  const [controlDraft, setControlDraft] = useState(initialControls);
  const [controlReason, setControlReason] = useState("");
  const [rooms, setRooms] = useState(initialRooms);
  const [serviceBans, setServiceBans] = useState(initialServiceBans);
  const [membersByRoom, setMembersByRoom] = useState<
    Record<string, readonly ActiveRoomMember[]>
  >({});
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [serviceBanDurations, setServiceBanDurations] = useState<
    Record<string, 24 | 168 | 720>
  >({});
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function applyCapacityLimits(): Promise<void> {
    const reason = capacityReason.trim();
    const total = capacityDraft.participantLimit + capacityDraft.viewerLimit;
    if (!reason) {
      setNotice({
        kind: "error",
        message: "利用上限を変更する理由を入力してください。",
      });
      return;
    }
    if (
      !Number.isSafeInteger(capacityDraft.liveRoomLimit)
      || capacityDraft.liveRoomLimit < 1
      || capacityDraft.liveRoomLimit > capacityHardLimits.liveRooms
      || !Number.isSafeInteger(capacityDraft.participantLimit)
      || capacityDraft.participantLimit < 1
      || !Number.isSafeInteger(capacityDraft.viewerLimit)
      || capacityDraft.viewerLimit < 0
      || total > capacityHardLimits.roomConnections
    ) {
      setNotice({
        kind: "error",
        message: `描く人と見る人の合計は${
          capacityHardLimits.roomConnections
        }人以下にしてください。`,
      });
      return;
    }
    if (
      !window.confirm(
        "利用上限を変更しますか？変更は新しく作成されるルームから適用されます。",
      )
    ) return;

    setPendingKey("capacity");
    setNotice(null);
    try {
      const response = await fetch("/api/admin/capacity", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          liveRoomLimit: capacityDraft.liveRoomLimit,
          participantLimit: capacityDraft.participantLimit,
          viewerLimit: capacityDraft.viewerLimit,
          publicRoomsOnly: capacityDraft.publicRoomsOnly,
          reason,
        }),
      });
      const body = await response.json() as {
        error?: string;
        limits?: ServiceCapacityLimits;
      };
      if (!response.ok || !body.limits) {
        throw new Error("利用上限を更新できませんでした。");
      }
      setCapacityLimits(body.limits);
      setCapacityDraft(body.limits);
      setCapacityReason("");
      setNotice({
        kind: "success",
        message: "利用上限を更新しました。",
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error
          ? error.message
          : "利用上限の更新に失敗しました。",
      });
    } finally {
      setPendingKey(null);
    }
  }

  async function applyEmergencyControls(): Promise<void> {
    const reason = controlReason.trim();
    if (!reason) {
      setNotice({
        kind: "error",
        message: "緊急制御を変更する理由を入力してください。",
      });
      return;
    }
    const disabledLabels = [
      !controlDraft.roomCreationEnabled ? "新規ルーム作成" : null,
      !controlDraft.roomEntryEnabled ? "新規入室" : null,
      !controlDraft.drawingEnabled ? "描画受付" : null,
    ].filter((label): label is string => label !== null);
    const summary = disabledLabels.length === 0
      ? "すべてのサービス制御を解除"
      : `${disabledLabels.join("・")}を停止`;
    if (!window.confirm(`${summary}しますか？`)) return;

    setPendingKey("emergency");
    setNotice(null);
    try {
      const response = await fetch("/api/admin/emergency", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          roomCreationEnabled: controlDraft.roomCreationEnabled,
          roomEntryEnabled: controlDraft.roomEntryEnabled,
          drawingEnabled: controlDraft.drawingEnabled,
          reason,
        }),
      });
      const body = await response.json() as {
        error?: string;
        controls?: ServiceControls;
      };
      if (!response.ok || !body.controls) {
        throw new Error("緊急制御を更新できませんでした。");
      }
      setControls(body.controls);
      setControlDraft(body.controls);
      setControlReason("");
      setNotice({
        kind: "success",
        message: `${summary}しました。`,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error
          ? error.message
          : "緊急制御の更新に失敗しました。",
      });
    } finally {
      setPendingKey(null);
    }
  }

  async function refreshRooms(): Promise<void> {
    const response = await fetch("/api/admin/rooms", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("ルーム一覧を更新できませんでした。");
    const body = await response.json() as { rooms?: AdminRoom[] };
    if (!Array.isArray(body.rooms)) {
      throw new Error("ルーム一覧の応答が不正です。");
    }
    setRooms(body.rooms);
  }

  async function refreshServiceBans(): Promise<void> {
    const response = await fetch("/api/admin/service-bans", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("サービスBAN一覧を更新できませんでした。");
    const body = await response.json() as { bans?: AdminServiceBan[] };
    if (!Array.isArray(body.bans)) {
      throw new Error("サービスBAN一覧の応答が不正です。");
    }
    setServiceBans(body.bans);
  }

  async function revokeBan(ban: AdminServiceBan): Promise<void> {
    const reason = window.prompt("解除理由を入力してください。")?.trim() ?? "";
    if (!reason || !window.confirm("このサービスBANを解除しますか？")) return;
    setPendingKey(`unban:${ban.id}`);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/service-bans", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ banId: ban.id, reason }),
      });
      if (!response.ok) throw new Error("サービスBANを解除できませんでした。");
      await refreshServiceBans();
      setNotice({ kind: "success", message: "サービスBANを解除しました。" });
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error
          ? error.message
          : "サービスBANの解除に失敗しました。",
      });
    } finally {
      setPendingKey(null);
    }
  }

  async function refreshMembers(roomId: string): Promise<void> {
    const response = await fetch(
      `/api/admin/members?roomId=${encodeURIComponent(roomId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("参加者一覧を更新できませんでした。");
    const body = await response.json() as {
      members?: readonly ActiveRoomMember[];
    };
    if (!Array.isArray(body.members)) {
      throw new Error("参加者一覧の応答が不正です。");
    }
    setMembersByRoom((current) => ({
      ...current,
      [roomId]: body.members!,
    }));
  }

  async function moderate(
    room: AdminRoom,
    action: AdminModerationInput["action"],
    targetActorId?: string,
    banDurationHours?: 24 | 168 | 720,
  ): Promise<void> {
    const reason = (reasons[room.id] ?? "").trim();
    if (!reason) {
      setNotice({ kind: "error", message: "操作理由を入力してください。" });
      return;
    }
    const label = action === "suspend_room"
      ? "管理停止"
      : action === "close_room"
        ? "強制終了"
        : action === "kick"
          ? "退出"
          : action === "room_ban"
            ? "ルームBAN"
            : `サービスBAN（${banDurationHours === 24
              ? "24時間"
              : banDurationHours === 720 ? "30日" : "7日"}）`;
    const targetLabel = targetActorId
      ? `参加者 ${targetActorId.slice(-8)} を`
      : `${room.name}を`;
    if (!window.confirm(`${targetLabel}${label}しますか？`)) return;

    const operationKey = `${room.id}:${action}:${targetActorId ?? "room"}`;
    setPendingKey(operationKey);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/moderation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          roomId: room.id,
          action,
          reason,
          ...(targetActorId ? { targetActorId } : {}),
          ...(action === "service_ban"
            ? { banDurationHours: banDurationHours ?? 168 }
            : {}),
        }),
      });
      const body = await response.json() as {
        error?: string;
        lifecycle?: { status?: AdminRoom["status"] };
      };
      if (!response.ok) {
        throw new Error(
          body.error === "ROOM_MODERATION_NOT_AVAILABLE"
            ? "対象のルームはすでに終了しています。"
            : "管理操作を適用できませんでした。",
        );
      }
      await refreshRooms();
      if (action === "service_ban") {
        await refreshServiceBans();
      }
      if (targetActorId && expandedRoomId === room.id) {
        await refreshMembers(room.id);
      }
      setNotice({
        kind: "success",
        message: `${targetLabel}${label}しました。`,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error
          ? error.message
          : "管理操作に失敗しました。",
      });
    } finally {
      setPendingKey(null);
    }
  }

  const capacityTotal =
    capacityDraft.participantLimit + capacityDraft.viewerLimit;
  const capacityDraftValid = (
    Number.isSafeInteger(capacityDraft.liveRoomLimit)
    && capacityDraft.liveRoomLimit >= 1
    && capacityDraft.liveRoomLimit <= capacityHardLimits.liveRooms
    && Number.isSafeInteger(capacityDraft.participantLimit)
    && capacityDraft.participantLimit >= 1
    && Number.isSafeInteger(capacityDraft.viewerLimit)
    && capacityDraft.viewerLimit >= 0
    && capacityTotal <= capacityHardLimits.roomConnections
  );

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="admin-kicker">koge administration</p>
          <h1>ルーム管理</h1>
          <p>開催中のルームを安全に停止・終了します。</p>
        </div>
        <button
          className="admin-refresh"
          onClick={() => {
            setNotice(null);
            void refreshRooms().catch((error: unknown) => {
              setNotice({
                kind: "error",
                message: error instanceof Error
                  ? error.message
                  : "ルーム一覧を更新できませんでした。",
              });
            });
          }}
          type="button"
        >
          更新
        </button>
      </header>

      <section
        className={`admin-emergency ${
          controls.roomCreationEnabled
          && controls.roomEntryEnabled
          && controls.drawingEnabled
            ? ""
            : "active"
        }`}
        aria-label="サービス緊急制御"
      >
        <div className="admin-emergency-heading">
          <div>
            <p className="admin-kicker">emergency controls</p>
            <h2>サービス緊急制御</h2>
          </div>
          <span>
            {controls.roomCreationEnabled
              && controls.roomEntryEnabled
              && controls.drawingEnabled
              ? "通常運転"
              : "制限中"}
          </span>
        </div>
        <p>
          チェックを外した機能だけを一時停止します。既存ルームのチャット・閲覧・
          管理操作は維持されます。
        </p>
        <div className="admin-control-options">
          {([
            ["roomCreationEnabled", "新規ルーム作成を許可"],
            ["roomEntryEnabled", "新規入室を許可"],
            ["drawingEnabled", "描画受付を許可"],
          ] as const).map(([key, label]) => (
            <label key={key}>
              <input
                checked={controlDraft[key]}
                disabled={pendingKey === "emergency"}
                onChange={(event) => {
                  setControlDraft((current) => ({
                    ...current,
                    [key]: event.target.checked,
                  }));
                }}
                type="checkbox"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <label className="admin-reason">
          <span>変更理由</span>
          <input
            disabled={pendingKey === "emergency"}
            maxLength={500}
            onChange={(event) => setControlReason(event.target.value)}
            placeholder="監査記録に残す理由"
            value={controlReason}
          />
        </label>
        <div className="admin-room-actions">
          <button
            className={
              controlDraft.roomCreationEnabled
                && controlDraft.roomEntryEnabled
                && controlDraft.drawingEnabled
                ? ""
                : "danger"
            }
            disabled={
              pendingKey === "emergency"
              || (
                controlDraft.roomCreationEnabled
                  === controls.roomCreationEnabled
                && controlDraft.roomEntryEnabled
                  === controls.roomEntryEnabled
                && controlDraft.drawingEnabled === controls.drawingEnabled
              )
            }
            onClick={() => void applyEmergencyControls()}
            type="button"
          >
            制御を適用
          </button>
        </div>
      </section>

      <section className="admin-emergency" aria-label="サービス利用上限">
        <div className="admin-emergency-heading">
          <div>
            <p className="admin-kicker">capacity limits</p>
            <h2>サービス利用上限</h2>
          </div>
          <span>
            1ルーム最大
            {capacityLimits.participantLimit + capacityLimits.viewerLimit}人
          </span>
        </div>
        <p>
          安全上限の範囲内で、新しく作成されるルームの上限を絞ります。
          既存ルームの利用者は退出させません。
        </p>
        <div className="admin-capacity-fields">
          <label>
            <span>同時開催ルーム</span>
            <input
              disabled={pendingKey === "capacity"}
              max={capacityHardLimits.liveRooms}
              min={1}
              onChange={(event) => setCapacityDraft((current) => ({
                ...current,
                liveRoomLimit: Number(event.target.value),
              }))}
              type="number"
              value={capacityDraft.liveRoomLimit}
            />
            <small>最大 {capacityHardLimits.liveRooms}ルーム</small>
          </label>
          <label>
            <span>描く人</span>
            <input
              disabled={pendingKey === "capacity"}
              max={capacityHardLimits.roomConnections}
              min={1}
              onChange={(event) => setCapacityDraft((current) => ({
                ...current,
                participantLimit: Number(event.target.value),
              }))}
              type="number"
              value={capacityDraft.participantLimit}
            />
            <small>オーナーを含みます</small>
          </label>
          <label>
            <span>見る人</span>
            <input
              disabled={pendingKey === "capacity"}
              max={capacityHardLimits.roomConnections - 1}
              min={0}
              onChange={(event) => setCapacityDraft((current) => ({
                ...current,
                viewerLimit: Number(event.target.value),
              }))}
              type="number"
              value={capacityDraft.viewerLimit}
            />
            <small>0人なら閲覧入室を停止</small>
          </label>
        </div>
        <label className="admin-capacity-policy">
          <input
            checked={capacityDraft.publicRoomsOnly}
            disabled={pendingKey === "capacity"}
            onChange={(event) => setCapacityDraft((current) => ({
              ...current,
              publicRoomsOnly: event.target.checked,
            }))}
            type="checkbox"
          />
          <span>
            <strong>公開ルームのみ許可</strong>
            <small>
              新しいルームの「招待リンク限定」を非表示にし、APIからの作成も拒否します。
            </small>
          </span>
        </label>
        <p className={
          !capacityDraftValid
            ? "admin-capacity-total invalid"
            : "admin-capacity-total"
        }>
          合計 {capacityTotal}
          /{capacityHardLimits.roomConnections}人
        </p>
        <label className="admin-reason">
          <span>変更理由</span>
          <input
            disabled={pendingKey === "capacity"}
            maxLength={500}
            onChange={(event) => setCapacityReason(event.target.value)}
            placeholder="監査記録に残す理由"
            value={capacityReason}
          />
        </label>
        <div className="admin-room-actions">
          <button
            disabled={
              pendingKey === "capacity"
              || (
                capacityDraft.liveRoomLimit === capacityLimits.liveRoomLimit
                && capacityDraft.participantLimit
                  === capacityLimits.participantLimit
                && capacityDraft.viewerLimit === capacityLimits.viewerLimit
                && capacityDraft.publicRoomsOnly
                  === capacityLimits.publicRoomsOnly
              )
              || !capacityDraftValid
            }
            onClick={() => void applyCapacityLimits()}
            type="button"
          >
            上限を適用
          </button>
        </div>
      </section>

      {notice ? (
        <p className={`admin-notice ${notice.kind}`} role="status">
          {notice.message}
        </p>
      ) : null}

      <section className="admin-emergency" aria-label="サービスBAN">
        <div className="admin-emergency-heading">
          <div>
            <p className="admin-kicker">temporary service bans</p>
            <h2>サービスBAN</h2>
          </div>
          <span>{serviceBans.filter((ban) => (
            ban.revokedAt === null && ban.expiresAt > Date.now()
          )).length}件有効</span>
        </div>
        <p>
          一時BANだけを使用します。対象はアカウントまたはguest sessionで、
          IPアドレスは保存しません。
        </p>
        {serviceBans.length === 0 ? (
          <p>記録はありません。</p>
        ) : (
          <ul className="admin-member-list">
            {serviceBans.map((ban) => {
              const active = ban.revokedAt === null
                && ban.expiresAt > Date.now();
              return (
                <li key={ban.id}>
                  <div>
                    <span>{ban.subjectKind === "user"
                      ? "アカウント"
                      : "ゲスト"}</span>
                    <code>{ban.sourceActorId?.slice(-12) ?? "actor不明"}</code>
                    <small>
                      {active
                        ? `${new Date(ban.expiresAt).toLocaleString("ja-JP")}まで`
                        : ban.revokedAt
                          ? "解除済み"
                          : "期限切れ"}
                      {" · "}
                      {ban.reason}
                    </small>
                  </div>
                  {active ? (
                    <button
                      disabled={pendingKey === `unban:${ban.id}`}
                      onClick={() => void revokeBan(ban)}
                      type="button"
                    >
                      解除
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {rooms.length === 0 ? (
        <section className="admin-empty">
          <h2>管理対象のルームはありません</h2>
          <p>新しいルームが作成されると、ここに表示されます。</p>
        </section>
      ) : (
        <section className="admin-room-list" aria-label="管理対象ルーム">
          {rooms.map((room) => {
            const pending = pendingKey?.startsWith(`${room.id}:`) ?? false;
            const expanded = expandedRoomId === room.id;
            const members = membersByRoom[room.id] ?? [];
            return (
              <article className="admin-room-card" key={room.id}>
                <div className="admin-room-summary">
                  <div>
                    <span className={`admin-status status-${room.status}`}>
                      {STATUS_LABELS[room.status]}
                    </span>
                    <h2>{room.name}</h2>
                    <p>
                      {room.visibility === "public" ? "公開" : "限定公開"}
                      {" · "}
                      描く人 {room.participantCount}
                      {" · "}
                      見る人 {room.viewerCount}
                    </p>
                  </div>
                  <a
                    href={`/rooms/${encodeURIComponent(room.publicSlug)}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    ルームを確認
                  </a>
                </div>

                <label className="admin-reason">
                  <span>操作理由</span>
                  <input
                    disabled={pending || room.status === "closing"}
                    maxLength={500}
                    onChange={(event) => {
                      setReasons((current) => ({
                        ...current,
                        [room.id]: event.target.value,
                      }));
                    }}
                    placeholder="監査記録に残す理由"
                    value={reasons[room.id] ?? ""}
                  />
                </label>

                <div className="admin-room-actions">
                  {room.status !== "closing" ? (
                    <button
                      disabled={pending}
                      onClick={() => {
                        if (expanded) {
                          setExpandedRoomId(null);
                          return;
                        }
                        setExpandedRoomId(room.id);
                        setNotice(null);
                        void refreshMembers(room.id).catch((error: unknown) => {
                          setNotice({
                            kind: "error",
                            message: error instanceof Error
                              ? error.message
                              : "参加者一覧を更新できませんでした。",
                          });
                        });
                      }}
                      type="button"
                    >
                      {expanded ? "参加者を閉じる" : "参加者管理"}
                    </button>
                  ) : null}
                  {room.status !== "suspended" && room.status !== "closing" ? (
                    <button
                      disabled={pending}
                      onClick={() => void moderate(room, "suspend_room")}
                      type="button"
                    >
                      管理停止
                    </button>
                  ) : null}
                  {room.status !== "closing" ? (
                    <button
                      className="danger"
                      disabled={pending}
                      onClick={() => void moderate(room, "close_room")}
                      type="button"
                    >
                      強制終了
                    </button>
                  ) : (
                    <span>終了処理を実行中です</span>
                  )}
                </div>

                {expanded ? (
                  <section
                    className="admin-member-panel"
                    aria-label={`${room.name}の接続中の参加者`}
                  >
                    <div className="admin-member-heading">
                      <h3>接続中の参加者</h3>
                      <button
                        disabled={pending}
                        onClick={() => void refreshMembers(room.id)}
                        type="button"
                      >
                        更新
                      </button>
                    </div>
                    {members.length === 0 ? (
                      <p className="admin-member-empty">
                        現在接続している参加者はいません。
                      </p>
                    ) : (
                      <ul className="admin-member-list">
                        {members.map((member) => (
                          <li key={member.actorId}>
                            <div>
                              <span>{ROLE_LABELS[member.role]}</span>
                              <code>{member.actorId.slice(-12)}</code>
                            </div>
                            <div className="admin-member-actions">
                              {member.role === "host" ? (
                                <small>退出・ルームBANの保護対象</small>
                              ) : (
                                <>
                                <button
                                  disabled={pending}
                                  onClick={() => void moderate(
                                    room,
                                    "kick",
                                    member.actorId,
                                  )}
                                  type="button"
                                >
                                  退出
                                </button>
                                <button
                                  className="danger"
                                  disabled={pending}
                                  onClick={() => void moderate(
                                    room,
                                    "room_ban",
                                    member.actorId,
                                  )}
                                  type="button"
                                >
                                  ルームBAN
                                </button>
                                </>
                              )}
                              <select
                                aria-label="サービスBAN期間"
                                disabled={pending}
                                onChange={(event) => {
                                  setServiceBanDurations((current) => ({
                                    ...current,
                                    [room.id]: Number(
                                      event.target.value,
                                    ) as 24 | 168 | 720,
                                  }));
                                }}
                                value={serviceBanDurations[room.id] ?? 168}
                              >
                                <option value={24}>24時間</option>
                                <option value={168}>7日</option>
                                <option value={720}>30日</option>
                              </select>
                              <button
                                className="danger"
                                disabled={pending}
                                onClick={() => void moderate(
                                  room,
                                  "service_ban",
                                  member.actorId,
                                  serviceBanDurations[room.id] ?? 168,
                                )}
                                type="button"
                              >
                                サービスBAN
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ) : null}
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

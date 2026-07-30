"use client";

import { createAuthClient } from "better-auth/react";
import { type FormEvent, useRef, useState } from "react";

const authClient = createAuthClient();

export default function AuthActions({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<"public" | "unlisted">("public");
  const createAttempt = useRef<{
    body: string;
    fingerprint: string;
    requestId: string;
  } | null>(null);

  function randomHex(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Array.from(
      bytes,
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
  }

  async function signIn() {
    setPending(true);
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
    });
    if (result.error) setPending(false);
  }

  async function signOut() {
    setPending(true);
    await authClient.signOut({
      fetchOptions: {
        onSuccess() {
          window.location.assign("/");
        },
      },
    });
    setPending(false);
  }

  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setCreateError(null);
    const data = new FormData(event.currentTarget);
    const settings = {
      name: data.get("name"),
      visibility,
    };
    const fingerprint = JSON.stringify(settings);
    if (
      !createAttempt.current
      || createAttempt.current.fingerprint !== fingerprint
    ) {
      createAttempt.current = {
        body: JSON.stringify({
          ...settings,
          inviteToken: visibility === "unlisted" ? randomHex(32) : null,
        }),
        fingerprint,
        requestId: crypto.randomUUID(),
      };
    }
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": createAttempt.current.requestId,
      },
      body: createAttempt.current.body,
    });
    if (response.ok) {
      createAttempt.current = null;
      const destination = response.headers.get("location") ?? "/";
      const roomUrl = new URL(destination, window.location.origin);
      const roomSlug = /^\/rooms\/([a-f0-9]{32})$/.exec(
        roomUrl.pathname,
      )?.[1];
      if (roomSlug) {
        sessionStorage.setItem(`koge-room-role:${roomSlug}`, "participant");
      }
      window.location.assign(destination);
      return;
    }
    const result: unknown = await response.json().catch(() => null);
    const errorCode = (
      typeof result === "object"
      && result !== null
      && "error" in result
      && typeof result.error === "string"
    )
      ? result.error
      : "UNKNOWN";
    setCreateError(
      errorCode === "LIVE_ROOM_LIMIT_REACHED"
        ? "同時に作成できるルームは1件までです。"
        : errorCode === "SITE_LIVE_ROOM_LIMIT_REACHED"
        ? "現在、サイト全体の開催ルーム数が上限に達しています。"
        : errorCode === "SERVICE_BANNED"
        ? "現在、このアカウントではルームを作成できません。"
        : errorCode === "ROOM_CREATION_PAUSED"
        ? "現在、緊急対応のため新しいルームの作成を一時停止しています。"
        : errorCode === "ROOM_PROVISIONING_FAILED"
        ? "ルームの準備に失敗しました。もう一度お試しください。"
        : "ルームを作成できませんでした。",
    );
    setPending(false);
  }

  return (
    <div className="home-auth-actions">
      {isAuthenticated ? (
        <>
          <button
            className="home-button primary"
            disabled={pending}
            onClick={() => {
              setCreateOpen((open) => !open);
              setCreateError(null);
              createAttempt.current = null;
            }}
            type="button"
          >
            ルームを作る
          </button>
          <button
            className="home-button quiet"
            disabled={pending}
            onClick={signOut}
            type="button"
          >
            ログアウト
          </button>
          {createOpen ? (
            <div className="room-create-popover">
              <form onSubmit={createRoom}>
                <div className="room-create-heading">
                  <strong>新しいルーム</strong>
                  <button
                    aria-label="閉じる"
                    disabled={pending}
                    onClick={() => {
                      setCreateOpen(false);
                      createAttempt.current = null;
                    }}
                    type="button"
                  >
                    ×
                  </button>
                </div>
                <label>
                  ルーム名
                  <input
                    autoFocus
                    maxLength={60}
                    name="name"
                    placeholder="みんなでお絵描き"
                    required
                  />
                </label>
                <label>
                  公開範囲
                  <select
                    name="visibility"
                    value={visibility}
                    onChange={(event) => {
                      setVisibility(
                        event.currentTarget.value === "unlisted"
                          ? "unlisted"
                          : "public",
                      );
                      createAttempt.current = null;
                    }}
                  >
                    <option value="public">公開ルーム</option>
                    <option value="unlisted">招待リンク限定</option>
                  </select>
                </label>
                <p>
                  {visibility === "unlisted"
                    ? "一覧には表示されません。作成後の招待リンクを共有して参加します。"
                    : "公開一覧に表示されます。"}
                  {" "}作成から2時間で終了します。
                </p>
                {createError ? (
                  <p className="room-create-error" role="alert">
                    {createError}
                  </p>
                ) : null}
                <button
                  className="home-button primary room-create-submit"
                  disabled={pending}
                  type="submit"
                >
                  {pending ? "準備中…" : "作成する"}
                </button>
              </form>
            </div>
          ) : null}
        </>
      ) : (
        <button
          className="home-button primary"
          disabled={pending}
          onClick={signIn}
          type="button"
        >
          {pending ? "接続中…" : "Googleでログイン"}
        </button>
      )}
    </div>
  );
}

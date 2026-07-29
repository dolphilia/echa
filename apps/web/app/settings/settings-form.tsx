"use client";

import { Image, Trash2, UserRound, X } from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AVATAR_URL_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
} from "../server/account-settings";

type Notice = {
  kind: "success" | "error";
  message: string;
} | null;

export default function SettingsForm({
  email,
  initialImage,
  initialName,
}: {
  email: string;
  initialImage: string | null;
  initialName: string;
}) {
  const [name, setName] = useState(initialName);
  const [image, setImage] = useState(initialImage ?? "");
  const [imageFailed, setImageFailed] = useState(false);
  const [profilePending, setProfilePending] = useState(false);
  const [profileNotice, setProfileNotice] = useState<Notice>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<Notice>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);

  const initials = useMemo(
    () => [...(name.trim() || initialName)].slice(0, 2).join("").toUpperCase(),
    [initialName, name],
  );
  const normalizedName = name.trim();
  const canSaveProfile = normalizedName.length > 0
    && [...normalizedName].length <= DISPLAY_NAME_MAX_LENGTH
    && !profilePending;
  const canRequestDeletion = deleteConfirmation === "delete"
    && !deletePending;

  useEffect(() => {
    if (!deleteDialogOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelDeleteRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deletePending) {
        setDeleteDialogOpen(false);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [deleteDialogOpen, deletePending]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSaveProfile) return;
    setProfilePending(true);
    setProfileNotice(null);
    try {
      const response = await fetch("/api/settings/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: normalizedName,
          image: image.trim() || null,
        }),
      });
      if (!response.ok) {
        throw new Error(`profile update failed: ${response.status}`);
      }
      setName(normalizedName);
      setProfileNotice({
        kind: "success",
        message: "プロフィールを保存しました。",
      });
    } catch {
      setProfileNotice({
        kind: "error",
        message: "プロフィールを保存できませんでした。入力内容をご確認ください。",
      });
    } finally {
      setProfilePending(false);
    }
  }

  async function deleteAccount() {
    if (!canRequestDeletion) return;
    setDeletePending(true);
    setDeleteNotice(null);
    try {
      const response = await fetch("/api/settings/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: deleteConfirmation }),
      });
      if (response.ok) {
        window.location.assign("/?accountDeleted=1");
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      const error = (
        typeof result === "object"
        && result !== null
        && "error" in result
      ) ? result.error : undefined;
      setDeleteDialogOpen(false);
      setDeleteNotice({
        kind: "error",
        message: error === "REAUTHENTICATION_REQUIRED"
          ? "安全のため、いったんログアウトして再ログインしてからお試しください。"
          : "アカウント削除を開始できませんでした。時間をおいてお試しください。",
      });
    } catch {
      setDeleteDialogOpen(false);
      setDeleteNotice({
        kind: "error",
        message: "通信に失敗しました。時間をおいてお試しください。",
      });
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <div className="settings-content">
      <section className="settings-card" aria-labelledby="profile-heading">
        <div className="settings-card-heading">
          <span><UserRound aria-hidden="true" /></span>
          <div>
            <h2 id="profile-heading">プロフィール</h2>
            <p>ほかの参加者に表示される名前とアイコンです。</p>
          </div>
        </div>
        <form className="settings-profile-form" onSubmit={saveProfile}>
          <div className="settings-avatar-preview" aria-label="アバターのプレビュー">
            <span>{initials}</span>
            {image && !imageFailed ? (
              <img
                alt=""
                src={image}
                onError={() => setImageFailed(true)}
              />
            ) : null}
          </div>
          <div className="settings-profile-fields">
            <label>
              表示名
              <input
                autoComplete="nickname"
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                required
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <small>{[...name].length}/{DISPLAY_NAME_MAX_LENGTH}</small>
            </label>
            <label>
              アバター画像URL
              <div className="settings-image-input">
                <Image aria-hidden="true" />
                <input
                  inputMode="url"
                  maxLength={AVATAR_URL_MAX_LENGTH}
                  placeholder="https://example.com/avatar.png"
                  type="url"
                  value={image}
                  onChange={(event) => {
                    setImage(event.currentTarget.value);
                    setImageFailed(false);
                  }}
                />
                {image ? (
                  <button
                    aria-label="アバター画像を解除"
                    onClick={() => {
                      setImage("");
                      setImageFailed(false);
                    }}
                    type="button"
                  >
                    <X aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <small>公開されているHTTPS画像のURLを入力してください。</small>
            </label>
            <label>
              ログインメール
              <input disabled readOnly value={email} />
            </label>
            {profileNotice ? (
              <p
                className={`settings-notice is-${profileNotice.kind}`}
                role={profileNotice.kind === "error" ? "alert" : "status"}
              >
                {profileNotice.message}
              </p>
            ) : null}
            <button
              className="settings-save"
              disabled={!canSaveProfile}
              type="submit"
            >
              {profilePending ? "保存中…" : "変更を保存"}
            </button>
          </div>
        </form>
      </section>

      <section
        className="settings-card settings-danger"
        aria-labelledby="delete-heading"
      >
        <div className="settings-card-heading">
          <span><Trash2 aria-hidden="true" /></span>
          <div>
            <h2 id="delete-heading">アカウント削除</h2>
            <p>
              所有ルームを終了し、プロフィールとログイン情報を削除します。
              この操作は元に戻せません。
            </p>
          </div>
        </div>
        <div className="settings-delete-form">
          <label>
            確認入力
            <input
              autoComplete="off"
              placeholder="delete"
              spellCheck={false}
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.currentTarget.value)}
            />
          </label>
          <p>削除するには半角小文字で「delete」と入力してください。</p>
          {deleteNotice ? (
            <p className="settings-notice is-error" role="alert">
              {deleteNotice.message}
            </p>
          ) : null}
          <button
            disabled={!canRequestDeletion}
            onClick={() => setDeleteDialogOpen(true)}
            type="button"
          >
            <Trash2 aria-hidden="true" />
            アカウントを削除
          </button>
        </div>
      </section>

      {deleteDialogOpen ? (
        <div
          className="settings-dialog-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deletePending) {
              setDeleteDialogOpen(false);
            }
          }}
          role="presentation"
        >
          <section
            aria-describedby="delete-dialog-description"
            aria-labelledby="delete-dialog-title"
            aria-modal="true"
            className="settings-dialog"
            role="dialog"
          >
            <span className="settings-dialog-icon">
              <Trash2 aria-hidden="true" />
            </span>
            <h2 id="delete-dialog-title">本当に削除しますか？</h2>
            <p id="delete-dialog-description">
              「{initialName}」のアカウントを削除します。
              所有ルームは終了し、再ログインしても復元できません。
            </p>
            <div>
              <button
                disabled={deletePending}
                onClick={() => setDeleteDialogOpen(false)}
                ref={cancelDeleteRef}
                type="button"
              >
                キャンセル
              </button>
              <button
                className="is-destructive"
                disabled={deletePending}
                onClick={() => void deleteAccount()}
                type="button"
              >
                {deletePending ? "削除を開始中…" : "削除する"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

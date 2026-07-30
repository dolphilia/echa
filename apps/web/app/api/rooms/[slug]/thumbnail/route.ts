import { env } from "cloudflare:workers";

const SLUG_PATTERN = /^[a-f0-9]{32}$/;
const VERSION_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const PLACEHOLDER_ETAG = "\"koge-room-placeholder-v1\"";
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#fff"/>
<g fill="#e2e4df">
<circle cx="18" cy="18" r="2"/><circle cx="54" cy="18" r="2"/>
<circle cx="90" cy="18" r="2"/><circle cx="126" cy="18" r="2"/>
</g>
<g fill="none" stroke-linecap="round" stroke-width="22" opacity=".8">
<path d="M150 238L350 210" stroke="#c6d8cc"/>
<path d="M230 278L340 310" stroke="#e6cbb4"/>
<path d="M160 330L230 285" stroke="#c8c9df"/>
</g></svg>`;

type ThumbnailProjection = {
  thumbnail_object_key: string;
  thumbnail_base_room_seq: number;
};

function placeholderResponse(request: Request): Response {
  if (request.headers.get("if-none-match") === PLACEHOLDER_ETAG) {
    return new Response(null, {
      status: 304,
      headers: {
        etag: PLACEHOLDER_ETAG,
        "cache-control": "public, max-age=30, s-maxage=30",
      },
    });
  }
  return new Response(PLACEHOLDER_SVG, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=30, s-maxage=30",
      etag: PLACEHOLDER_ETAG,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const versionText = new URL(request.url).searchParams.get("v") ?? "";
  if (
    env.THUMBNAIL_ENABLED !== "true"
    || !SLUG_PATTERN.test(slug)
    || !VERSION_PATTERN.test(versionText)
  ) {
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "private, no-store" },
    });
  }
  const version = Number(versionText);
  if (!Number.isSafeInteger(version)) {
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "private, no-store" },
    });
  }
  const projection = await env.DB.prepare(
    `SELECT thumbnail_object_key, thumbnail_base_room_seq
     FROM rooms
     WHERE public_slug = ?
       AND visibility = 'public'
       AND provisioning_status = 'ready'
       AND status IN ('active', 'idle')
       AND thumbnail_object_key IS NOT NULL
       AND thumbnail_base_room_seq = ?
     LIMIT 1`,
  ).bind(slug, version).first<ThumbnailProjection>();
  if (!projection) {
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "private, no-store" },
    });
  }

  const object = await env.ROOM_THUMBNAILS.get(
    projection.thumbnail_object_key,
  );
  if (!object) return placeholderResponse(request);
  const etag = object.httpEtag;
  const headers = new Headers({ etag });
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=31536000, immutable");
  headers.set("cdn-cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
}

import { downloadMedia } from "./whapi-api";
import { extensionForMime } from "@/lib/media/filename";
import { buildMediaPath, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";

/**
 * Copies inbound WhatsApp media into the `chat-media` bucket so it
 * outlives the gateway's retention window (issue #466).
 *
 * Whapi keeps auto-downloaded inbound files for roughly 30 days — the
 * same expiry Meta had — so the `link` on a webhook is a pointer with a
 * deadline on it, and an attachment quietly becomes unviewable a month
 * after it arrived. Outbound media never had the problem: the composer
 * uploads to `chat-media` (migration 023) and stores a durable public
 * URL. This puts inbound on the same footing.
 *
 * Everything here is BEST EFFORT and returns `null` rather than
 * throwing. The caller is the Whapi webhook, and a webhook that starts
 * failing is worse than an attachment that expires: Whapi retries the
 * delivery, which re-runs contact creation, flows, automations and AI
 * replies. On any failure — oversized file, MIME the bucket refuses,
 * storage outage — the caller falls back to the gateway URL, which
 * still works for as long as Whapi holds the bytes.
 */

/** Service-role Storage surface this needs. Narrow so tests can fake it. */
export interface MirrorStorage {
  from(bucket: string): {
    upload(
      path: string,
      body: Uint8Array | Buffer,
      options: { contentType: string; cacheControl: string; upsert: boolean },
    ): Promise<{ error: { message: string } | null }>;
    getPublicUrl(path: string): { data: { publicUrl: string } };
  };
}

/** Bucket the composer already writes to; inbound joins it. */
export const MIRROR_BUCKET = "chat-media";

/**
 * Second path segment for mirrored inbound objects, so a bucket listing
 * separates "things a customer sent us" from "things we sent". RLS only
 * matches on the FIRST segment (`account-<id>`, migration 023), so an
 * extra level is free.
 */
export const MIRROR_FOLDER = "inbound";

export interface MirrorInboundMediaArgs {
  /** Service-role `supabase.storage` — RLS is bypassed, MIME/size limits are not. */
  storage: MirrorStorage;
  /** Tenant. Drives the account-scoped path the bucket's policies expect. */
  accountId: string;
  /** Whapi's media id. Makes the object path deterministic. */
  mediaId: string;
  /** Gateway-hosted URL from the webhook's `link`, or from `getMediaUrl`. */
  downloadUrl: string;
  /** Whapi channel token — Whapi-hosted media requires it as a Bearer header. */
  accessToken: string;
  /** The media's `mime_type`. */
  mimeType?: string | null;
  /** The media's `file_size`, when known — lets us skip before downloading. */
  fileSize?: number | null;
  /** `document.file_name`, when the sender's client supplied one. */
  fileName?: string | null;
  /** Message timestamp (epoch SECONDS) — keeps download names distinct. */
  messageTimestamp?: string | number | null;
  /** Injected in tests. */
  download?: typeof downloadMedia;
}

/**
 * Lower-case a MIME type and drop its parameters, so `audio/ogg;
 * codecs=opus` — which is what a WhatsApp voice note actually carries —
 * is matched against the bucket's allow-list as plain `audio/ogg`.
 * Returns null for anything unusable.
 */
export function normalizeMimeType(value?: string | null): string | null {
  if (!value) return null;
  const base = value.split(";")[0].trim().toLowerCase();
  return base.includes("/") ? base : null;
}

/**
 * Coarse noun for a MIME type, used to build a readable download name.
 * Deliberately matches the `content_type` vocabulary in the UI rather
 * than the MIME top-level (`application/*` reads as "document").
 */
function kindForMime(mimeType: string | null): string {
  if (!mimeType) return "file";
  const [top] = mimeType.split("/");
  if (top === "image" || top === "video" || top === "audio") return top;
  if (top === "text" || top === "application") return "document";
  return "file";
}

/**
 * The object's filename inside the account folder. Pure, so the naming
 * rules can be tested without a Storage client.
 *
 * Prefixed with the media id, which makes the whole path deterministic:
 * a gateway redelivery of the same message rewrites the same object rather
 * than littering the bucket with a second copy. The id is stripped back
 * off when a download name is derived, because `basenameFromUrl`
 * (`@/lib/media/filename`) drops a leading run of 10+ digits — the same
 * rule that hides `buildMediaPath`'s epoch prefix on outbound uploads.
 * So the agent saves `invoice.pdf`, not `1234567890123456-invoice.pdf`.
 *
 * Names are kept short on purpose: `buildMediaPath` caps the basename it
 * receives at 40 characters, and a 19-digit media id plus a separator
 * already spends half of that. Hence `image-<epoch>` rather than
 * `whatsapp-image-<epoch>` — the latter truncates.
 */
export function mirrorFileName(args: {
  mediaId: string;
  mimeType: string | null;
  fileName?: string | null;
  messageTimestamp?: string | number | null;
}): string {
  const { mediaId, mimeType, fileName, messageTimestamp } = args;
  const ext = extensionForMime(mimeType);

  // A document's own name is the best download name there is, so keep
  // it. Strip any directory part and its extension — `buildMediaPath`
  // re-derives the extension from whatever we hand it, and we'd rather
  // that come from the MIME type than from a sender-controlled string.
  const stem = (fileName ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]+$/, "")
    .trim();
  if (stem) return `${mediaId}-${stem}.${ext}`;

  // Otherwise synthesise. The message timestamp is in the name so that
  // saving two photos out of one thread doesn't produce two files with
  // the same name — and it's WhatsApp's timestamp, not the clock, so the
  // path stays deterministic across a redelivery.
  const kind = kindForMime(mimeType);
  const stamp = String(messageTimestamp ?? "").replace(/\D/g, "");
  return `${mediaId}-${stamp ? `${kind}-${stamp}` : kind}.${ext}`;
}

/**
 * Download the bytes from the gateway and put them in `chat-media`.
 *
 * @returns the durable public URL, or `null` if the mirror was skipped
 *          or failed — in which case the caller must fall back to the
 *          proxy URL.
 */
export async function mirrorInboundMedia(
  args: MirrorInboundMediaArgs,
): Promise<string | null> {
  const {
    storage,
    accountId,
    mediaId,
    downloadUrl,
    accessToken,
    mimeType,
    fileSize,
    fileName,
    messageTimestamp,
    download = downloadMedia,
  } = args;

  const normalizedMime = normalizeMimeType(mimeType);

  // Skip oversized media BEFORE spending the transfer. The bucket
  // rejects anything past its 16 MB `file_size_limit` anyway, and Whapi
  // allows documents up to 100 MB, so this is a real case rather than a
  // defensive one.
  if (typeof fileSize === "number" && fileSize > MEDIA_MAX_BYTES) {
    console.warn(
      `[mirror-media] skipping ${mediaId}: ${fileSize} bytes exceeds the ${MEDIA_MAX_BYTES}-byte bucket limit`,
    );
    return null;
  }

  try {
    const { buffer, contentType } = await download({
      downloadUrl,
      token: accessToken,
    });

    // The reported `file_size` is advisory; the transfer is the truth. Check
    // again so an understated size can't push a rejected upload onto
    // the bucket.
    if (buffer.byteLength > MEDIA_MAX_BYTES) {
      console.warn(
        `[mirror-media] skipping ${mediaId}: downloaded ${buffer.byteLength} bytes, over the ${MEDIA_MAX_BYTES}-byte bucket limit`,
      );
      return null;
    }

    // The webhook's metadata MIME wins over the response header: it's what
    // the message row records, so mirroring it keeps `media_type` and
    // the stored object describing the same thing.
    const uploadType =
      normalizedMime ??
      normalizeMimeType(contentType) ??
      "application/octet-stream";

    const objectName = mirrorFileName({
      mediaId,
      mimeType: uploadType,
      fileName,
      messageTimestamp,
    });
    // `null` suppresses buildMediaPath's wall-clock stamp: the media id
    // already makes this path unique AND stable, and it's the stability
    // that makes a redelivery idempotent rather than duplicative.
    const path = buildMediaPath(accountId, objectName, null, MIRROR_FOLDER);

    // `upsert: true` for that same reason: on the rare gateway redelivery
    // the second pass rewrites byte-identical content at the same key
    // instead of erroring or orphaning a duplicate.
    const { error } = await storage.from(MIRROR_BUCKET).upload(path, buffer, {
      contentType: uploadType,
      cacheControl: "3600",
      upsert: true,
    });
    if (error) {
      // Most likely a MIME outside the bucket's allow-list (migration
      // 039 covers what WhatsApp realistically sends, but a document can be
      // any type at all). Log and let the caller keep the proxy URL.
      console.warn(
        `[mirror-media] upload failed for ${mediaId} (${uploadType}):`,
        error.message,
      );
      return null;
    }

    const {
      data: { publicUrl },
    } = storage.from(MIRROR_BUCKET).getPublicUrl(path);
    return publicUrl || null;
  } catch (error) {
    console.warn(
      `[mirror-media] could not mirror ${mediaId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

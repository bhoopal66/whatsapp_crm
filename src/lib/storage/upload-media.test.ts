import { describe, expect, it, vi } from "vitest";

const upload = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
    },
    from: () => ({
      select: () => ({
        eq: async () => ({
          data: [{ account_id: ACCOUNT, is_active: true }],
          error: null,
        }),
      }),
    }),
    storage: {
      from: () => ({
        upload,
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://x/${path}` },
        }),
      }),
    },
  }),
}));

import {
  buildMediaPath,
  MEDIA_MAX_BYTES_BY_KIND,
  uploadAccountMedia,
} from "./upload-media";
import { STAGED_MEDIA_SUBFOLDER } from "./staged-media";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";

describe("buildMediaPath", () => {
  it("namespaces under account-<id> so RLS write policies match", () => {
    const path = buildMediaPath(ACCOUNT, "photo.png", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-photo.png`);
    expect(path.split("/")[0]).toBe(`account-${ACCOUNT}`);
  });

  it("lower-cases the extension and sanitizes the basename", () => {
    const path = buildMediaPath(ACCOUNT, "My Invoice (final).PDF", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-My_Invoice_final_.pdf`);
  });

  it("caps the basename at 40 chars", () => {
    const long = "a".repeat(100) + ".png";
    const path = buildMediaPath(ACCOUNT, long, 1700000000000);
    const base = path.split("/")[1].replace("1700000000000-", "").replace(".png", "");
    expect(base.length).toBe(40);
  });

  it("falls back to 'file' / 'bin' for a nameless input", () => {
    const path = buildMediaPath(ACCOUNT, "", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-file.bin`);
  });

  it("defaults the extension to bin when there is none", () => {
    const path = buildMediaPath(ACCOUNT, "README", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-README.bin`);
  });

  it("keeps a normal extension, lower-cased", () => {
    expect(buildMediaPath(ACCOUNT, "photo.JPG", null)).toBe(
      `account-${ACCOUNT}/photo.jpg`,
    );
  });

  it.each(["a.weird#?ext", "a.<script>", "a.toolongextension", "a.p%6Eg"])(
    "turns the unsafe extension of %s into bin",
    (name) => {
      expect(buildMediaPath(ACCOUNT, name, null)).toMatch(/\.bin$/);
    },
  );

  it("omits the timestamp when passed null, for callers needing a stable path", () => {
    const path = buildMediaPath(ACCOUNT, "photo.png", null);
    expect(path).toBe(`account-${ACCOUNT}/photo.png`);
  });

  it("nests a subfolder below account-<id>, leaving the RLS segment first", () => {
    const path = buildMediaPath(ACCOUNT, "photo.png", null, "inbound");
    expect(path).toBe(`account-${ACCOUNT}/inbound/photo.png`);
    expect(path.split("/")[0]).toBe(`account-${ACCOUNT}`);
  });
});

describe("MEDIA_MAX_BYTES_BY_KIND", () => {
  it("caps images at Meta's tighter 5 MB limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.image).toBe(5 * 1024 * 1024);
  });

  it("caps video/audio/document at the 16 MB bucket limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.video).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.audio).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.document).toBe(16 * 1024 * 1024);
  });
});

describe("uploadAccountMedia", () => {
  const file = new File(["x"], "photo.png", { type: "image/png" });

  it("uploads under account-<id>/staged/ when asked for the staged subfolder", async () => {
    upload.mockReset().mockResolvedValue({ error: null });
    const { path } = await uploadAccountMedia("chat-media", file, {
      subfolder: STAGED_MEDIA_SUBFOLDER,
    });
    expect(path).toMatch(
      new RegExp(`^account-${ACCOUNT}/staged/\\d+-photo\\.png$`),
    );
    expect(upload.mock.calls[0][0]).toBe(path);
  });

  it("keeps the plain account-<id>/ path without options", async () => {
    upload.mockReset().mockResolvedValue({ error: null });
    const { path } = await uploadAccountMedia("chat-media", file);
    expect(path).toMatch(
      new RegExp(`^account-${ACCOUNT}/\\d+-photo\\.png$`),
    );
    expect(upload.mock.calls[0][0]).toBe(path);
  });

  it.each([
    ["chat-media", "text/html"],
    ["chat-media", "image/svg+xml"],
    ["flow-media", "text/html"],
    ["flow-media", "image/svg+xml"],
  ])("does not pass %s %s through as the content type", async (bucket, type) => {
    upload.mockReset().mockResolvedValue({ error: null });
    await uploadAccountMedia(bucket, new File(["x"], "a.png", { type }));
    expect(upload.mock.calls[0][2].contentType).toBe(
      "application/octet-stream",
    );
  });

  it("keeps an allowed type", async () => {
    upload.mockReset().mockResolvedValue({ error: null });
    await uploadAccountMedia("chat-media", file);
    expect(upload.mock.calls[0][2].contentType).toBe("image/png");
  });
});

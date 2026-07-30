ALTER TABLE "rooms"
ADD COLUMN "thumbnail_object_key" TEXT;

ALTER TABLE "rooms"
ADD COLUMN "thumbnail_base_room_seq" INTEGER
CHECK (
  "thumbnail_base_room_seq" IS NULL
  OR "thumbnail_base_room_seq" >= 0
);

ALTER TABLE "rooms"
ADD COLUMN "thumbnail_updated_at" INTEGER
CHECK (
  "thumbnail_updated_at" IS NULL
  OR "thumbnail_updated_at" >= 0
);

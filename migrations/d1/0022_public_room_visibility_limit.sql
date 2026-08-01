ALTER TABLE "service_capacity_limits"
ADD COLUMN "public_rooms_only" INTEGER NOT NULL DEFAULT 0
  CHECK ("public_rooms_only" IN (0, 1));

ALTER TABLE "service_capacity_limit_actions"
ADD COLUMN "public_rooms_only" INTEGER NOT NULL DEFAULT 0
  CHECK ("public_rooms_only" IN (0, 1));

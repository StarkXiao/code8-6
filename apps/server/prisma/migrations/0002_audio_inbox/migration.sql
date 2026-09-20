-- 语音收件箱：AudioAttachment.recipeId 改为可空。
--
-- 长辈极简端（/talk）按住说话直接上传，不选食谱，语音先落在家庭空间级
-- 的"语音收件箱"（recipeId 为 NULL）；整理者之后再把它归到具体食谱。
--
-- SQLite 不能 ALTER COLUMN 改空值约束，按 Prisma 的 RedefineTables 流程重建表。

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AudioAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "recipeId" TEXT,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "peaks" TEXT,
    "sha256" TEXT NOT NULL,
    "transcript" TEXT,
    "transcriptStatus" TEXT NOT NULL DEFAULT 'none',
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AudioAttachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AudioAttachment_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AudioAttachment_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_AudioAttachment" ("id", "workspaceId", "recipeId", "ownerId", "kind", "storagePath", "mimeType", "sizeBytes", "durationMs", "peaks", "sha256", "transcript", "transcriptStatus", "deletedAt", "createdAt")
    SELECT "id", "workspaceId", "recipeId", "ownerId", "kind", "storagePath", "mimeType", "sizeBytes", "durationMs", "peaks", "sha256", "transcript", "transcriptStatus", "deletedAt", "createdAt" FROM "AudioAttachment";
DROP TABLE "AudioAttachment";
ALTER TABLE "new_AudioAttachment" RENAME TO "AudioAttachment";
CREATE INDEX "AudioAttachment_recipeId_kind_idx" ON "AudioAttachment"("recipeId", "kind");
CREATE INDEX "AudioAttachment_recipeId_transcriptStatus_idx" ON "AudioAttachment"("recipeId", "transcriptStatus");
CREATE INDEX "AudioAttachment_workspaceId_recipeId_idx" ON "AudioAttachment"("workspaceId", "recipeId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

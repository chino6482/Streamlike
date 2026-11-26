-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "isLiveCapture" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "liveDurationMinutes" INTEGER,
ADD COLUMN     "liveStatus" TEXT;

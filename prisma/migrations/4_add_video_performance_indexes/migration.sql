-- CreateIndex
CREATE INDEX "Video_status_idx" ON "Video"("status");

-- CreateIndex
CREATE INDEX "Video_isLiveCapture_liveStatus_idx" ON "Video"("isLiveCapture", "liveStatus");

-- CreateIndex
CREATE INDEX "Video_createdAt_idx" ON "Video"("createdAt");

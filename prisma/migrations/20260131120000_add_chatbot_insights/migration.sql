-- CreateTable
CREATE TABLE "chatbot_insights" (
    "id" TEXT NOT NULL,
    "chatbot_id" TEXT NOT NULL,
    "range_days" INTEGER NOT NULL DEFAULT 30,
    "range_start" TIMESTAMP(3) NOT NULL,
    "range_end" TIMESTAMP(3) NOT NULL,
    "total_messages" INTEGER NOT NULL DEFAULT 0,
    "pricing_questions" INTEGER NOT NULL DEFAULT 0,
    "location_questions" INTEGER NOT NULL DEFAULT 0,
    "booking_count" INTEGER NOT NULL DEFAULT 0,
    "top_services" JSONB NOT NULL DEFAULT '[]',
    "not_provided_services" JSONB NOT NULL DEFAULT '[]',
    "couldnt_find_services" JSONB NOT NULL DEFAULT '[]',
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatbot_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chatbot_insights_chatbot_id_range_days_idx" ON "chatbot_insights"("chatbot_id", "range_days");

-- CreateIndex
CREATE INDEX "chatbot_insights_generated_at_idx" ON "chatbot_insights"("generated_at");

-- AddForeignKey
ALTER TABLE "chatbot_insights" ADD CONSTRAINT "chatbot_insights_chatbot_id_fkey" FOREIGN KEY ("chatbot_id") REFERENCES "chatbots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

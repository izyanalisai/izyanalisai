-- Section 4.2 spec v4.2: catatan evaluasi sesi 1 (09.00-12.00 WIB) untuk
-- mendeteksi setup awal/area entry potensial sesi 2 (13.30-15.30 WIB).
-- Hasil evaluasi ini BUKAN signal final dan TIDAK mempengaruhi lifecycle
-- tabel signals -- disimpan terpisah sebagai catatan intraday_evaluation.
-- Tabel ini dibuat langsung di database live pada 18 Agustus 2026, migration
-- ini menyusulkan ke version control agar repo tetap sinkron dengan skema live.

CREATE TABLE IF NOT EXISTS "public"."session2_setup_previews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "trade_date" "date" NOT NULL,
    "direction_bias" "text" NOT NULL,
    "price_at_check" numeric,
    "session1_high" numeric,
    "session1_low" numeric,
    "nearby_zone_id" "uuid",
    "distance_to_zone_pct" numeric,
    "note" "text",
    "formula_version" "text" DEFAULT 'session2_preview_v1'::"text" NOT NULL,
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "session2_setup_previews_direction_bias_check" CHECK (("direction_bias" = ANY (ARRAY['POTENTIAL_BUY'::"text", 'POTENTIAL_SELL'::"text", 'NONE'::"text"])))
);

ALTER TABLE "public"."session2_setup_previews" OWNER TO "postgres";

COMMENT ON TABLE "public"."session2_setup_previews" IS 'Section 4.2 spec v4.2: catatan evaluasi sesi 1 (bukan signal resmi, tidak mempengaruhi lifecycle tabel signals). Dibuat 18 Agustus 2026.';

ALTER TABLE ONLY "public"."session2_setup_previews"
    ADD CONSTRAINT "session2_setup_previews_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."session2_setup_previews"
    ADD CONSTRAINT "session2_setup_previews_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id");

ALTER TABLE ONLY "public"."session2_setup_previews"
    ADD CONSTRAINT "session2_setup_previews_nearby_zone_id_fkey" FOREIGN KEY ("nearby_zone_id") REFERENCES "public"."structure_zones"("id");

ALTER TABLE "public"."session2_setup_previews" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "session2_setup_previews readable by all" ON "public"."session2_setup_previews" FOR SELECT USING (true);

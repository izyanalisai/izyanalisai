-- Initial real-company ticker reference data (not simulated prices or signals).
-- Selected from the repository's archived IDX master. Other symbols remain
-- unlisted until actual provider-backed active listing validation is available.
INSERT INTO public.stocks(ticker,name)
VALUES
  ('BBCA', 'Bank Central Asia Tbk.'),
  ('BBRI', 'Bank Rakyat Indonesia (Persero'),
  ('BMRI', 'Bank Mandiri (Persero) Tbk.'),
  ('BBNI', 'Bank Negara Indonesia (Persero'),
  ('TLKM', 'Telkom Indonesia (Persero) Tbk'),
  ('ASII', 'Astra International Tbk.'),
  ('ANTM', 'Aneka Tambang Tbk.'),
  ('INDF', 'Indofood Sukses Makmur Tbk.'),
  ('ICBP', 'Indofood CBP Sukses Makmur Tbk'),
  ('PTBA', 'Bukit Asam Tbk.'),
  ('UNTR', 'United Tractors Tbk.'),
  ('CPIN', 'Charoen Pokphand Indonesia Tbk'),
  ('KLBF', 'Kalbe Farma Tbk.'),
  ('PGAS', 'Perusahaan Gas Negara Tbk.'),
  ('JSMR', 'Jasa Marga (Persero) Tbk.'),
  ('BRPT', 'Barito Pacific Tbk.'),
  ('AMRT', 'Sumber Alfaria Trijaya Tbk.'),
  ('CTRA', 'Ciputra Development Tbk.'),
  ('BSDE', 'Bumi Serpong Damai Tbk.'),
  ('TOWR', 'Sarana Menara Nusantara Tbk.'),
  ('ERAA', 'Erajaya Swasembada Tbk.'),
  ('ISAT', 'Indosat Tbk.'),
  ('MDKA', 'Merdeka Copper Gold Tbk.'),
  ('SMGR', 'Semen Indonesia (Persero) Tbk.'),
  ('UNVR', 'Unilever Indonesia Tbk.')
ON CONFLICT (ticker) DO NOTHING;

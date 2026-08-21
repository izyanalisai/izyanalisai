CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
  bucket_key text NOT NULL,
  window_start timestamptz NOT NULL,
  hit_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket_key, window_start)
);

COMMENT ON TABLE public.rate_limit_hits IS
  'Fixed-window rate limiter. bucket_key = "<scope>:<identity>:<window_start_epoch>".';

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_scope text,
  p_identity text,
  p_max_hits integer,
  p_window_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start timestamptz;
  v_key text;
  v_count integer;
BEGIN
  v_window_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  v_key := p_scope || ':' || coalesce(p_identity, 'anon');

  INSERT INTO public.rate_limit_hits (bucket_key, window_start, hit_count)
  VALUES (v_key, v_window_start, 1)
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET hit_count = rate_limit_hits.hit_count + 1
  RETURNING hit_count INTO v_count;

  RETURN v_count <= p_max_hits;
END;
$$;

COMMENT ON FUNCTION public.check_rate_limit IS
  'Return true kalau masih di bawah limit, false kalau kelebihan.';

CREATE OR REPLACE FUNCTION public.cleanup_rate_limit_hits()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.rate_limit_hits WHERE window_start < now() - interval '1 day';
$$;

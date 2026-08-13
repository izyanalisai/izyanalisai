-- Fix bug: frontend (app/ai-task/page.tsx) sudah nunggu error
-- AI_TASK_LIMIT_REACHED & AI_TASK_TYPE_REQUIRES_PREMIUM tapi trigger-nya
-- belum pernah dibuat. Tanpa ini, user Free bisa bikin AI Task tanpa
-- batas dan akses jenis tugas yang harusnya Premium-only (poin 5.14 & 7.2).

CREATE OR REPLACE FUNCTION public.enforce_ai_task_limits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_is_premium boolean;
  v_max_tasks int;
  v_active_count int;
BEGIN
  SELECT is_premium INTO v_is_premium FROM public.profiles WHERE id = NEW.user_id;
  v_is_premium := COALESCE(v_is_premium, false);

  IF NOT v_is_premium AND NEW.task_type IN ('LEVEL_RETEST', 'UNUSUAL_VOLUME') THEN
    RAISE EXCEPTION 'AI_TASK_TYPE_REQUIRES_PREMIUM';
  END IF;

  v_max_tasks := CASE WHEN v_is_premium THEN 20 ELSE 3 END;

  IF NEW.is_active THEN
    SELECT count(*) INTO v_active_count
    FROM public.ai_tasks
    WHERE user_id = NEW.user_id AND is_active = true;

    IF v_active_count >= v_max_tasks THEN
      RAISE EXCEPTION 'AI_TASK_LIMIT_REACHED';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_tasks_enforce_limits ON public.ai_tasks;
CREATE TRIGGER ai_tasks_enforce_limits
  BEFORE INSERT ON public.ai_tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ai_task_limits();

-- Juga cegah update yang meng-aktifkan kembali task sampai tembus limit
CREATE OR REPLACE FUNCTION public.enforce_ai_task_limits_on_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_is_premium boolean;
  v_max_tasks int;
  v_active_count int;
BEGIN
  IF NEW.is_active = true AND OLD.is_active = false THEN
    SELECT is_premium INTO v_is_premium FROM public.profiles WHERE id = NEW.user_id;
    v_is_premium := COALESCE(v_is_premium, false);
    v_max_tasks := CASE WHEN v_is_premium THEN 20 ELSE 3 END;

    SELECT count(*) INTO v_active_count
    FROM public.ai_tasks
    WHERE user_id = NEW.user_id AND is_active = true AND id != NEW.id;

    IF v_active_count >= v_max_tasks THEN
      RAISE EXCEPTION 'AI_TASK_LIMIT_REACHED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_tasks_enforce_limits_update ON public.ai_tasks;
CREATE TRIGGER ai_tasks_enforce_limits_update
  BEFORE UPDATE ON public.ai_tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ai_task_limits_on_update();

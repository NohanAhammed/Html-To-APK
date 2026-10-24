
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: cors });

  if (req.method !== "POST")
    return reply({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!secret)
    return reply({ error: "Server is not configured" }, 503);

  const token = (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "");

  if (!token) return reply({ error: "Sign in first" }, 401);

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data.user)
    return reply({ error: "Invalid session" }, 401);

  let body: { jobId?: string };

  try {
    body = await req.json();
  } catch {
    return reply({ error: "Invalid request" }, 400);
  }

  if (
    typeof body.jobId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(body.jobId)
  ) {
    return reply({ error: "Invalid build ID" }, 400);
  }

  const admin = createClient(url, secret, {
    auth: { persistSession: false },
  });

  const { data: job, error: jobError } = await admin
    .from("apk_build_jobs")
    .select("id, app_name, status, error_message, created_at, apk_path")
    .eq("id", body.jobId)
    .eq("user_id", data.user.id)
    .maybeSingle();

  if (jobError)
    return reply({ error: "Could not check build status" }, 500);

  if (!job)
    return reply({ error: "Build not found" }, 404);

  let downloadUrl: string | null = null;

  if (job.status === "complete" && job.apk_path) {
    const { data: signed, error: signedError } = await admin.storage
      .from("apk-builds")
      .createSignedUrl(job.apk_path, 300);

    if (!signedError) downloadUrl = signed.signedUrl;
  }

  return reply({
    jobId: job.id,
    appName: job.app_name,
    status: job.status,
    error: job.error_message,
    createdAt: job.created_at,
    downloadUrl,
  });
});

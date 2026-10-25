import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function safeFilename(appName: string, version: string) {
  const name =
    appName.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "MyApp";

  const ver = version.replace(/[^A-Za-z0-9._-]+/g, "-");

  return `${name}-v${ver}.apk`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reply({ error: "Method not allowed. Use POST." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return reply(
        { error: "Server environment is not configured." },
        500
      );
    }

    const authHeader = req.headers.get("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return reply({ error: "Please sign in first." }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser();

    if (authError || !user) {
      return reply(
        { error: "Invalid or expired login session." },
        401
      );
    }

    let body: { jobId?: string };

    try {
      body = await req.json();
    } catch {
      return reply(
        { error: "Request body must be valid JSON." },
        400
      );
    }

    const jobId = body.jobId;

    if (
      typeof jobId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        jobId
      )
    ) {
      return reply({ error: "A valid jobId is required." }, 400);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: job, error: jobError } = await admin
      .from("apk_build_jobs")
      .select(
        "id, user_id, status, error_message, apk_path, app_name, version"
      )
      .eq("id", jobId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (jobError) {
      console.error("Job lookup failed:", jobError.message);
      return reply({ error: "Could not check build status." }, 500);
    }

    if (!job) {
      return reply({ error: "Build job not found." }, 404);
    }

    let downloadUrl: string | null = null;
    let downloadFilename: string | null = null;

    if (job.status === "complete" && job.apk_path) {
      downloadFilename = safeFilename(
        job.app_name || "MyApp",
        job.version || "1.0.0"
      );

      const { data: signed, error: signedError } =
        await admin.storage
          .from("apk-builds")
          .createSignedUrl(job.apk_path, 3600, {
            download: downloadFilename,
          });

      if (signedError || !signed?.signedUrl) {
        console.error(
          "Signed URL failed:",
          signedError?.message || "No signed URL returned"
        );

        return reply({
          jobId: job.id,
          status: job.status,
          appName: job.app_name,
          version: job.version,
          downloadUrl: null,
          error:
            "APK is ready, but its download link could not be created.",
        });
      }

      downloadUrl = signed.signedUrl;
    }

    return reply({
      jobId: job.id,
      status: job.status,
      appName: job.app_name,
      version: job.version,
      error: job.error_message ?? null,
      downloadUrl,
      downloadFilename,
    });
  } catch (error) {
    console.error("Unexpected build-status error:", error);

    return reply(
      { error: "An unexpected server error occurred." },
      500
    );
  }
});

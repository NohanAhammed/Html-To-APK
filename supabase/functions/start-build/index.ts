
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  let form: FormData;

  try {
    form = await req.formData();
  } catch {
    return reply({ error: "Expected form data" }, 400);
  }

  const html = form.get("htmlFile");
  const logo = form.get("logoFile");

  let config: Record<string, unknown>;

  try {
    config = JSON.parse(String(form.get("config") ?? "{}"));
  } catch {
    return reply({ error: "Invalid app settings" }, 400);
  }

  if (
    !(html instanceof File) ||
    !/\.(html|htm)$/i.test(html.name) ||
    html.size < 1 ||
    html.size > 20 * 1024 * 1024
  ) {
    return reply({ error: "Choose an HTML file under 20 MB" }, 400);
  }

  if (
    logo &&
    (!(logo instanceof File) ||
      !logo.name.toLowerCase().endsWith(".png") ||
      logo.size > 5 * 1024 * 1024)
  ) {
    return reply({ error: "Logo must be PNG under 5 MB" }, 400);
  }

  const appName = String(config.appName ?? "").trim();
  const version = String(config.version ?? "1.0.0");
  const packageId = String(config.packageId ?? "");

  if (
    !appName ||
    appName.length > 40 ||
    !/^[0-9]+(\.[0-9]+){0,3}$/.test(version) ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageId)
  ) {
    return reply({ error: "Check app name, version, and package ID" }, 400);
  }

  const admin = createClient(url, secret, {
    auth: { persistSession: false },
  });

  const id = crypto.randomUUID();
  const uid = data.user.id;
  const htmlPath = `inputs/${uid}/${id}/index.html`;
  const logoPath =
    logo instanceof File ? `inputs/${uid}/${id}/logo.png` : null;

  const storage = admin.storage.from("apk-builds");

  let upload = await storage.upload(
    htmlPath,
    new Uint8Array(await html.arrayBuffer()),
    { contentType: "text/html" }
  );

  if (upload.error)
    return reply({ error: "HTML upload failed" }, 500);

  if (logo instanceof File && logoPath) {
    upload = await storage.upload(
      logoPath,
      new Uint8Array(await logo.arrayBuffer()),
      { contentType: "image/png" }
    );

    if (upload.error)
      return reply({ error: "Logo upload failed" }, 500);
  }

  const { error: insertError } = await admin
    .from("apk_build_jobs")
    .insert({
      id,
      user_id: uid,
      app_name: appName,
      publisher: String(config.publisher ?? ""),
      version,
      package_id: packageId,
      fullscreen: config.fullscreen === true,
      allow_screenshots: config.screenshots !== false,
      allow_internet: config.internet !== false,
      html_path: htmlPath,
      logo_path: logoPath,
    });

  if (insertError)
    return reply({ error: "Could not create build job" }, 500);

  const githubToken = Deno.env.get("GITHUB_TOKEN");
  const repository = Deno.env.get("GITHUB_REPOSITORY");

  if (!githubToken || !repository || !/^[^/]+\/[^/]+$/.test(repository))
    return reply({ error: "GitHub build service is not configured" }, 503);

  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/apk-build.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "html-apk-converter",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { job_id: id },
      }),
    }
  );

  if (!response.ok) {
    await admin
      .from("apk_build_jobs")
      .update({
        status: "failed",
        error_message: `GitHub dispatch failed (${response.status})`,
      })
      .eq("id", id);

    return reply({ error: "GitHub could not start the build" }, 502);
  }

  return reply({ jobId: id, status: "queued" }, 202);
});

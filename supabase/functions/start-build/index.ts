import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function out(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return out({ error: "Method not allowed." }, 405);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const publicKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !publicKey || !serviceKey) {
    return out({ error: "Server configuration is incomplete." }, 503);
  }

  // Verify the user's session.
  const token = (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "");

  if (!token) {
    return out({ error: "Sign in first." }, 401);
  }

  const userClient = createClient(url, publicKey, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
    auth: { persistSession: false },
  });

  const { data: authData, error: authError } =
    await userClient.auth.getUser(token);

  if (authError || !authData.user) {
    return out({ error: "Invalid session." }, 401);
  }

  // Read the uploaded files.
  let form: FormData;

  try {
    form = await req.formData();
  } catch {
    return out({ error: "Expected multipart form data." }, 400);
  }

  const html = form.get("htmlFile");
  const zip = form.get("zipFile");
  const logo = form.get("logoFile");

  // Require exactly one website file.
  if ((html instanceof File) === (zip instanceof File)) {
    return out({
      error: "Choose exactly one HTML file or website ZIP.",
    }, 400);
  }

  if (
    html instanceof File &&
    (!/\.(html|htm)$/i.test(html.name) ||
      html.size < 1 ||
      html.size > 20 * 1024 * 1024)
  ) {
    return out({
      error: "HTML must be under 20 MB.",
    }, 400);
  }

  if (
    zip instanceof File &&
    (!/\.zip$/i.test(zip.name) ||
      zip.size < 1 ||
      zip.size > 50 * 1024 * 1024)
  ) {
    return out({
      error: "Website ZIP must be under 50 MB.",
    }, 400);
  }

  if (
    logo !== null &&
    (!(logo instanceof File) ||
      (!/\.png$/i.test(logo.name) && logo.type !== "image/png") ||
      logo.size > 5 * 1024 * 1024)
  ) {
    return out({
      error: "App icon must be a PNG under 5 MB.",
    }, 400);
  }

  // Validate the app settings.
  let config: Record<string, unknown>;

  try {
    config = JSON.parse(String(form.get("config") ?? "{}"));
  } catch {
    return out({ error: "Invalid app settings." }, 400);
  }

  const appName = String(config.appName ?? "").trim();
  const publisher = String(config.publisher ?? "").trim().slice(0, 80);
  const version = String(config.version ?? "1.0.0").trim();
  const packageId = String(config.packageId ?? "").trim();

  if (
    !appName ||
    appName.length > 40 ||
    !/^[0-9]+(\.[0-9]+){0,3}$/.test(version) ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageId)
  ) {
    return out({
      error: "Check app name, version, and package ID.",
    }, 400);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  const jobId = crypto.randomUUID();
  const root =
    `inputs/${authData.user.id}/${crypto.randomUUID()}`;

  const htmlPath =
    html instanceof File ? `${root}/index.html` : null;

  const zipPath =
    zip instanceof File ? `${root}/website.zip` : null;

  const logoPath =
    logo instanceof File ? `${root}/logo.png` : null;

  const uploaded: string[] = [];

  // Upload the selected files to private Supabase Storage.
  try {
    if (html instanceof File && htmlPath) {
      const result = await admin.storage
        .from("apk-builds")
        .upload(
          htmlPath,
          new Uint8Array(await html.arrayBuffer()),
          { contentType: "text/html" },
        );

      if (result.error) throw result.error;
      uploaded.push(htmlPath);
    }

    if (zip instanceof File && zipPath) {
      const result = await admin.storage
        .from("apk-builds")
        .upload(
          zipPath,
          new Uint8Array(await zip.arrayBuffer()),
          { contentType: "application/zip" },
        );

      if (result.error) throw result.error;
      uploaded.push(zipPath);
    }

    if (logo instanceof File && logoPath) {
      const result = await admin.storage
        .from("apk-builds")
        .upload(
          logoPath,
          new Uint8Array(await logo.arrayBuffer()),
          { contentType: "image/png" },
        );

      if (result.error) throw result.error;
      uploaded.push(logoPath);
    }
  } catch (error) {
    if (uploaded.length) {
      await admin.storage.from("apk-builds").remove(uploaded);
    }

    return out({
      error: `Upload failed: ${
        error instanceof Error ? error.message : "Storage error"
      }`,
    }, 500);
  }

  // Create the build job.
  const { error: insertError } = await admin
    .from("apk_build_jobs")
    .insert({
      id: jobId,
      user_id: authData.user.id,
      app_name: appName,
      publisher,
      version,
      package_id: packageId,
      fullscreen: config.fullscreen === true,
      allow_screenshots: config.allowScreenshots !== false,
      allow_internet: config.allowInternet !== false,
      html_path: htmlPath,
      website_zip_path: zipPath,
      logo_path: logoPath,
      status: "queued",
    });

  if (insertError) {
    if (uploaded.length) {
      await admin.storage.from("apk-builds").remove(uploaded);
    }

    console.error("Build job insert failed:", insertError.message);

    return out({
      error: "Could not create build job. Check the database schema.",
    }, 500);
  }

  // Trigger the GitHub Actions APK build.
  const githubToken = Deno.env.get("GITHUB_TOKEN");
  const repository = Deno.env.get("GITHUB_REPOSITORY");

  if (
    !githubToken ||
    !repository ||
    !/^[^/]+\/[^/]+$/.test(repository)
  ) {
    await admin
      .from("apk_build_jobs")
      .update({
        status: "failed",
        error_message: "GitHub build service is not configured.",
      })
      .eq("id", jobId);

    return out({
      error: "GitHub build service is not configured.",
    }, 503);
  }

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
        inputs: { job_id: jobId },
      }),
    },
  );

  if (!response.ok) {
    await admin
      .from("apk_build_jobs")
      .update({
        status: "failed",
        error_message: `GitHub dispatch failed (${response.status}).`,
      })
      .eq("id", jobId);

    return out({
      error: `GitHub dispatch failed (${response.status}). Check your GitHub token and repository settings.`,
    }, 502);
  }

  return out({
    jobId,
    status: "queued",
  }, 202);
});
